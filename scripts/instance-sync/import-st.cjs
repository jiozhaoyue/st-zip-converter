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

const MB = (n) => (n / 1048576).toFixed(1);
const BATCH_ORDER = ['characters', 'chats', 'worlds', 'backgrounds', 'User Avatars'];

/** 无导入端点的类目（如实登记，不投递） */
const UNREACHABLE_PREFIXES = [
  'OpenAI Settings/', 'NovelAI Settings/', 'KoboldAI Settings/', 'TextGen Settings/',
  'instruct/', 'context/', 'sysprompt/', 'reasoning/', 'QuickReplies/', 'movingUI/',
  'themes/', 'secrets.json',
];

function parseArgs(argv) {
  const out = { id: 'dev-st', pack: '', handle: 'default-user', dryRun: false, only: '', rawWrite: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--id') out.id = argv[++i] || '';
    else if (argv[i] === '--pack') out.pack = argv[++i] || '';
    else if (argv[i] === '--handle') out.handle = argv[++i] || '';
    else if (argv[i] === '--only') out.only = argv[++i] || '';
    else if (argv[i] === '--raw-write') out.rawWrite = true;
    else if (argv[i] === '--dry-run') out.dryRun = true;
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
  || n.includes('.luker-state.');

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

  const result = { instance: inst.id, pack: path.basename(packPath), categories: {}, failures: [] };

  // —— 1. 角色卡（必须在 chats 之前）——
  if (effectivePlan.some((p) => p.key === 'characters')) {
    let ok = 0; let fail = 0;
    const t0 = Date.now();
    await forEachEntryData(io, packPath, (n) => n.startsWith('characters/') && !isUnreachable(n), async (n, data) => {
      const base = n.split('/').pop();
      // PNG 与 JSON 要用不同的 `file_type`（`characters.js:1560` 的 formatImportFunctions 按它选解析器）。
      // 固定传 'json' 会让 PNG 卡片走 `importFromJson` 而失败。
      const isPng = data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;

      /**
       * **Luker 角色卡的拆壳适配**（跨宿主格式差异的实质所在）。
       *
       * Luker 把角色卡存成 KV 外壳：
       *   `{ "key": "data\\default-user\\characters\\孤独摇滚.png-1771010065094.1455",
       *      "value": "{\"name\":\"孤独摇滚\",\"description\":\"…\"}" }`
       * 而 **`value` 这个字符串本身就是一张标准 TavernAI 卡片** —— 解析出来即可直接喂给 ST。
       *
       * ⇒ 这不是"绕过宿主"，而是**跨宿主数据形态的必要转换**：包内是 Luker 的存储形态，
       *   ST 的端点要的是卡片形态，两者之间的映射必须有人做。原先固定按 'json' 直投，
       *   结果是 430 张卡片 **0 张成功**（ST 的 `importFromJson` 认不出 KV 外壳）。
       *
       * `key` 里还带着**原始文件名**（`孤独摇滚.png-1771010065094.1455`），
       * 据此还原出人类可读的角色名作为 `preserved_name`，导入后角色卡才有正常名字。
       */
      let payload = data;
      // PNG 卡片必须带 `.png` 扩展名 —— ST 的 `importFromPng` 按扩展名分派，
      // 而无扩展名的哈希名会让它落空返回 400（实测：53 条 PNG 全因此失败）。
      let fileName = isPng ? `${base}.png` : base;
      if (!isPng) {
        try {
          const outer = JSON.parse(data.toString('utf8'));
          if (outer && typeof outer.value === 'string' && outer.key) {
            const card = JSON.parse(outer.value); // 内层即标准卡片
            if (card && typeof card === 'object' && card.name) {
              payload = Buffer.from(JSON.stringify(card), 'utf8');
              const orig = String(outer.key).split(/[\\/]/).pop() || base;
              const human = orig.replace(/\.png$/i, '').replace(/-\d+\.\d+$/, '').trim();
              if (human) fileName = `${human}.json`;
            }
          }
        } catch { /* 不是 KV 外壳：按原样投递，别把正常卡片也弄坏 */ }
      }

      const r = await postFile(inst, session, {
        pathName: '/api/characters/import',
        fields: { file_type: isPng ? 'png' : 'json', preserved_name: fileName },
        file: payload, fileName, mime: isPng ? 'image/png' : 'application/json',
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
    result.categories.characters = { ok, fail, seconds: Number(((Date.now() - t0) / 1000).toFixed(1)) };
    console.log(`[characters] 成功 ${ok} / 失败 ${fail}（${result.categories.characters.seconds}s）`);
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
      const merged = { ...target, ...packSettings };
      const r = await postJson(inst, session, '/api/settings/save', merged);
      const ok = r.status === 200 ? 1 : 0;
      result.categories.settings = {
        ok, fail: ok ? 0 : 1,
        targetKeysBefore: targetKeys,
        packKeys: Object.keys(packSettings).length,
        mergedKeys: Object.keys(merged).length,
        note: '整份替换语义 ⇒ 已先读回目标并合并，包内键覆盖同名',
      };
      console.log(`[settings] 合并写回：目标原有 ${targetKeys} 键 + 包内 ${Object.keys(packSettings).length} 键`
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
    const units = new Set();
    const t0 = Date.now();
    await forEachEntryData(io, packPath, (n) => n.startsWith(`${key}/`), async (n, data) => {
      const sub = n.slice(key.length + 1);
      if (!sub) return;
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
      mode: 'raw-write',
      targetRoot,
      units: units.size || undefined,
      seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
    };
    console.log(`[${key}] 裸落盘 成功 ${ok} / 失败 ${fail}`
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
