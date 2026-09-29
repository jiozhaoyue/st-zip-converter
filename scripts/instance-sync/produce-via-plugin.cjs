/**
 * 插件驱动产包器 —— 让**插件自己在实例内**产出数据包（本任务唯一的新代码，U-2/U-11）
 *
 * ## 为什么需要它（U-2 的实质改动）
 *
 * 上一轮的产包走**宿主原生端点**：`export-backups.cjs` → `POST /api/users/backup`，
 * 再用 `build-packs.cjs` 转出三布局。**插件本体不参与产包**。
 * 用户裁决 U-2 把它倒过来：「**数据产生靠插件**（实例运行时在实例内导出），中间搬运可以走脚本」。
 * 本脚本就是「插件产包」这一环的自动化装置 —— 它**驱动插件工作台的真实控件**（宿主拉取路径），
 * 产物由插件的待导出区下载出来。
 *
 * ⚠️ **它不冒充插件**：判定依据是「产物由实例页面的插件 UI 触发并落盘」
 * （AC-A1；**不得**用 Node 侧直调 `POST /api/users/backup` 冒名顶替 —— 那是 `export-backups.cjs` 的活儿）。
 * 两者在本任务里**互为对照组**：本脚本产出的是「插件视角」的包，与原生端点导出的包做条目级口径比对。
 *
 * ## 端口纪律（D1.3）：**不调用 E2E 守卫，但继承其三条精神**
 *
 * 冲突：产物源是 **Real Luker（`:8004`）**，而 `e2e/lib/guard.cjs` 的白名单是 `{8001,8003,8899}`
 * ⇒ 产包器若走守卫会被自己拦下。解法（**不修改守卫、不放宽 E2E**）：
 *
 * | 继承自守卫 | 本脚本的实现 |
 * | --- | --- |
 * | 启动时断言，失败即非零退出 | `--source` 必填且必须在登记表内，否则立即退出 |
 * | 不给默认值 | **没有** `?? 'dev-luker'` 这类兜底（兜底值就是误连入口） |
 * | 禁止自动改写目标 | 不得因「端口被占」回退到别的实例（改端口 = 换数据区） |
 * | 另加 | 拒绝 `8000`（L0-16）；打印解析出的端口与 side（Dev/Real）供人工核对 |
 *
 * **为什么这样切是干净的**：登记表（`e2e/lib/instances.cjs`）是**所有**实例的唯一定义点，
 * 守卫只是 **E2E 的**使用限制。产包器是另一个消费者 —— 各有各的使用限制，不是两份端口表。
 *
 * ## 与 `harness.openInstance` 的关系（一处**有意**不复用，D1.1 表的例外）
 *
 * `design.md` D1.1 列了「复用 `e2e/lib/harness.cjs` 的 `openInstance`」，但**它内嵌 `assertDevTarget(inst.url)`**
 * ⇒ 对 Real 源直接抛错，无法复用。故此处**复用其组件、不复用其入口**：
 * 自起持久化 context（同一 `inst.profile`），自己实现「有界等待宿主就绪」。
 * 另：`installChatFilesysPromptGuard` 未导出，而本脚本**不需要**它 —— 见下条。
 *
 * ## 交互方式：**页内 `element.click()`**，不是 Playwright 的指针点击（有意选择）
 *
 * 本脚本是**工具**，不是用户模拟测试（那是 E2E 的职责）。而宿主 splash 与第三方插件的模态
 * `<dialog>` 会**拦截指针事件**（规范 §11.11 实测：ChatFilesys「入库提醒」弹窗让矩阵整段假红），
 * 页内 `click()` 不做命中测试 ⇒ 天然不受影响。**代价**：绕过了"可见性"这一层，
 * 故所有旋钮与类目勾选一律**落盘前回读**（规范 §11.3「凡失败也可能不抛错的交互都要回读」）。
 *
 * ## 用法
 *
 * ```bash
 * # 三布局直出（OQ-2）
 * node scripts/instance-sync/produce-via-plugin.cjs --source real-luker --layout st --out <dir>
 * node scripts/instance-sync/produce-via-plugin.cjs --source real-luker --layout tt --out <dir>
 * node scripts/instance-sync/produce-via-plugin.cjs --source real-luker --layout l  --out <dir>
 *
 * # 原样宿主包（pristine，无转换）—— 用于与宿主原生备份做条目级口径比对（§1.2）
 * node scripts/instance-sync/produce-via-plugin.cjs --source dev-luker --layout l --raw --out <dir>
 * ```
 *
 * ## ⚠️ 类目收窄：`--deselect`（`design.md` D1.2 写的是 `--categories`，落地时改了这个形状）
 *
 * 类目卡片（`.category-card`）是**计划渲染的产物**：`availableCategories` 由
 * `renderCategoryStats(plan)` 填充，而**宿主拉取路径的计划要在拉取之后**才渲染
 * （`index.js:1648`，那时 selection 早已作为 `endpointSelection` 发出去了）。
 * 空工作区下 `#category-checkboxes` 为空 ⇒ **一张卡片都没有** ⇒ 无从收窄。
 *
 * 所以收窄必须先**喂一个探测夹具**把卡片渲染出来（`narrowSelection()`，手法同
 * `e2e/specs/library-inject.e2e.cjs`），再取消勾选，再**回读断言**。
 * 故开关命名为 `--deselect <keys>`（**取消**哪些类目）而不是 `--categories`（勾选哪些）——
 * 与「先喂夹具才有卡片」这一事实相符。
 *
 * ### 为什么真源 Real Luker **必须** `--deselect settings`
 *
 * 2026-09-29 实测：勾着 `settings` 时 Luker 会隐含打包 `backups/`（历史快照，真源上
 * **2.5 GB 且已是 deflate 过的数据**）。插件在浏览器里拉它时**功能性停滞** ——
 * 实测 `已接收 1281.9 MB` 之后 **连续 140 s 零字节**（速率塌方到 0，规范 §3.5 记过这个塌方，
 * 但没记到「完全停滞」这一步）。**同一个端点在 Node 侧流式接收只要 337 s 就收完 1.68 GB** ⇒
 * 这是**浏览器路径**的问题，不是端点的问题。
 * ⇒ 不 `--deselect settings` 的话，本工具在真源上**不可用**。
 *
 * 另：拉取量也因此从 1.68 GB 降到约 0.6 GB（真源），耗时从「停滞」降到分钟级。
 *
 * ## 旋钮默认值 = `build-packs.cjs` 的既有语义（**刻意为对齐，不是随手选**）
 *
 * | 旋钮 | 本书默认 | 理由 |
 * | --- | --- | --- |
 * | `--include-backups` | **关** | U-4：同步时排除 `backups/`（该值本就是 `convert()` 默认，显式写出防将来漂移） |
 * | `--git-mode` | **minimal** | 对齐 `build-packs.cjs`。`keep` 会在含 `.git` 的扩展上撞 Windows 只读冲突（上一轮实测 `EPERM`，恢复中断在 85.161%） |
 * | `--extension-mode` | **full** | 对齐 `convert()` 默认（`transform.js:324`）。插件 UI 的默认是 `manifest`，**两者不同**，故必须显式指定 |
 * | `--prune-builtin` | **0（不剪）** | 对齐 `build-packs.cjs`（它不传该选项 ⇒ `convert()` 默认 `false`）。插件 UI 的 `#prune-builtin-check` 默认是**勾上** |
 * | `--compression` | 5 | 与 `convert()` 默认一致 |
 *
 * ⚠️ 上表后三行是**实测差异**：插件 UI 的默认值与 `build-packs.cjs` 的语义**不一致**。
 * 直接按 UI 默认产包会得到「带 `manifest.json`、剪掉内置资产、`.git` 全留」的包，
 * 与上一轮已验证的包不是一回事 ⇒ 同步链必须**显式**按下表设定，不能吃 UI 默认。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { getInstance, REPO_ROOT } = require('../../e2e/lib/instances.cjs');
const { loadPlaywright, warnOnVersionDrift } = require('../../e2e/lib/resolve-playwright.cjs');
const { PLUGIN_SLUG } = require('../../e2e/lib/harness.cjs');

/** 当前任务的 research 目录（读数落点）。build-packs.cjs 曾把上一轮任务目录**硬编码**并随之腐化，
 *  故此处留 `--readings-dir` 开关：换任务时覆盖，不必改脚本。 */
