/**
 * ST（SillyTavern）逐类目导入器 —— ST **没有整包恢复端点**，只能按类目喂
 *
 * 通道依据（读自实例仓源码，`Instance/<side>/SillyTavern/src/…`）：
 *   - `server-main.js:269` 全局 multer 是 **`.single('avatar')`** ⇒ **文件字段名必须是 `avatar`**
 *     （Luker 同一个坑：用 `file` 会得到 MulterError → 无信息的 HTTP 500）。
 *   - `characters.js:1560`  `POST /api/characters/import`  字段：`file_type` / `preserved_name`
 *   - `chats.js:771`        `POST /api/chats/import`       字段：`file_type` / `avatar_url` /
 *                                                          `character_name` / `user_name`（带 validateAvatarUrlMiddleware）
 *   - `worldinfo.js:99`     `POST /api/worldinfo/import`   字段：`convertedData`（可选）
 *   - `backgrounds.js:135`  `POST /api/backgrounds/upload` 文件名取自 `originalname`
 *   - `avatars.js:41`       `POST /api/avatars/upload`     字段：`overwrite_name`
 *   - `settings.js:206`     `POST /api/settings/save`      **整份替换**语义
 *
 * **不可达类目（本脚本如实登记，不假装同步）**：ST 的**预设/主题类**没有导入端点 ——
 * `OpenAI Settings/`、`NovelAI Settings/`、`KoboldAI Settings/`、`TextGen Settings/`、
 * `instruct/`、`context/`、`sysprompt/`、`reasoning/`、`QuickReplies/`、`movingUI/`、`themes/`。
 * 另 `chats/**\/*.luker-state.*` 是 Luker 私有状态、`secrets.json` 需专用格式，均不投递。
 * ⇒ **AC-2 的「源覆盖率 100%」在 ST 目标上不可达**（已在 `prd.md` 残留 R-2 登记），
 *   覆盖率必须**按可达类目折算**。
 *
 * **顺序强制**：`chats/import` 依赖角色已存在（`chats.js:771` 的 `avatar_url` 用于定位目录）
 * ⇒ **必须先 characters，后 chats**。
 *
 * **settings 特殊**：`settings/save` 是整份替换，直接写会丢掉目标实例的自定义项
 * ⇒ 本脚本**先 GET 目标 settings → 合并（包内键覆盖）→ 再 save**。
 *
 * 用法：
 *   node scripts/instance-sync/import-st.cjs --id dev-st --dry-run     # 只列计划，不写入
 *   node scripts/instance-sync/import-st.cjs --id dev-st               # 真跑
 *
 * ⚠️ 本脚本**会写入实例数据**。执行前确认端口（Dev/Real 只差一个号）并已有同步前快照。
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { getInstance } = require('../../e2e/lib/instances.cjs');
const { acquireSession } = require('./lib/instance-session.cjs');
const { deriveStCharacterUpload, isCharacterSubpath } = require('./lib/luker-card-adapter.cjs');
const { findLinkedRoots, isUnderLink } = require('./lib/link-guard.cjs');

const MB = (n) => (n / 1048576).toFixed(1);
const BATCH_ORDER = ['characters', 'chats', 'worlds', 'backgrounds', 'User Avatars'];

/** 无导入端点的类目（如实登记，不投递） */
const UNREACHABLE_PREFIXES = [
  'OpenAI Settings/', 'NovelAI Settings/', 'KoboldAI Settings/', 'TextGen Settings/',
  'instruct/', 'context/', 'sysprompt/', 'reasoning/', 'QuickReplies/', 'movingUI/',
  'themes/', 'secrets.json',
];

function parseArgs(argv) {
  const out = {
    id: 'dev-st', pack: '', handle: 'default-user', dryRun: false, only: '', rawWrite: false,
    allVersions: false, allowLinks: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--id') out.id = argv[++i] || '';
    else if (argv[i] === '--pack') out.pack = argv[++i] || '';
    else if (argv[i] === '--handle') out.handle = argv[++i] || '';
    else if (argv[i] === '--only') out.only = argv[++i] || '';
    else if (argv[i] === '--raw-write') out.rawWrite = true;
    else if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--all-versions') out.allVersions = true;
    else if (argv[i] === '--allow-links') out.allowLinks = true;
  }
  return out;
}

