/**
 * 原生数据包导出器 —— 从实例的 `POST /api/users/backup` 流式落盘到下载文件夹
 *
 * 为什么不用浏览器下载管线：探针（`research/backup-channel-probe.md`）实测该端点
 * **`transfer-encoding: chunked`、没有 `content-length`**，且真源包 3.8 G ——
 * 走浏览器内存或 Playwright `download` 事件都不稳。故：
 *   浏览器只用来**取会话**（cookie + `/csrf-token`），字节由 **Node 侧 https 流式**接收直写磁盘。
 *
 * 用法：
 *   node scripts/instance-sync/export-backups.cjs --id real-luker
 *   node scripts/instance-sync/export-backups.cjs --id real-luker --out "D:\\somewhere"
 *
 * 纪律：
 *  - 对实例**只读**（只调 `backup` 这一读端点），全程不写 `Instance/**`（I-1 / I-5）。
 *  - 产物落 Downloads（用户指定），并附同名 `.json` 记录（`implement.md` 1.5 的 AC-1 证据形态）。
 */

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const { getInstance } = require('../../e2e/lib/instances.cjs');
const { acquireSession } = require('./lib/instance-session.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const out = { id: '', handle: 'default-user', out: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--id') out.id = argv[++i] || '';
    else if (argv[i] === '--handle') out.handle = argv[++i] || 'default-user';
    else if (argv[i] === '--out') out.out = argv[++i] || '';
  }
  return out;
}

const mb = (n) => (n / 1048576).toFixed(1);

/** 流式 POST 到 /api/users/backup，边收边写盘；返回落点与读数 */
function streamBackup(inst, session, destPath) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ handle: session.handle });
    const req = https.request({
      hostname: '127.0.0.1',
      port: inst.port,
      path: '/api/users/backup',
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-CSRF-Token': session.csrf,
        Cookie: session.cookieHeader,
        Accept: '*/*',
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        let err = '';
        res.on('data', (c) => { err += c.toString('utf8'); });
        res.on('end', () => reject(new Error(
          `备份端点返回 ${res.statusCode}：${err.slice(0, 400) || '(空响应体)'}`)));
        return;
      }
      const disposition = String(res.headers['content-disposition'] || '');
      const serverName = (disposition.match(/filename="?([^";]+)"?/) || [, ''])[1];

      const out = fs.createWriteStream(destPath);
      let received = 0;
      let lastLog = Date.now();
      res.on('data', (chunk) => {
        received += chunk.length;
        if (Date.now() - lastLog > 5000) {
          lastLog = Date.now();
          process.stdout.write(`\r  已接收 ${mb(received)} MB …        `);
        }
      });
      res.pipe(out);
      out.on('error', reject);
      out.on('finish', () => {
        process.stdout.write(`\r  已接收 ${mb(received)} MB（完成）        \n`);
        resolve({ bytes: received, serverName, contentType: res.headers['content-type'] || '' });
      });
    });
    req.on('error', reject);
    req.setTimeout(0); // 3.8 G 级传输不设空闲超时；中断由对端/进程负责
    req.end(body);
  });
}

/** 流式算 sha256（不把包读进内存） */
function sha256Of(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

(async () => {
  const { id, handle, out } = parseArgs(process.argv.slice(2));
  if (!id) {
    console.error('用法：node scripts/instance-sync/export-backups.cjs --id <instance>');
    process.exit(2);
  }
  const inst = getInstance(id);
  const outDir = out ? path.resolve(out) : path.join(os.homedir(), 'Downloads');
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[${id}] 取会话（档案 ${path.basename(inst.profile)}）…`);
  const session = await acquireSession(inst);
  session.handle = handle;
  console.log(`[${id}] 会话就绪：${session.cookieCount} 个 cookie，CSRF 已取，Playwright ${session.playwright}`);

  // 先落临时名，成功后再改名 —— 中断不会留下半截「看着像完整包」的文件
  const tmpPath = path.join(outDir, `backup-${id}.partial`);
  console.log(`[${id}] 开始流式导出 → ${tmpPath}`);
  const t0 = Date.now();
  const { bytes, serverName, contentType } = await streamBackup(inst, session, tmpPath);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const stamp = (serverName.match(/(\d{8}-\d{6})/) || [, new Date().toISOString()
    .slice(0, 19).replace(/[-:T]/g, '').replace(/(\d{8})(\d{6})/, '$1-$2')])[1];
  const finalName = `backup-${id}-${stamp}.zip`;
  const finalPath = path.join(outDir, finalName);
  fs.renameSync(tmpPath, finalPath);

  console.log(`[${id}] 校验：sha256 + 条目数 …`);
  const [sha256, entryCount] = await Promise.all([
    sha256Of(finalPath),
    (async () => {
      const { createNodeIo } = require('./lib/node-zip-io.cjs');
      const io = await createNodeIo();
      const reader = await io.openReader(finalPath);
      const n = reader.totalEntries;
      await reader.close();
      return n;
    })(),
  ]);

  const record = {
    instance: id,
    port: inst.port,
    url: inst.url,
    handle,
    sourceDir: path.join(inst.dir, inst.userDir || ''),
    serverProvidedName: serverName,
    file: finalName,
    bytes,
    entryCount,
    sha256,
    contentType,
    exportedAt: new Date().toISOString(),
    elapsedSeconds: Number(secs),
    playwright: session.playwright,
  };
  const recordPath = path.join(outDir, `backup-${id}-${stamp}.json`);
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2), 'utf8');

  console.log(`[${id}] 完成：${finalName}`);
  console.log(`       ${mb(bytes)} MB / ${entryCount} 条目 / 耗时 ${secs}s`);
  console.log(`       sha256 ${sha256}`);
  console.log(`       记录 ${recordPath}`);
})().catch((e) => {
  console.error('导出失败：', e.message);
  process.exit(1);
});