const DEFAULT_READINGS_DIR = path.join(
  REPO_ROOT, '.trellis', 'tasks', '09-27-plugin-driven-instance-sync', 'research',
);

const MB = (n) => (n / 1048576).toFixed(1);

// ─────────────────────────────── CLI ───────────────────────────────

function parseArgs(argv) {
  const out = {
    source: '',
    layout: '',
    out: '',
    readingsDir: DEFAULT_READINGS_DIR,
    timeout: 1_800_000,          // 30 min：真源包 1.6 GB，拉取 + 扫描 + 转换都在窗口内
    raw: false,
    includeBackups: false,
    gitMode: 'minimal',
    extensionMode: 'full',
    pruneBuiltin: false,
    keepDevFiles: false,
    compression: '5',
    cleanupStash: true,
    deselect: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--source') out.source = argv[++i] || '';
    else if (a === '--layout') out.layout = argv[++i] || '';
    else if (a === '--out') out.out = argv[++i] || '';
    else if (a === '--readings-dir') out.readingsDir = argv[++i] || '';
    else if (a === '--timeout') out.timeout = Number(argv[++i]) || out.timeout;
    else if (a === '--raw') out.raw = true;
    else if (a === '--include-backups') out.includeBackups = true;
    else if (a === '--git-mode') out.gitMode = argv[++i] || '';
    else if (a === '--extension-mode') out.extensionMode = argv[++i] || '';
    else if (a === '--prune-builtin') out.pruneBuiltin = (argv[++i] || '') === '1';
    else if (a === '--keep-dev-files') out.keepDevFiles = true;
    else if (a === '--compression') out.compression = argv[++i] || '5';
    else if (a === '--no-clean-stash') out.cleanupStash = false;
    else if (a === '--deselect') out.deselect = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const HELP = `插件驱动产包器（在源实例内由插件 UI 产包）

必填：
  --source <id>            源实例 id，必须在 e2e/lib/instances.cjs 登记表内（无默认值）
  --layout <st|tt|l|pt>    目标布局（无默认值；--raw 时须等于宿主自身布局码）
  --out <dir>              产物落点目录

可选：
  --raw                    原样宿主包（不转换）—— 与宿主原生备份做口径比对的出口
  --timeout <ms>           单次有界等待上限（默认 1800000）
  --deselect <a,b>         拉取前**按类目收窄** selection（会先喂探测夹具以渲染类目卡片）。
                           真源 Real Luker 上 **必须** --deselect settings：勾着 settings
                           时 Luker 隐含打包 GB 级 backups/，浏览器路径实测停滞（见文件头）
  --include-backups        把 backups/ 纳入产物（默认关，U-4）
  --git-mode <keep|minimal|strip>   默认 minimal（对齐 build-packs）
  --extension-mode <manifest|full>  默认 full（对齐 convert() 默认）
  --prune-builtin <0|1>    默认 0（对齐 build-packs）
  --keep-dev-files         默认关
  --compression <0|1|5|9>  默认 5
  --no-clean-stash         下载后不清理本次入库记录（默认清理，避免持久化档案被 GB 级产物撑大）
  --readings-dir <dir>     读数 JSON 落点（默认本任务 research/）
`;

// ─────────────────────────── 端口/登记纪律 ───────────────────────────

/** 宿主自身布局码（`hostLayoutCode` 的白名单子集：luker→l） */
function hostOwnLayout(host) {
  if (host === 'luker') return 'l';
  if (host === 'st') return 'st';
  return null;
}

/** 实例里插件目录的相对路径；PT 是浏览器侧扩展，无磁盘目录 ⇒ null */
function pluginRelPath(inst) {
  if (inst.host === 'st') return path.join('public', 'scripts', 'extensions', 'third-party', PLUGIN_SLUG);
  if (inst.host === 'luker') return path.join(inst.userDir || 'data/default-user', 'extensions', PLUGIN_SLUG);
  return null;
}

/**
 * 解析并断言源实例。**继承 `guard.cjs` 的三条精神**（D1.3 表）：非零退出、不给默认值、不改写目标。
 * @returns {import('../../e2e/lib/instances.cjs').Instance}
 */
function assertSource(id) {
  if (!id) {
    console.error('✗ --source 必填：拒绝静默兜底（本工具没有默认实例）');
    process.exit(2);
  }
  const inst = getInstance(id); // 不在登记表内 → 抛错（未知 id）
  const u = new URL(inst.url);
  if (!u.port) {
    console.error(`✗ 登记表里 ${id} 的 URL 未显式写端口 ⇒ 目标不明，拒绝`);
    process.exit(2);
  }
  if (u.port === '8000') {
    console.error('✗ 8000 是工厂默认段，禁止（L0-16）');
    process.exit(2);
  }
  return inst;
}

/** 工作区 HEAD（短哈希） */
function workspaceHead() {
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

/**
 * R-20 硬门禁（`design.md` D1.4）：**实例里装的插件版本必须 == 工作区**。
 *
 * 为什么比 E2E 更需要它：「数据产生靠插件」意味着**插件版本直接决定产物正确性**。
 * 上一轮这条纪律靠人记（R-20 的教训），此处做成硬门禁 —— 不一致即拒绝执行并非零退出。
 *
 * @returns {{pluginDir: string, instanceHead: string, workspaceHead: string}}
 */
function assertR20(inst) {
  const rel = pluginRelPath(inst);
  if (!rel) {
    console.error(`✗ ${inst.id}（host=${inst.host}）没有磁盘插件目录 ⇒ 无插件可驱动，拒绝`);
    process.exit(3);
  }
  const pluginDir = path.join(inst.dir, rel);
  if (!fs.existsSync(pluginDir)) {
    console.error(`✗ 实例插件目录不存在：${pluginDir}`);
    process.exit(3);
  }
  const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: pluginDir, encoding: 'utf8' }).trim();
  const ws = workspaceHead();
  if (head !== ws) {
    console.error(`✗ R-20 门禁未过：实例插件版本 ${head} ≠ 工作区 ${ws}`);
    console.error(`  ⇒ 先在实例里 \`git pull\`（仅限该通道；动的是插件代码目录，不是用户数据）`);
    process.exit(3);
  }
  return { pluginDir, instanceHead: head, workspaceHead: ws };
}

// ─────────────────────────── 浏览器驱动 ───────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 页内装采集器：日志面板**必须先展开**（折叠态 `log-console.js:262` 不追加任何行，规范 §11.8-4） */
async function expandLog(page) {
  await page.evaluate(() => {
    const body = document.getElementById('log-console-body');
    if (body && getComputedStyle(body).display === 'none') {
      const btn = document.getElementById('btn-toggle-log');
      if (btn) btn.click();
    }
  }).catch(() => {});
}

async function readLog(page) {
  return page.evaluate(() => {
    const el = document.getElementById('log-stream-container');
    return el ? el.textContent : '';
  }).catch(() => '');
}

/** 有界等待某个页内条件成立；返回 boolean，不抛 */
async function waitInPage(page, fn, arg, timeout, label) {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 500 });
    return true;
  } catch {
    console.error(`  · ⚠ 有界等待超时：${label}（${Math.round(timeout / 1000)} s）`);
    return false;
  }
}