/**
 * **需要裸落盘的类目 → 目标目录**（相对实例根）。
 *
 * 为什么必须裸落盘：ST **没有这些类目的导入端点** ——
 *   - `extensions/`：ST 的扩展从来就只能靠磁盘目录（Git 克隆或手工放），没有 upload 路由；
 *   - `user/`：用户级数据同样无端点。
 * 它们的**原生安装形态就是文件落盘**，因此这不是「用裸拷贝凑数」，
 * 而是这两个类目在 ST 上**唯一的形态**。
 *
 * ⚠️ 但它确实偏离 `design.md` D1「只走宿主原生通道、不做裸文件拷贝」的字面 ——
 * 故**必须显式传 `--raw-write`** 才生效（默认关闭），且收尾须如实登记。
 * 语义仍守 U-3：**只覆盖同名、不删独有**。
 */
const RAW_WRITE_ROUTES = Object.freeze({
  extensions: ['public', 'scripts', 'extensions', 'third-party'],
  user: null, // null ⇒ 落 `userDir/user/`
  /**
   * `chats/` 也走裸落盘 —— 端点路径实测走不通：
   * `POST /api/chats/import` 要 `avatar_url`（角色名）去定位 `chats/<avatar>/`，
   * 而 Luker 的聊天目录名含 `（）·!` 等特殊字符，`validateAvatarUrlMiddleware` 与
   * 角色名 sanitize 规则对不上 ⇒ **223 条全部 `{"error":true}`**（实测，两实例一致）。
   *
   * 而 ST 的聊天存储形态 **恰好就是**包内的形态：`data/default-user/chats/<角色>/<文件>.jsonl`
   * ⇒ 裸落盘等价于原生结果。包内的 `.luker-state.*` 附属文件一并落盘（ST 不消费但无害，
   * 且保住了「原样同源」）。
   */
  chats: null,
  // 预设 / 主题类：ST **同样没有导入端点**，但它们在 ST 里就是 `data/default-user/<类目>/*.json`
  // 这样的纯文件（`prd.md` R-2 曾据「无端点」判定其不可达；既然形态就是文件目录，
  // 与 extensions 同理，可由裸落盘还原，故一并纳入）。
  'OpenAI Settings': null,
  'NovelAI Settings': null,
  'KoboldAI Settings': null,
  'TextGen Settings': null,
  instruct: null,
  context: null,
  sysprompt: null,
  reasoning: null,
  QuickReplies: null,
  movingUI: null,
  themes: null,
});

/**
 * 判定一次导入是否**真的成功**。
 *
 * ⚠️ **不能只看 HTTP 状态码**：ST 的 `characters/import` 有两个出口都是 **200** ——
 *   - `response.send({ file_name })`   ← 真成功
 *   - `catch { response.send({ error: true }) }` ← **失败但状态码仍是 200**
 * 只看 status 会把「静默失败」记成成功（2026-09-26 实测踩过：
 * 报 53 成功，而目标 `characters/` 下**一个文件都没多**）。
 * 故以**响应体是否含 `file_name`** 为准；其余出口一律算失败并留证。
 */
function judgeImportResult(status, body) {
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { /* 非 JSON 响应 */ }
  if (status !== 200) return { ok: false, parsed, reason: `HTTP ${status}` };
  if (parsed && parsed.error === true) return { ok: false, parsed, reason: '响应体为 {error:true}（ST 的 catch 分支，状态码仍是 200）' };
  return { ok: true, parsed };
}

function findLatestPack(downloadsDir) {
  const names = fs.readdirSync(downloadsDir).filter((n) => /^pack-st-.*\.zip$/.test(n));
  if (!names.length) throw new Error('未找到 pack-st-*.zip（先跑 build-packs.cjs）');
  names.sort();
  return path.join(downloadsDir, names[names.length - 1]);
}

/** 按实例协议选 http/https（**ST 是明文 http、Luker 才是 https**，别想当然用 https） */
function transportFor(inst) {
  return String(inst.url).startsWith('https') ? https : http;
}

/**
 * 流式 multipart POST。文件字段名固定 `avatar`（宿主全局 multer 的契约，见文件头）。
 * @returns {Promise<{status:number, body:string}>}
 */
