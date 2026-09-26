/**
 * Luker 原生整包恢复器 —— 把产出的 Luker 布局包喂给 `POST /api/users/restore-backup`
 *
 * 通道依据（读自实例仓源码，`Instance/Real/Luker/src/endpoints/users-private.js`）：
 *   - `:1237` `POST /restore-backup`：multipart，字段 `handle` / `mode` / `selection` / `file`；
 *     `mode` **默认 `merge`**，其语义正是用户裁定的「覆盖同名、不删独有」（U-3）。
 *   - `:1197` `POST /restore-backup/probe`：同样要上传整个包，返回
 *     `{engineKind, schemaVersion, sourceHandle, crossModeRequired, scratchCredsNeeded}`
 *     —— **跨引擎模式**（源包引擎 ≠ 当前引擎）才需要 scratch 凭据；probe 自身会清掉临时文件。
 *   - `sanitizeBackupSelectionForUser`（`:86`）对**非 admin** 用户强制 `globalExtensions=false`，
 *     故本脚本会把「实际请求的 selection」与「若被降级的风险」一并打印。
 *
 * 为什么不用 Playwright 上传：包有 600 MB 级，浏览器上传要把字节先读进浏览器内存。
 * 这里的做法与导出侧对称 —— **浏览器只取会话**（cookie + CSRF），字节由 Node 侧流式发出。
 *
 * 用法：
 *   node scripts/instance-sync/restore-luker.cjs --id dev-luker            # 默认取最新 pack-luker-*.zip
 *   node scripts/instance-sync/restore-luker.cjs --id dev-luker --pack <zip>
 *   node scripts/instance-sync/restore-luker.cjs --id dev-luker --probe-only
 *   node scripts/instance-sync/restore-luker.cjs --id dev-luker --skip-probe
 *
 * ⚠️ 本脚本**会写入实例数据**（这是同步的目的）。执行前请确认：
 *   ① 实例登记端口正确（`e2e/lib/instances.cjs`，Real 与 Dev 只差一个端口号）；
 *   ② 目标实例已有同步前的只读清单快照（`snapshot-manifest.cjs` 产出），事后才报得出改动了哪些路径。
 */

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { getInstance } = require('../../e2e/lib/instances.cjs');
const { acquireSession } = require('./lib/instance-session.cjs');

const MB = (n) => (n / 1048576).toFixed(1);

/**
 * 默认全类目。键名取自 Luker 的权威默认值
 * （`Instance/Real/Luker/src/users.js:83` `USER_BACKUP_SELECTION_DEFAULTS`）。
 *
 * ⚠️ 注意该默认值里 **`globalExtensions` 与 `vectors` 是 `false`** —— 这里显式置 `true`，
 * 因为我们的包内**含** `extensions/third-party/`（全局扩展）。`vectors` 置 `true` 无害
 * （源包本就没有该派生目录，`convert()` 的目标设计会丢弃它）。
 */
const DEFAULT_SELECTION = Object.freeze({
  settings: true,
  secrets: true,
  characters: true,
  chats: true,
  lorebooks: true,
  presets: true,
  assets: true,
  extensions: true,
  globalExtensions: true,
  vectors: true,
});

function parseArgs(argv) {
  const out = {
    id: 'dev-luker', pack: '', handle: 'default-user', mode: 'merge',
    probeOnly: false, skipProbe: false, selection: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--id') out.id = argv[++i] || '';
    else if (argv[i] === '--pack') out.pack = argv[++i] || '';
    else if (argv[i] === '--handle') out.handle = argv[++i] || '';
    else if (argv[i] === '--mode') out.mode = argv[++i] || '';
    else if (argv[i] === '--selection') out.selection = argv[++i] || '';
    else if (argv[i] === '--probe-only') out.probeOnly = true;
    else if (argv[i] === '--skip-probe') out.skipProbe = true;
  }
  return out;
}

/** 取 Downloads 里最新的 Luker 布局产包 */
function findLatestPack(downloadsDir) {
  const names = fs.readdirSync(downloadsDir).filter((n) => /^pack-luker-.*\.zip$/.test(n));
  if (!names.length) throw new Error(`在 ${downloadsDir} 未找到 pack-luker-*.zip（先跑 build-packs.cjs）`);
  names.sort();
  return path.join(downloadsDir, names[names.length - 1]);
}

/**
 * 流式 multipart POST：头尾是小 Buffer，文件体走 `fs.createReadStream` 直入连接，
 * **整包不进内存**。`Content-Length` 精确算好（multer 对 chunked 的兼容性不做假设）。
 *
 * @returns {Promise<{status:number, body:string, bytesSent:number}>}
 */