/** 读当前类目勾选态（有卡片才有内容；无卡片 ⇒ 空对象，selection 取模块默认） */
async function readSelection(page) {
  return page.evaluate(() => {
    const out = {};
    for (const c of document.querySelectorAll('#category-checkboxes .category-card')) {
      const b = c.querySelector('input[type="checkbox"]');
      if (b) out[c.dataset.category] = b.checked;
    }
    return out;
  });
}

/**
 * 探测夹具：喂进工作台以**渲染类目卡片**（`#category-checkboxes` 是**计划渲染的产物**）。
 *
 * 为什么必须喂：宿主拉取路径的计划在**拉取之后**才渲染（`index.js:1648`），
 * 空工作区下**一张卡片都没有** ⇒ 无法按类目收窄 selection。而真源 Real Luker 的
 * `settings` 会隐含打包 GB 级 `backups/`，浏览器路径在其上**实测停滞**（见文件头）。
 * 喂夹具只影响「计划 / 类目 UI」，**不影响拉取的字节来源**（字节始终来自宿主）。
 *
 * 夹具由 `fixtures/gen.js` 现场生成到 `test-results/fixtures`（`.gitignore` 覆盖，不入库），
 * 手法与 `e2e/specs/library-inject.e2e.cjs` 一致。
 */