function postFile(inst, session, { pathName, fields, file, fileName, mime }) {
  return new Promise((resolve, reject) => {
    const boundary = `----stzip${crypto.randomBytes(12).toString('hex')}`;
    const head = Buffer.concat([
      ...Object.entries(fields).map(([k, v]) => Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
      )),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="avatar";`
        + ` filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`,
      ),
    ]);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, Buffer.isBuffer(file) ? file : Buffer.from(file), tail]);

    const req = transportFor(inst).request({
      hostname: '127.0.0.1',
      port: inst.port,
      path: pathName,
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        'X-CSRF-Token': session.csrf,
        Cookie: session.cookieHeader,
      },
    }, (res) => {
      const chunks = [];
      let kept = 0;
      res.on('data', (c) => { if (kept < 262144) { chunks.push(c); kept += c.length; } });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** JSON 请求（用于 settings get/save） */
function postJson(inst, session, pathName, payload, method = 'POST') {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const req = transportFor(inst).request({
      hostname: '127.0.0.1',
      port: inst.port,
      path: pathName,
      method,
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'X-CSRF-Token': session.csrf,
        Cookie: session.cookieHeader,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** 包内条目按类目归组（只列名，不读内容；`entry.skip()` 保证不占内存） */
async function scanEntries(io, packPath) {
  const groups = new Map();
  const reader = await io.openReader(packPath);
  for await (const e of reader.entries()) {
    if (e.fileName.endsWith('/')) { e.skip(); continue; }
    const n = e.fileName.replace(/\\/g, '/');
    const top = n.split('/')[0];
    const key = n.includes('/') ? top : n; // 根文件（settings.json / secrets.json）自成一组
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ name: n, size: e.uncompressedSize || 0 });
    e.skip();
  }
  await reader.close();
  return groups;
}

/** 从包中逐条读内容（每次重新打开 reader，避免同时持有大量 buffer） */
async function forEachEntryData(io, packPath, predicate, fn) {
  const reader = await io.openReader(packPath);
  let count = 0;
  for await (const e of reader.entries()) {
    if (e.fileName.endsWith('/')) { e.skip(); continue; }
    const n = e.fileName.replace(/\\/g, '/');
    if (!predicate(n)) { e.skip(); continue; }
    const data = await e.read();
    await fn(n, Buffer.from(data));
    count += 1;
  }
  await reader.close();
  return count;
}

const isUnreachable = (n) => UNREACHABLE_PREFIXES.some((p) => n.startsWith(p))
  || n.includes('.luker-state.')
  /**
   * Luker 私有**状态文件**（区别于角色卡）：`characters/<名>.state.<编辑器>.json`。
   * 2026-09-26 实测：它长得像角色卡、其实不是 —— 走 `characters/import` 得到
   * **HTTP 400**（`importFromJson` 返回空 ⇒ `/import` 走 `sendStatus(400)`），
   * 且 ST 侧没有任何对应机制可承接。⇒ 登记为不可达，不投递。
   */
  || /\.state\.[^/]*\.json$/i.test(n);

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const inst = getInstance(args.id);
  if (!inst) throw new Error(`未知实例 id：${args.id}`);
  if (inst.port === 8000) throw new Error('禁止 8000（L0-16）');

  const downloads = path.join(os.homedir(), 'Downloads');
  const packPath = args.pack ? path.resolve(args.pack) : findLatestPack(downloads);
  const { createNodeIo } = require('./lib/node-zip-io.cjs');
  const io = await createNodeIo();

  console.log(`实例：${inst.id}（:${inst.port} ${inst.url}）`);
  console.log(`包：${path.basename(packPath)}（${MB(fs.statSync(packPath).size)} MB）`);
  console.log(`模式：${args.dryRun ? 'dry-run（只列计划，不写入）' : '真跑（会写入实例数据）'}\n`);

  const groups = await scanEntries(io, packPath);

  // —— 计划与不可达登记 ——
  const plan = [];
  const unreachable = [];
  for (const [key, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (key === 'settings.json') { plan.push({ key, kind: 'settings-merge', count: 1 }); continue; }
    // 裸落盘类目（extensions / user）：ST 无端点，需显式 --raw-write 才投入执行
    if (args.rawWrite && Object.prototype.hasOwnProperty.call(RAW_WRITE_ROUTES, key)) {
      plan.push({ key, kind: 'raw-write', count: list.length });
      continue;
    }
    if (isUnreachable(`${key}/`) || isUnreachable(key)) { unreachable.push({ key, count: list.length }); continue; }
    if (BATCH_ORDER.includes(key)) { plan.push({ key, kind: 'file', count: list.filter((x) => !isUnreachable(x.name)).length }); continue; }
    unreachable.push({ key, count: list.length });
  }
  // `--only <类目>`：就地收窄执行范围（下面各处都是 `plan.some(...)`，故一处过滤即全部生效），
  // 便于只重跑某一类目做诊断，而不必再动已成功的类目。
  const effectivePlan = args.only ? plan.filter((p) => p.key === args.only) : plan;
  if (args.only) console.log(`[--only ${args.only}] 本次只执行该类目\n`);

  console.log('=== 将投递（有端点的类目）===');
  for (const p of plan) console.log(`  ${String(p.count).padStart(5)} 条  ${p.key}  [${p.kind}]`);
  console.log('\n=== 不可达（ST 无导入端点，如实登记，不投递）===');
  for (const u of unreachable) console.log(`  ${String(u.count).padStart(5)} 条  ${u.key}`);

  const reachableTotal = plan.reduce((s, p) => s + p.count, 0);
  const packTotal = [...groups.values()].reduce((s, l) => s + l.length, 0);
  console.log(`\n包内总计 ${packTotal} 条 ｜ 可达 ${reachableTotal} 条（${((reachableTotal / packTotal) * 100).toFixed(2)}%）`
    + ` ｜ 不可达 ${packTotal - reachableTotal} 条`);
  console.log('⚠️ AC-2 的「源覆盖率 100%」在 ST 上**不可达**（见 prd 残留 R-2），判定须按可达类目折算。\n');

  if (args.dryRun) {
    console.log('[dry-run] 未做任何写入，结束。');
    return;
  }

  const session = await acquireSession(inst);
  console.log(`会话就绪：cookie ${session.cookieCount} 个、CSRF 已取\n`);

  /**
   * **链接子树扫描**（用户 2026-09-26 裁决：默认跳过）—— 见 `lib/link-guard.cjs`。
   * 裸落盘类目可**逐条跳过**；端点类目（宿主自己往固定目录写）无法逐条拦，故**发现即拒绝**。
   */
  const linkedRoots = [
    ...(await findLinkedRoots(path.join(inst.dir, inst.userDir))),
    ...(await findLinkedRoots(path.join(inst.dir, 'public', 'scripts', 'extensions', 'third-party')))
      .map((l) => ({ ...l, rel: `extensions/${l.rel}` })),
  ];
  if (linkedRoots.length) {
    console.log(`⚠️ 目标目录下有 ${linkedRoots.length} 个**链接子树**（写进去等于改外部工作区）：`);
    for (const l of linkedRoots) console.log(`   - ${l.rel} → ${l.target || '(断链)'}`);
    if (args.allowLinks) {
      console.log('   ⇒ `--allow-links` 已放行：本次写入会穿透到上述外部目录（须如实登记）。\n');
    } else {
      const ENDPOINT_DIRS = ['characters', 'chats', 'worlds', 'backgrounds', 'User Avatars'];
      const blocked = linkedRoots.filter((l) => ENDPOINT_DIRS.some(
        (d) => l.rel === d || l.rel.startsWith(`${d}/`) || d.startsWith(`${l.rel}/`),
      ));
      if (blocked.length) {
        throw new Error(`端点类目目录落在链接子树内（无法逐条跳过）：${blocked.map((b) => b.rel).join(', ')}\n`
          + '⇒ 拒绝启动（默认不穿透链接写入外部工作区）。确需写入请显式加 `--allow-links`。');
      }
      console.log('   ⇒ 裸落盘类目将**跳过**这些子树（默认档）；端点类目不受影响。\n');
    }
  }

  const result = { instance: inst.id, pack: path.basename(packPath), categories: {}, failures: [] };

  // —— 1. 角色卡（必须在 chats 之前）——
  if (effectivePlan.some((p) => p.key === 'characters')) {
    let ok = 0; let fail = 0;
    const t0 = Date.now();

    /**
     * **版本归并先行**（2026-09-26 新增，缺陷 F 的修复）。
     *
     * Luker 盘上 `characters/<sha256>` 是**版本化 blob**：同一角色每改一次留一份，
     * 键尾带 `-<毫秒>.<微秒>`。实测本包 **430 条条目只对应 55 个角色**（平均 7.8 份历史版本，
     * 最大一组 `孤独摇滚` 有 **250 份**）。而 ST 的存储是「**一个头像名一份文件**」——
     * ⇒ 逐条投递时同名前赴后继地互相覆盖，最终落盘的是**包内顺序最末**的那份，
     * 而不是**最新版本**（顺序是 zip 写入序，与新旧无关）。
     *
     * 归并规则（确定性，可复核）：
     *   1. **有版本戳的胜过无版本戳的**（PNG 头像 / 无键条目拿不到版本号）；
     *   2. 都有版本戳 ⇒ 版本号大者胜；
     *   3. 仍平手 ⇒ 包内**靠后**者胜（与逐条投递的最终结果一致，便于两种口径对照）。
     *
     * 副作用（正面）：投递次数从 430 降到 55，服务端压力与耗时可测地下降。
     */
    const winners = new Map(); // avatar → { n, up, versions }
    const isBetter = (cand, cur) => {
      if (cand.version === null && cur.version !== null) return false;
      if (cand.version !== null && cur.version === null) return true;
      if (cand.version === null && cur.version === null) return true; // 无版本信息：后者覆盖
      return cand.version >= cur.version;
    };
    let scanned = 0;
    // 只扫**平铺**的角色卡条目：`characters/<子目录>/...` 是精灵图/状态文件，不是卡片（见下方 sprite 段）
    const isCardEntry = (n) => n.startsWith('characters/') && !isCharacterSubpath(n) && !isUnreachable(n);
    await forEachEntryData(io, packPath, isCardEntry, async (n, data) => {
      const base = n.split('/').pop();
      // 拆壳 + 宿主可落盘名收敛：**唯一实现**在 `lib/luker-card-adapter.cjs`
      // （诊断器 `diag-st-char-map.cjs` 复用同一函数，避免两处推导漂移）。
      // 详见该模块头部的数据形态说明 —— Luker 的 KV 外壳、`preserved_name` 的落盘语义、
      // 以及「非法文件名 ⇒ `writeCharacterData` 返回 false ⇒ HTTP 400」这条失败路径。
      const up = deriveStCharacterUpload(data, base);
      scanned += 1;
      const cur = winners.get(up.avatar);
      if (!cur) { winners.set(up.avatar, { n, up, versions: 1 }); return; }
      cur.versions += 1;
      if (isBetter(up, cur.up)) winners.set(up.avatar, { n, up, versions: cur.versions });
    });

    console.log(`[characters] 包内条目 ${scanned} 条 → 归并后 ${winners.size} 个角色`
      + `（跳过历史版本 ${scanned - winners.size} 条）`);
    if (args.allVersions) {
      console.log('⚠️ --all-versions：不归并，逐条投递（仅供对照，落盘结果取决于包内顺序）');
    }

    const toSend = args.allVersions
      ? null // 由 forEachEntryData 逐条投递
      : [...winners.values()];

    const post = async (n, up) => {
      const r = await postFile(inst, session, {
        pathName: '/api/characters/import',
        fields: { file_type: up.isPng ? 'png' : 'json', preserved_name: up.fileName },
        file: up.payload, fileName: up.fileName, mime: up.isPng ? 'image/png' : 'application/json',
      });
      const verdict = judgeImportResult(r.status, r.body);
      if (verdict.ok) ok += 1;
      else {
        fail += 1;
        // 记**全量**失败（不截断）—— 截断会让「失败到底是不是同一个原因」变成猜测。
        // 每条带上推导出的落盘名，诊断时无需重跑即可归因。
        result.failures.push({
          n,
          preservedName: up.preservedName,
          human: up.human,
          isPng: up.isPng,
          status: r.status,
          reason: verdict.reason,
          parsed: verdict.parsed,
          body: r.body.slice(0, 160),
        });
      }
    };

    if (toSend) {
      for (const w of toSend) await post(w.n, w.up);
    } else {
      await forEachEntryData(io, packPath, isCardEntry, async (n, data) => {
        await post(n, deriveStCharacterUpload(data, n.split('/').pop()));
      });
    }

    result.categories.characters = {
      ok,
      fail,
      scanned,
      distinct: winners.size,
      versionsSkipped: args.allVersions ? 0 : scanned - winners.size,
      seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
    };
    console.log(`[characters] 成功 ${ok} / 失败 ${fail}（${result.categories.characters.seconds}s）`);

    /**
     * **角色卡的子目录内容**（精灵图 / 表情包）：`characters/<角色名>/<图>.png`。
     *
     * 它们**不是卡片**，不能走 `characters/import` —— 2026-09-26 实测：28 条 `Seraphina/*.png`
     * 全部 `{"error":true}`（`importFromPng` 认不出非卡片的 PNG）。而 ST **恰好就按
     * `characters/<角色名>/` 这个形态存精灵图**（同步前目标侧本就有 28 张 `Seraphina/*.png`，
     * 见 `research/t2-pre-dev-st.json`）⇒ 这类条目的原生落点就是**同路径裸落盘**。
     *
     * 语义守 U-3：`mkdir -p` + 同名覆盖，**从不删除**。
     */
    {
      const spriteRoot = path.join(inst.dir, inst.userDir, 'characters');
      let ok2 = 0; let fail2 = 0; let skipLinked2 = 0; const units = new Set();
      const t1 = Date.now();
      await forEachEntryData(io, packPath, (n) => isCharacterSubpath(n) && !isUnreachable(n), async (n, data) => {
        if (!args.allowLinks && isUnderLink(n, linkedRoots)) { skipLinked2 += 1; return; }
        const dest = path.join(spriteRoot, n.slice('characters/'.length));
        try {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, data);
          ok2 += 1;
          units.add(n.split('/')[1]);
        } catch (e) {
          fail2 += 1;
          result.failures.push({ n, status: 'FS', reason: e.message });
        }
      });
      result.categories['characters/sprites'] = {
        ok: ok2,
        fail: fail2,
        skippedLinked: skipLinked2 || undefined,
        mode: 'raw-write',
        targetRoot: spriteRoot,
        units: units.size || undefined,
        seconds: Number(((Date.now() - t1) / 1000).toFixed(1)),
      };
      console.log(`[characters/精灵图] 裸落盘 成功 ${ok2} / 失败 ${fail2}`
        + (skipLinked2 ? ` / 跳过链接子树 ${skipLinked2}` : '')
        + (units.size ? `（${units.size} 个角色目录）` : ''));
    }
  }

  // —— 2. 聊天（依赖角色已导入）——
  // 注意 `p.kind === 'file'`：`chats` 在 `--raw-write` 下是 raw-write 类目，
  // 绝不能同时再走端点（否则同一批条目被投递两次：端点全失败 223 条 + 落盘成功 1029 条，
  // 读数里出现两条自相矛盾的 `[chats]` 行 —— 2026-09-26 实测踩过）。
  if (effectivePlan.some((p) => p.key === 'chats' && p.kind === 'file')) {
    let ok = 0; let fail = 0;
    const t0 = Date.now();
    await forEachEntryData(io, packPath,
      (n) => n.startsWith('chats/') && !isUnreachable(n) && n.endsWith('.jsonl'),
      async (n, data) => {
        const seg = n.split('/');
        const avatar = seg[1] || 'Unknown';
        const base = seg[seg.length - 1];
        const r = await postFile(inst, session, {
          pathName: '/api/chats/import',
          fields: {
            file_type: 'jsonl', avatar_url: avatar, character_name: avatar, user_name: 'User',
          },
          file: data, fileName: base, mime: 'application/octet-stream',
        });
        const verdict = judgeImportResult(r.status, r.body);
        if (verdict.ok) ok += 1;
        else {
          fail += 1;
          if (result.failures.length < 20) {
            result.failures.push({ n, status: r.status, reason: verdict.reason, parsed: verdict.parsed, body: r.body.slice(0, 160) });
          }
        }
      });
    result.categories.chats = { ok, fail, seconds: Number(((Date.now() - t0) / 1000).toFixed(1)) };
    console.log(`[chats] 成功 ${ok} / 失败 ${fail}（${result.categories.chats.seconds}s）`);
  }

  // —— 3. 世界书 ——
  if (effectivePlan.some((p) => p.key === 'worlds')) {
    let ok = 0; let fail = 0;
    const t0 = Date.now();
    await forEachEntryData(io, packPath, (n) => n.startsWith('worlds/'), async (n, data) => {
      const base = n.split('/').pop();
      const r = await postFile(inst, session, {
        pathName: '/api/worldinfo/import',
        fields: {},
        file: data, fileName: base, mime: 'application/json',
      });
      const verdict = judgeImportResult(r.status, r.body);
      if (verdict.ok) ok += 1;
      else {
        fail += 1;
        if (result.failures.length < 20) {
          result.failures.push({ n, status: r.status, reason: verdict.reason, parsed: verdict.parsed, body: r.body.slice(0, 160) });
        }
      }
    });
    result.categories.worlds = { ok, fail, seconds: Number(((Date.now() - t0) / 1000).toFixed(1)) };
    console.log(`[worlds] 成功 ${ok} / 失败 ${fail}（${result.categories.worlds.seconds}s）`);
  }

  // —— 4. 背景 ——
  if (effectivePlan.some((p) => p.key === 'backgrounds')) {
    let ok = 0; let fail = 0;
    const t0 = Date.now();
    await forEachEntryData(io, packPath, (n) => n.startsWith('backgrounds/'), async (n, data) => {
      const base = n.split('/').pop();
      const r = await postFile(inst, session, {
        pathName: '/api/backgrounds/upload',
        fields: {},
        file: data, fileName: base, mime: 'application/octet-stream',
      });
      const verdict = judgeImportResult(r.status, r.body);
      if (verdict.ok) ok += 1;
      else {
        fail += 1;
        if (result.failures.length < 20) {
          result.failures.push({ n, status: r.status, reason: verdict.reason, parsed: verdict.parsed, body: r.body.slice(0, 160) });
        }
      }
    });
    result.categories.backgrounds = { ok, fail, seconds: Number(((Date.now() - t0) / 1000).toFixed(1)) };
    console.log(`[backgrounds] 成功 ${ok} / 失败 ${fail}（${result.categories.backgrounds.seconds}s）`);
  }

  // —— 5. User Avatars ——
  if (effectivePlan.some((p) => p.key === 'User Avatars')) {
    let ok = 0; let fail = 0;
    const t0 = Date.now();
    await forEachEntryData(io, packPath, (n) => n.startsWith('User Avatars/'), async (n, data) => {
      const base = n.split('/').pop();
      const r = await postFile(inst, session, {
        pathName: '/api/avatars/upload',
        fields: { overwrite_name: base },
        file: data, fileName: base, mime: 'image/png',
      });
      const verdict = judgeImportResult(r.status, r.body);
      if (verdict.ok) ok += 1;
      else {
        fail += 1;
        if (result.failures.length < 20) {
          result.failures.push({ n, status: r.status, reason: verdict.reason, parsed: verdict.parsed, body: r.body.slice(0, 160) });
        }
      }
    });
    result.categories['User Avatars'] = { ok, fail, seconds: Number(((Date.now() - t0) / 1000).toFixed(1)) };
    console.log(`[User Avatars] 成功 ${ok} / 失败 ${fail}（${result.categories['User Avatars'].seconds}s）`);
  }

  // —— 6. settings：读回 → 合并 → 写回（整份替换语义，直接写会丢目标自定义项）——
  if (effectivePlan.some((p) => p.key === 'settings.json')) {
    const cur = await postJson(inst, session, '/api/settings/get', {});
    let target = {};
    try { target = JSON.parse(cur.body); } catch { /* 拿不到就按空对象合并，下面会登记 */ }
    const targetKeys = Object.keys(target).length;

    let packSettings = null;
    await forEachEntryData(io, packPath, (n) => n === 'settings.json', async (_n, data) => {
      try { packSettings = JSON.parse(data.toString('utf8')); } catch { /* 非 JSON */ }
    });

    if (!packSettings) {
      result.categories.settings = { ok: 0, fail: 1, note: '包内 settings.json 无法解析' };
      console.log('[settings] 跳过：包内 settings.json 无法解析');
    } else {
      /**
       * **按目标键集做交集合并**（2026-09-26 事故后的策略，用户裁定）。
       *
       * 原写法 `{...target, ...packSettings}` 是**并集**：它把**源宿主（Luker）特有的顶层键**
       * 整块带进 ST —— 实测 `settings` 46 MB + `openai_settings` 34.5 MB + `themes`/`instruct`/
       * `quickReplyPresets` 等 27 个键，把目标 settings.json 从 **44 KB 撑到 113.7 MB**。
       * 后果不是"文件大一点"：ST 前端每轮都要解析/回存这个对象，**卡在"settings 未就绪"
       * ⇒ `activateExtensions()` 永不执行 ⇒ 所有第三方扩展都不加载**（冒烟从 53/53 掉到 50/53，
       * 排查足迹见 `research/repair-settings-merge-*.json` 与 `test-results/settings-repair-backups/`）。
       *
       * 新判据：**目标的键集就是"这个宿主认识什么"** —— 只合并目标已有的键（同名覆盖），
       * 包内的陌生键**一律不写**并计数登记。语义仍是 U-3 的「覆盖同名」，但不再引入陌生 schema。
       * 清理已污染的那一次：`repair-settings-merge.cjs`（同一判据）。
       */
      const packKeys = Object.keys(packSettings);
      const foreign = packKeys.filter((k) => !Object.prototype.hasOwnProperty.call(target, k));
      const merged = { ...target };
      for (const k of packKeys) {
        if (!foreign.includes(k)) merged[k] = packSettings[k];
      }
      const r = await postJson(inst, session, '/api/settings/save', merged);
      const ok = r.status === 200 ? 1 : 0;
      result.categories.settings = {
        ok, fail: ok ? 0 : 1,
        targetKeysBefore: targetKeys,
        packKeys: packKeys.length,
        mergedKeys: Object.keys(merged).length,
        foreignKeysSkipped: foreign.length,
        note: '整份替换语义 ⇒ 先读回目标，**只在目标已有的键内**做同名覆盖；陌生键不写',
      };
      console.log(`[settings] 交集合并写回：目标原有 ${targetKeys} 键，包内 ${packKeys.length} 键`
        + `（其中**陌生键 ${foreign.length} 个一律不写**：${foreign.slice(0, 5).join(', ')}${foreign.length > 5 ? ' …' : ''}）`
        + ` → ${Object.keys(merged).length} 键，HTTP ${r.status}`);
    }
  }

  // —— 7. 裸落盘类目（extensions / user）：ST 无导入端点，其原生形态就是磁盘目录 ——
  //
  //   `extensions/**`  →  `<inst>/public/scripts/extensions/third-party/**`（ST 的第三方扩展位置）
  //   `user/**`        →  `<inst>/<userDir>/user/**`
  //
  // 语义守 U-3：**只覆盖同名、不删独有**（只是 mkdir + writeFile，从不删除）。
  for (const key of Object.keys(RAW_WRITE_ROUTES)) {
    if (!effectivePlan.some((p) => p.key === key)) continue;
    const rel = RAW_WRITE_ROUTES[key];
    const targetRoot = rel
      ? path.join(inst.dir, ...rel)
      : path.join(inst.dir, inst.userDir, key);
    let ok = 0;
    let fail = 0;
    let skippedLinked = 0;
    const units = new Set();
    const t0 = Date.now();
    await forEachEntryData(io, packPath, (n) => n.startsWith(`${key}/`), async (n, data) => {
      const sub = n.slice(key.length + 1);
      if (!sub) return;
      // 链接子树：默认跳过（写进去等于改别人的工作区，见 lib/link-guard.cjs）
      if (!args.allowLinks && isUnderLink(n, linkedRoots)) { skippedLinked += 1; return; }
      const dest = path.join(targetRoot, sub);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, data);
        ok += 1;
        const seg = sub.split('/');
        if (seg.length > 1) units.add(seg[0]);
      } catch (e) {
        fail += 1;
        if (result.failures.length < 20) result.failures.push({ n, status: 'FS', reason: e.message });
      }
    });
    result.categories[key] = {
      ok,
      fail,
      skippedLinked: skippedLinked || undefined,
      mode: 'raw-write',
      targetRoot,
      units: units.size || undefined,
      seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
    };
    console.log(`[${key}] 裸落盘 成功 ${ok} / 失败 ${fail}`
      + (skippedLinked ? ` / 跳过链接子树 ${skippedLinked}` : '')
      + (units.size ? `（${units.size} 个扩展）` : '') + ` → ${targetRoot}`);
  }

  result.unreachable = unreachable;
  result.totals = { packTotal, reachableTotal, unreachableTotal: packTotal - reachableTotal };

  const outPath = path.join(
    path.resolve(__dirname, '..', '..', '.trellis', 'tasks', '09-26-all-instance-data-sync-e2e', 'research'),
    `import-st-${inst.id}-${Date.now()}.json`,
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\n读数 → ${outPath}`);
  if (result.failures.length) {
    console.log(`\n⚠️ 失败样本（前 ${Math.min(5, result.failures.length)} 条）：`);
    result.failures.slice(0, 5).forEach((f) => console.log(`  ${f.n} → HTTP ${f.status} ${f.body.slice(0, 120)}`));
  }
})().catch((e) => {
  console.error('\n导入器异常：', e && e.message ? e.message : e);
  process.exit(1);
});