function postMultipart(inst, session, { pathName, fields, filePath, onProgress }) {
  return new Promise((resolve, reject) => {
    const boundary = `----stzip${crypto.randomBytes(12).toString('hex')}`;
    const fileName = path.basename(filePath);
    const fileSize = fs.statSync(filePath).size;

    const headParts = Object.entries(fields).map(([k, v]) => Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
    ));
    const head = Buffer.concat([
      ...headParts,
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file";`
        + ` filename="${fileName}"\r\nContent-Type: application/zip\r\n\r\n`,
      ),
    ]);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const contentLength = head.length + fileSize + tail.length;

    const req = https.request({
      hostname: '127.0.0.1',
      port: inst.port,
      path: pathName,
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': contentLength,
        'X-CSRF-Token': session.csrf,
        Cookie: session.cookieHeader,
        Accept: 'application/json',
      },
    }, (res) => {
      // 只留前 256 KB：正常响应是 JSON；若服务端返回事件流也不会把内存吃光
      const chunks = [];
      let kept = 0;
      res.on('data', (c) => {
        if (kept < 262144) { chunks.push(c); kept += c.length; }
      });
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
        bytesSent: contentLength,
      }));
    });

    req.on('error', reject);

    let sent = head.length;
    const rs = fs.createReadStream(filePath);
    rs.on('error', (e) => { req.destroy(); reject(e); });
    rs.on('data', (c) => {
      sent += c.length;
      if (onProgress) onProgress(sent, contentLength);
    });
    rs.on('end', () => req.end(tail));
    req.write(head);
    rs.pipe(req, { end: false });
  });
}

/** 简洁的节流进度输出（避免每 chunk 一行刷屏） */
function makeProgress(label) {
  let last = 0;
  return (sent, total) => {
    const now = Date.now();
    if (now - last < 2000 && sent < total) return;
    last = now;
    process.stdout.write(`\r  ${label} 上传 ${MB(sent)} / ${MB(total)} MB（${((sent / total) * 100).toFixed(0)}%）`);
  };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const inst = getInstance(args.id);
  if (!inst) throw new Error(`未知实例 id：${args.id}`);
  if (inst.port === 8000) throw new Error('禁止 8000 出厂默认段（L0-16）');

  const downloads = path.join(os.homedir(), 'Downloads');
  const packPath = args.pack ? path.resolve(args.pack) : findLatestPack(downloads);
  if (!fs.existsSync(packPath)) throw new Error(`包不存在：${packPath}`);
  const packSize = fs.statSync(packPath).size;

  const selection = args.selection ? JSON.parse(args.selection) : { ...DEFAULT_SELECTION };
  const fields = {
    handle: args.handle,
    mode: args.mode,
    selection: JSON.stringify(selection),
  };

  console.log(`实例：${inst.id}（:${inst.port} ${inst.url}）`);
  console.log(`包：${path.basename(packPath)}（${MB(packSize)} MB）`);
  console.log(`mode=${args.mode}  handle=${args.handle}`);
  console.log(`selection=${JSON.stringify(selection)}`);
  if (args.mode !== 'merge') {
    console.log('⚠️ mode 非 merge —— U-3 要求「覆盖同名、不删独有」，overwrite 会删目标独有内容');
  }

  const session = await acquireSession(inst);
  console.log(`会话就绪：cookie ${session.cookieCount} 个、CSRF 已取（playwright ${session.playwright}）\n`);

  // —— 预检：probe 也要上传整个包，但它会报告引擎模式是否兼容 ——
  if (!args.skipProbe) {
    console.log('[probe] 上传包做引擎模式预检…');
    const r = await postMultipart(inst, session, {
      pathName: '/api/users/restore-backup/probe', fields: { handle: args.handle, mode: args.mode },
      filePath: packPath, onProgress: makeProgress('[probe]'),
    });
    process.stdout.write('\n');
    if (r.status !== 200) {
      console.error(`❌ probe 失败 HTTP ${r.status}：${r.body.slice(0, 800)}`);
      process.exit(1);
    }
    let meta = null;
    try { meta = JSON.parse(r.body); } catch { /* 非 JSON */ }
    console.log(`[probe] ${JSON.stringify(meta)}`);
    if (meta) {
      if (meta.scratchCredsNeeded) {
        console.error(`❌ 源包引擎为 ${meta.scratchCredsNeeded}，与当前引擎不同，需要 scratch 凭据 —— 本脚本不带凭据，中止（避免半途失败留下不一致状态）`);
        process.exit(2);
      }
      if (meta.crossModeRequired) {
        console.error('❌ 预检报告 crossModeRequired=true，本脚本不支持跨引擎模式恢复，中止');
        process.exit(2);
      }
      console.log('[probe] ✅ 引擎模式兼容，可继续');
    }
    if (args.probeOnly) {
      console.log('[probe-only] 按参数结束（未执行恢复）');
      return;
    }
  }

  // —— 恢复 ——
  console.log('\n[restore] 上传并恢复…');
  const res = await postMultipart(inst, session, {
    pathName: '/api/users/restore-backup', fields, filePath: packPath, onProgress: makeProgress('[restore]'),
  });
  process.stdout.write('\n');

  console.log(`[restore] HTTP ${res.status}`);
  console.log(`[restore] 响应：${res.body.slice(0, 2000)}`);
  if (res.status !== 200) {
    console.error('❌ 恢复失败（详见上方响应体）');
    process.exit(1);
  }
  console.log('\n✅ 恢复请求已被接受。下一步用 diff-report.cjs 做覆盖率与「独有零删除」核对：');
  console.log(`   node scripts/instance-sync/diff-report.cjs --pack "${packPath}" --target ${inst.id}`);
})().catch((e) => {
  console.error('\n恢复器异常：', e && e.message ? e.message : e);
  process.exit(1);
});