async function ensureProbeFixture() {
  const dir = path.join(REPO_ROOT, 'test-results', 'fixtures');
  fs.mkdirSync(dir, { recursive: true });
  const stPath = path.join(dir, 'fixture-st.zip');
  if (!fs.existsSync(stPath)) {
    const genUrl = require('url').pathToFileURL(path.join(REPO_ROOT, 'fixtures', 'gen.js')).href;
    await import(genUrl).then((m) => m.generateAll(dir));
  }
  return stPath;
}

/**
 * 按类目**收窄** selection：喂夹具 → 等卡片 → 取消勾选 → **回读断言**。
 *
 * ⚠️ 这是本工具在**真源**上可用的前提：`settings` 勾着 ⇒ Luker 隐含打包 `backups/`
 * ⇒ 浏览器拉取实测停滞。`--deselect settings` 是绕开它的开关。
 * 卡在 `--timeout` 之前就早退（不做那次注定失败的 GB 级拉取）。
 */
async function narrowSelection(page, keys) {
  const fixture = await ensureProbeFixture();
  await page.setInputFiles('#file-input', fixture);
  const cardsReady = await waitInPage(page, (want) => {
    const have = new Set(Array.from(document.querySelectorAll('#category-checkboxes .category-card'))
      .map((c) => c.dataset.category));
    return want.every((k) => have.has(k));
  }, keys, 120_000, `类目卡片渲染（需要 ${keys.join(',')}）`);
  if (!cardsReady) return { ok: false, why: 'cards-not-rendered', wanted: keys };

  const res = await page.evaluate((want) => {
    const found = {};
    for (const k of want) {
      const card = document.querySelector(`.category-card[data-category="${k}"]`);
      const box = card ? card.querySelector('input[type="checkbox"]') : null;
      found[k] = Boolean(box);
      if (box && box.checked) box.click();   // 页内 click：绕开模态弹窗的指针拦截
    }
    return { found };
  }, keys);
  await page.waitForTimeout(300);
  const after = await readSelection(page);
  const notDeselected = keys.filter((k) => after[k] !== false);
  return {
    ok: notDeselected.length === 0,
    fixture: path.basename(fixture),
    found: res.found,
    after,
    notDeselected,
  };
}

/** 一次把 8 个旋钮都设好，并**回读**（规范 §11.3：不抛错的交互都要回读） */
async function setKnobs(page, want) {
  return page.evaluate((w) => {
    const log = [];
    const sel = (s) => document.querySelector(s);
    const setSelect = (s, v) => {
      const el = sel(s);
      if (!el) { log.push(`MISS ${s}`); return; }
      el.value = v;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const setRadio = (name, v) => {
      const el = sel(`input[name="${name}"][value="${v}"]`);
      if (!el) { log.push(`MISS radio ${name}=${v}`); return; }
      el.checked = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const setCheck = (s, v) => {
      const el = sel(s);
      if (!el) { log.push(`MISS ${s}`); return; }
      if (el.checked !== v) {
        el.checked = v;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    };

    setSelect('#target-select', w.layout);
    setSelect('#compression-select', String(w.compression));
    setRadio('git-mode', w.gitMode);
    setRadio('extension-mode', w.extensionMode);
    setCheck('#include-backups-check', w.includeBackups);
    setCheck('#prune-builtin-check', w.pruneBuiltin);
    setCheck('#keep-dev-files-check', w.keepDevFiles);
    // 分卷必须关：分卷会让产物变成多份，本工具只取单包
    const split = sel('#split-input');
    if (split && split.value !== '') {
      split.value = '';
      split.dispatchEvent(new Event('input', { bubbles: true }));
      split.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // —— 回读（判据以**当前 DOM** 为准，注释与历史陈述都不算）——
    const readBack = {
      target: sel('#target-select') ? sel('#target-select').value : null,
      compression: sel('#compression-select') ? sel('#compression-select').value : null,
      gitMode: (sel('input[name="git-mode"]:checked') || {}).value || null,
      extensionMode: (sel('input[name="extension-mode"]:checked') || {}).value || null,
      includeBackups: sel('#include-backups-check') ? sel('#include-backups-check').checked : null,
      pruneBuiltin: sel('#prune-builtin-check') ? sel('#prune-builtin-check').checked : null,
      keepDevFiles: sel('#keep-dev-files-check') ? sel('#keep-dev-files-check').checked : null,
      splitInput: sel('#split-input') ? sel('#split-input').value : null,
      filenameTemplate: sel('#filename-template-input') ? sel('#filename-template-input').value : null,
    };
    // 类目卡片只有渲染过计划才存在；无卡片时 selection 取模块默认
    // （`category-filter.js:22-36`：除 cache / appPrivate 外全选）
    const categories = {};
    for (const c of document.querySelectorAll('.category-card')) {
      const box = c.querySelector('input[type="checkbox"]');
      if (box) categories[c.dataset.category] = box.checked;
    }
    return { log, readBack, categories, categoryCardCount: Object.keys(categories).length };
  }, want);
}

/** 禁用的按钮 click() 是**静默空操作** ⇒ 先回读可用性，再点 */
async function readFetchButton(page) {
  return page.evaluate(() => {
    const b = document.getElementById('btn-host-fetch');
    if (!b) return { present: false };
    return {
      present: true,
      disabled: Boolean(b.disabled),
      display: getComputedStyle(b).display,
      width: Math.round(b.getBoundingClientRect().width),
    };
  });
}

/** 待导出区条目读数（计数 + 末条的名字/来源/布局/体积文案） */
async function readQueue(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#export-queue-panel .export-queue-item'));
    const last = rows[rows.length - 1];
    return {
      count: rows.length,
      last: last ? {
        name: (last.querySelector('.eq-name') || {}).textContent || null,
        meta: (last.querySelector('.eq-meta') || {}).textContent || null,
        hasDownloadBtn: Boolean(last.querySelector('.eq-buttons button.download')),
      } : null,
    };
  });
}

/**
 * 删除本次入库的产物记录（`export-queue.download()` 会**顺带 stash**，
 * 见 `src/ui/export-queue.js:148-156`）。不清的话，持久化档案每跑一次就多 GB 级 blob。
 *
 * 只删**本次产物名**对应的 `files` 记录 —— 不碰其它记录。
 * **并把删掉的东西原样报出来**（id/name/size/origin）：2026-09-29 实测第一次就删掉了 **3 条**
 * 同名记录（本工具本轮只产出 1 个产物），说明该档案里本来就有同名残留（dev 档案与 E2E 共用）。
 * 不报出来就变成「悄悄删了别人的东西」—— 与 `P-19` 同形的隐患，故此处留痕。
 */
async function cleanupStash(page, names) {
  return page.evaluate((targets) => new Promise((resolve) => {
    const req = window.indexedDB.open('st_zip_converter_db');
    req.onerror = () => resolve({ ok: false, why: 'open-failed' });
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction('files', 'readwrite');
        const store = tx.objectStore('files');
        const deleted = [];
        const all = store.getAll();
        all.onsuccess = () => {
          for (const rec of all.result || []) {
            if (!targets.includes(rec.name)) continue;
            store.delete(rec.id);
            deleted.push({ id: rec.id, name: rec.name, size: rec.size, origin: rec.origin || null });
          }
        };
        tx.oncomplete = () => resolve({ ok: true, removed: deleted.length, deleted });
        tx.onerror = () => resolve({ ok: false, why: 'tx-error' });
      } catch (e) { resolve({ ok: false, why: String(e && e.message) }); }
    };
  }), names).catch((e) => ({ ok: false, why: String(e && e.message) }));
}

// ─────────────────────────────── 主流程 ───────────────────────────────

/** 流式 sha256（大包不进内存） */
function sha256Of(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(filePath).on('data', (c) => h.update(c))
      .on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/** 包内条目数（只读中央目录） */
async function entryCountOf(filePath) {
  const { createNodeIo } = require('./lib/node-zip-io.cjs');
  const io = await createNodeIo();
  const reader = await io.openReader(filePath);
  const n = reader.totalEntries;
  await reader.close();
  return n;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }

  // —— 启动期断言（不满足一律非零退出，绝不"跑到一半才发现"）——
  const inst = assertSource(args.source);
  if (!args.layout) {
    console.error('✗ --layout 必填：st|tt|l|pt（无默认值）');
    process.exit(2);
  }
  if (!['st', 'tt', 'l', 'pt'].includes(args.layout)) {
    console.error(`✗ 未知 --layout：${args.layout}（登记可选：st|tt|l|pt）`);
    process.exit(2);
  }
  const ownLayout = hostOwnLayout(inst.host);
  if (!ownLayout) {
    console.error(`✗ 源实例 ${inst.id} 的宿主形态是 ${inst.host} —— 本工具只驱动 st / luker 宿主（插件工作台须落在有磁盘插件目录的宿主上）`);
    process.exit(2);
  }
  if (args.raw && args.layout !== ownLayout) {
    console.error(`✗ --raw 要求 --layout 等于宿主自身布局码（${inst.host} → ${ownLayout}），收到 ${args.layout}`);
    console.error('  原因：只有「目标布局 == 宿主布局」且不剪内置资产、含 backups 时，插件才原样透传（index.js 的 needsTransform 三条件）');
    process.exit(2);
  }
  if (args.raw) {
    // pristine 的两个前提，与 index.js:1695-1699 的 needsTransform 求值一一对应
    args.includeBackups = true;
    args.pruneBuiltin = false;
  }

  const outDir = args.out ? path.resolve(args.out) : path.join(os.homedir(), 'Downloads');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(args.readingsDir, { recursive: true });

  console.log(`[produce] 源实例 id=${inst.id} side=${inst.side} host=${inst.host} port=${inst.port} url=${inst.url}`);
  console.log(`[produce] 目标布局=${args.layout}${args.raw ? '（--raw：原样宿主包，不转换）' : ''} 落点=${outDir}`);

  // —— R-20 硬门禁（D1.4）——
  const r20 = assertR20(inst);
  console.log(`[produce] R-20 过：实例插件 ${r20.instanceHead} == 工作区 ${r20.workspaceHead}`);

  const pw = loadPlaywright();
  const pwVersion = warnOnVersionDrift(pw);
  const ctx = await pw.chromium.launchPersistentContext(inst.profile, {
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 950 },
  });
  ctx.setDefaultTimeout(30_000);

  const rec = { pluginConsoleErrors: [], pluginFailures: [], pageErrors: [] };
  const t0 = Date.now();
  const phases = {};
  const stamp = () => Number(((Date.now() - t0) / 1000).toFixed(1));
  let artifact = null;
  let logTail = '';
  let knobs = null;
  let queueBefore = null;
  let queueAfter = null;
  let failure = null;
  let progressTimer = null;
  let narrowing = null;

  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const url = (m.location() && m.location().url) || '';
      if (url.includes(PLUGIN_SLUG) || String(m.text()).includes(PLUGIN_SLUG)) {
        rec.pluginConsoleErrors.push({ text: m.text(), url });
      }
    });
    page.on('pageerror', (e) => {
      const entry = { text: String((e && e.message) || e), stack: String((e && e.stack) || '') };
      rec.pageErrors.push(entry);
      if (entry.stack.includes(PLUGIN_SLUG) || entry.text.includes(PLUGIN_SLUG)) rec.pluginConsoleErrors.push(entry);
    });
    page.on('requestfailed', (r) => {
      if (r.url().includes(PLUGIN_SLUG)) rec.pluginFailures.push({ url: r.url(), error: (r.failure() || {}).errorText || '' });
    });
    page.on('response', (r) => {
      if (r.status() >= 400 && r.url().includes(PLUGIN_SLUG)) rec.pluginFailures.push({ url: r.url(), status: r.status() });
    });

    // ① 打开实例页面（有界等待）
    await page.goto(inst.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const splashGone = await waitInPage(page, () => {
      const ds = Array.from(document.querySelectorAll('dialog[open]'));
      return !ds.some((d) => d.querySelector('#loader') || /正在初始化/.test(d.textContent || ''));
    }, null, 90_000, '宿主 splash 关闭');
    phases.splash = stamp();
    if (!splashGone) console.log('  · ⚠ splash 未在窗口内关闭 —— 页内 click 不受其影响，继续');

    // ② 插件就绪（§11.8-1：宿主 DOM 就绪 ≠ 插件已注入；判据是 #env-badge 脱离模板初值）
    const pluginReady = await waitInPage(page, () => {
      const el = document.getElementById('env-badge');
      if (!el) return false;
      const t = el.textContent.trim();
      return t.length > 0 && t !== '检测中...';
    }, null, Math.min(120_000, args.timeout), '插件初始化（#env-badge 脱离模板初值）');
    if (!pluginReady) throw new Error('插件未完成初始化（规范 §11.7 宿主冷启动窗口：可能需再加载一次）');
    phases.pluginReady = stamp();
    console.log(`[produce] 插件就绪（t+${phases.pluginReady}s）`);

    const workbench = await page.evaluate(() => ({
      drawer: Boolean(document.getElementById('st_zip_converter_settings')),
      app: Boolean(document.querySelector('.st-converter-drawer-app')),
      badge: (document.getElementById('env-badge') || {}).textContent || null,
    }));
    console.log(`[produce] 工作台注入：drawer=${workbench.drawer} app=${workbench.app} badge=${JSON.stringify(workbench.badge)}`);

    await expandLog(page);   // 不展开则日志面板**不追加任何行**（读不到证据）

    // ③ 设旋钮 + 回读
    knobs = await setKnobs(page, {
      layout: args.layout,
      compression: args.compression,
      gitMode: args.gitMode,
      extensionMode: args.extensionMode,
      includeBackups: args.includeBackups,
      pruneBuiltin: args.pruneBuiltin,
      keepDevFiles: args.keepDevFiles,
    });
    console.log('[produce] 旋钮回读：', JSON.stringify(knobs.readBack));
    if (knobs.log.length) console.log('[produce] 旋钮设置告警：', JSON.stringify(knobs.log));
    const rb = knobs.readBack;
    const knobMismatch = [];
    if (rb.target !== args.layout) knobMismatch.push(`target ${rb.target}≠${args.layout}`);
    if (rb.compression !== String(args.compression)) knobMismatch.push(`compression ${rb.compression}≠${args.compression}`);
    if (rb.gitMode !== args.gitMode) knobMismatch.push(`gitMode ${rb.gitMode}≠${args.gitMode}`);
    if (rb.extensionMode !== args.extensionMode) knobMismatch.push(`extensionMode ${rb.extensionMode}≠${args.extensionMode}`);
    if (rb.includeBackups !== args.includeBackups) knobMismatch.push(`includeBackups ${rb.includeBackups}≠${args.includeBackups}`);
    if (rb.pruneBuiltin !== args.pruneBuiltin) knobMismatch.push(`pruneBuiltin ${rb.pruneBuiltin}≠${args.pruneBuiltin}`);
    if (rb.keepDevFiles !== args.keepDevFiles) knobMismatch.push(`keepDevFiles ${rb.keepDevFiles}≠${args.keepDevFiles}`);
    if (rb.splitInput !== '') knobMismatch.push(`splitInput ${JSON.stringify(rb.splitInput)}≠""`);
    if (knobMismatch.length) throw new Error(`旋钮未生效（回读不符）：${knobMismatch.join('; ')}`);

    // ③b 按类目**收窄** selection（可选，但真源 Real Luker 必须用 —— 见 --deselect 说明）
    if (args.deselect.length) {
      narrowing = await narrowSelection(page, args.deselect);
      console.log(`[produce] 类目收窄：${JSON.stringify(narrowing)}`);
      if (!narrowing.ok) throw new Error(`类目收窄失败（未生效的键：${JSON.stringify(narrowing.notDeselected || narrowing.why)}）`);
      const selAfter = await readSelection(page);
      knobs.categories = selAfter;
      knobs.categoryCardCount = Object.keys(selAfter).length;
    }

    // ④ 等「从宿主拉取」可用（禁用态 click() 是静默空操作 —— 必须回读）
    const btnOk = await waitInPage(page, () => {
      const b = document.getElementById('btn-host-fetch');
      return Boolean(b) && !b.disabled;
    }, null, Math.min(120_000, args.timeout), '#btn-host-fetch 可用');
    const btnState = await readFetchButton(page);
    console.log('[produce] 拉取按钮：', JSON.stringify(btnState));
    if (!btnOk || !btnState.present || btnState.disabled) throw new Error('「从宿主拉取」不可用');

    queueBefore = await readQueue(page);
    console.log(`[produce] 待导出区基线：${queueBefore.count} 条`);

    // ⑤ 点「从宿主拉取」（页内 click，绕开模态弹窗的指针拦截 —— 见文件头）
    await page.evaluate(() => document.getElementById('btn-host-fetch').click());
    phases.fetchStart = stamp();
    console.log(`[produce] 已触发宿主拉取（t+${phases.fetchStart}s）…`);

    // 长跑心跳：插件把百分比与阶段文案写在 `#progress-percent` / `#status-label`。
    // 不心跳的话，真源包 1.6 GB 的拉取会有**好几分钟毫无输出**（首跑实测 t+23.7s → t+339.8s 全静默），
    // 用的人无从判断是「在跑」还是「挂了」。
    progressTimer = setInterval(() => {
      page.evaluate(() => ({
        pct: (document.getElementById('progress-percent') || {}).textContent || '',
        label: (document.getElementById('status-label') || {}).textContent || '',
        queue: document.querySelectorAll('#export-queue-panel .export-queue-item').length,
      })).then((s) => {
        console.log(`  [t+${stamp()}s] ${String(s.pct).trim()} ${String(s.label).trim()} ｜ 待导出区 ${s.queue} 条`);
      }).catch(() => { /* 页面在导航/关闭时不打扰 */ });
    }, 20_000);

    // ⑥ 等统一文件树确认栏 → 确认（不确认则流程停在等待里，永远出不来）
    const barShown = await waitInPage(page, () => {
      const bar = document.getElementById('host-tree-confirm-bar');
      return Boolean(bar) && bar.hidden === false;
    }, null, args.timeout, '统一文件树确认栏出现');
    logTail = await readLog(page);
    if (!barShown) throw new Error(`等不到文件树确认栏。日志尾部：${JSON.stringify(logTail.slice(-400))}`);
    phases.treeConfirmShown = stamp();
    console.log(`[produce] 文件树确认栏就绪（t+${phases.treeConfirmShown}s），点确认…`);
    await page.evaluate(() => {
      const b = document.getElementById('btn-host-tree-confirm');
      if (!b) throw new Error('缺 #btn-host-tree-confirm');
      b.click();
    });

    // ⑦ 等产物入待导出区（计数增加）
    const enqueued = await waitInPage(page, (base) => {
      const rows = document.querySelectorAll('#export-queue-panel .export-queue-item');
      return rows.length > base;
    }, queueBefore.count, args.timeout, '产物进入待导出区');
    phases.enqueued = stamp();
    queueAfter = await readQueue(page);
    logTail = await readLog(page);
    console.log(`[produce] 待导出区：${queueAfter.count} 条（新条目 ${JSON.stringify(queueAfter.last)}，t+${phases.enqueued}s）`);
    if (!enqueued) throw new Error(`等不到产物入区。日志尾部：${JSON.stringify(logTail.slice(-400))}`);

    const producedName = queueAfter.last && queueAfter.last.name ? queueAfter.last.name : `${args.source}-${args.layout}.zip`;
    const destPath = path.join(outDir, producedName);
    const partialPath = `${destPath}.partial`;

    // ⑧ 点该条目的「下载」→ 捕获 Playwright download 事件
    //    （重名则先移除旧的，避免"看起来下载成功、其实是上一轮的包"）
    if (fs.existsSync(destPath)) fs.rmSync(destPath);
    const dlPromise = page.waitForEvent('download', { timeout: args.timeout });
    const clicked = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#export-queue-panel .export-queue-item'));
      const last = rows[rows.length - 1];
      const btn = last && last.querySelector('.eq-buttons button.download');
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!clicked) throw new Error('找不到末条的「下载」按钮（导出区渲染形态变了？）');
    const dl = await dlPromise;
    await dl.saveAs(partialPath);
    // ⚠️ `suggestedFilename` 在本版 Playwright 里是**方法**不是属性 ——
    // 首版当属性用，读到的是函数源码（实测打印出 `suggestedFilename() { return this._suggestedFilename; }`）。
    const suggested = typeof dl.suggestedFilename === 'function' ? dl.suggestedFilename() : dl.suggestedFilename;
    if (suggested && suggested !== producedName) {
      console.log(`  · ℹ 浏览器建议名 ${suggested} 与条目名 ${producedName} 不同（以条目名为准）`);
    }
    fs.renameSync(partialPath, destPath);
    phases.downloaded = stamp();

    // ⑨ 读数
    const bytes = fs.statSync(destPath).size;
    const [sha256, entryCount] = await Promise.all([sha256Of(destPath), entryCountOf(destPath)]);
    artifact = { file: producedName, path: destPath, bytes, entryCount, sha256, suggestedFilename: suggested };
    console.log(`[produce] 产物 ${producedName}：${MB(bytes)} MB / ${entryCount} 条目 / t+${phases.downloaded}s`);
    console.log(`[produce] sha256 ${sha256}`);

    const stashCleanup = args.cleanupStash ? await cleanupStash(page, [producedName]) : { ok: true, skipped: true };
    console.log(`[produce] 入库记录清理：${JSON.stringify(stashCleanup)}`);
    phases.done = stamp();

    const record = {
      tool: 'produce-via-plugin.cjs',
      task: '09-27-plugin-driven-instance-sync',
      mode: args.raw ? 'raw（原样宿主包）' : `转换（目标布局 ${args.layout}）`,
      source: { id: inst.id, side: inst.side, host: inst.host, port: inst.port, url: inst.url, profile: path.basename(inst.profile) },
      r20: { ...r20, instancePluginDir: path.relative(REPO_ROOT, r20.pluginDir) },
      knobs: { requested: { layout: args.layout, compression: args.compression, gitMode: args.gitMode, extensionMode: args.extensionMode, includeBackups: args.includeBackups, pruneBuiltin: args.pruneBuiltin, keepDevFiles: args.keepDevFiles }, readBack: rb, warnings: knobs.log },
      selection: { hasCategoryCards: knobs.categoryCardCount > 0, categories: knobs.categories, note: knobs.categoryCardCount === 0 ? '无类目卡片（未渲染计划）⇒ selection 取模块默认：除 cache / appPrivate 外全选（category-filter.js:22-36）' : '', deselected: args.deselect, narrowing },
      workbench,
      artifact,
      stashCleanup,
      timings: { totalSeconds: phases.done, phases },
      logTail: logTail.slice(-4000),
      pluginConsoleErrors: rec.pluginConsoleErrors.slice(0, 20),
      pluginFailures: rec.pluginFailures.slice(0, 20),
      playwright: pwVersion,
      finishedAt: new Date().toISOString(),
    };
    const label = args.readingsDir
      ? path.join(args.readingsDir, `produce-${inst.id}-${args.raw ? 'raw' : args.layout}.json`)
      : path.join(outDir, `produce-${inst.id}-${args.layout}.json`);
    fs.writeFileSync(label, JSON.stringify(record, null, 2), 'utf8');
    console.log(`[produce] 读数 → ${label}`);
  } catch (err) {
    failure = err;
    logTail = logTail || '';
    // 中止要走出那条分支自己的出口（§11.8-4）：文件树确认阶段是 #btn-host-tree-cancel
    try {
      const page = ctx.pages()[0];
      if (page) {
        logTail = await readLog(page);
        await page.evaluate(() => {
          const cancel = document.getElementById('btn-host-tree-cancel');
          if (cancel && cancel.getBoundingClientRect().width > 0) { cancel.click(); return; }
          const tc = document.getElementById('tc-abort');
          if (tc) tc.click();
        });
      }
    } catch { /* 收尾失败不掩盖原始错误 */ }
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    await ctx.close().catch(() => {});
  }

  if (failure) {
    console.error(`\n✗ 产包失败：${failure.message}`);
    if (logTail) console.error(`  日志尾部：${JSON.stringify(logTail.slice(-600))}`);
    const perr = rec.pluginConsoleErrors.length + rec.pluginFailures.length;
    if (perr) console.error(`  本插件报错/失败请求 ${perr} 条：${JSON.stringify([...rec.pluginConsoleErrors.slice(0, 3), ...rec.pluginFailures.slice(0, 3)])}`);
    process.exit(1);
  }
  console.log(`\n[produce] 完成。产物=${artifact.path}`);
})().catch((e) => {
  console.error('产包器异常：', e);
  process.exit(1);
});
