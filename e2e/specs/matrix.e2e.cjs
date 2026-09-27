/**
 * 功能矩阵 spec —— 覆盖设计文档 §3.4 的 M-1…M-9 九条路径
 *
 * 与冒烟 spec 的分工：冒烟只验「插件挂上来了、注入点齐全、本插件零报错」，
 * 本 spec 验**功能真的能跑**（宿主检测 / 注入幂等 / 计划预览 / 四目标转换 /
 * 待导出区 / 落库 origin / 断点续传 / 批量恢复能力 / 分割）。
 *
 * ## 判定纪律（承袭本任务既定做法）
 *  - **先证明判定能抓到违规，再相信它报 0**：每条路径都要有一个「读数必须非空/非零」
 *    的前置断言，避免把「什么都没发生」判成通过。
 *  - **有界等待**（L1-MR-7）：宿主 DOM 与 Worker 都异步，一律 `waitForFunction` 带超时，
 *    不用瞬时值。
 *  - **依赖注入优先**：凡能通过 DOM 契约观察的，不读模块内部；确需内部读数时用
 *    `page.evaluate` 读**插件自己渲染出来的** DOM/IndexedDB，不臆造内部符号。
 *
 * ## 源包夹具
 * 用 `fixtures/gen.js` 的 `generateAll()` 现场生成三个迷你包（2.5–3.5 KB），落
 * `test-results/fixtures/`（已被 `.gitignore` 覆盖，**不入库**）。确定性内容，
 * 覆盖角色卡/聊天/世界书/预设/扩展等类目 —— 使断言可以写具体数字。
 *
 * ## 后缀
 * 必须是 `.e2e.cjs`：`.spec.cjs` 会被 vitest 当单测收集（实测踩过，见 `run.cjs` 头注）。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const SLUG = 'st-zip-converter';
const FIXTURE_DIR = path.resolve(__dirname, '../../test-results/fixtures');
const DRAWER_ID = 'st_zip_converter_settings';

/** 现场生成夹具（进程内缓存，多个 spec 共用） */
let fixturesPromise = null;
function ensureFixtures() {
  if (!fixturesPromise) {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    const genUrl = pathToFileURL(path.resolve(__dirname, '../../fixtures/gen.js')).href;
    fixturesPromise = import(genUrl).then((m) => m.generateAll(FIXTURE_DIR));
  }
  return fixturesPromise;
}

/**
 * 打开扩展设置面板里的抽屉，让工作台真正渲染。
 * 抽屉态是**插件态唯一的常驻形态**，故矩阵一律在抽屉态下驱动。
 * @returns 打开结果（失败时给出原因，供断言使用）
 */
async function openDrawer(page) {
  return page.evaluate((drawerId) => {
    const drawer = document.getElementById(drawerId);
    if (!drawer) return { ok: false, reason: '抽屉元素不存在（插件未挂载？）' };
    const content = drawer.querySelector(':scope > .inline-drawer-content');
    if (content) content.style.display = 'block';
    const app = drawer.querySelector('.st-converter-drawer-app');
    if (!app) return { ok: false, reason: '抽屉内无 .st-converter-drawer-app' };
    return { ok: true };
  }, DRAWER_ID);
}

/**
 * 等插件完成初始化 —— **有界等待，不可瞬时判定**（L1-MR-7）
 *
 * 实测（2026-09-26，`test-results/_probe-luker` 同形探针）：Luker `:8003` 上
 * `#env-badge` 要到 **t≈14 s** 才脱离模板初始值 `检测中...`（`panels` 同时 0→3）。
 * 首版用瞬时值断言，于是「平台判定」与「计划预览」在 Luker 上全红 —— **是测量时机问题，
 * 不是插件缺陷**。本仓库在冒烟 spec 已踩过同一形态（菜单项 t≈7 s）。
 *
 * @returns {boolean} 是否在超时内就绪
 */
async function waitForPluginReady(page, timeout = 40_000) {
  try {
    await page.waitForFunction(() => {
      const el = document.getElementById('env-badge');
      if (!el) return false;
      const txt = el.textContent.trim();
      // 模板初始值是「检测中...」；一旦首帧已应用平台判定就会变掉
      return txt.length > 0 && txt !== '检测中...';
    }, null, { timeout });
    return true;
  } catch { return false; }
}

/** 读一条计数读数（形如 `#count-chars`） */
async function readCount(page, id) {
  return page.evaluate((elId) => {
    const el = document.getElementById(elId);
    if (!el) return null;
    const n = Number(String(el.textContent).replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }, id);
}

/** 等计划摘要条匹配给定形态 —— 有界等待（L1-MR-7） */
async function waitForPlanBar(page, pattern, timeout = 40_000) {
  try {
    await page.waitForFunction((src) => {
      const bar = document.getElementById('plan-summary-bar');
      if (!bar) return false;
      const txt = bar.textContent.replace(/\s+/g, ' ');
      return new RegExp(src).test(txt) || new RegExp(src).test(
        (document.getElementById('output-estimate-text') || {}).textContent || '',
      );
    }, pattern.source, { timeout });
    return true;
  } catch { return false; }
}

/** 读计划摘要条与预计产物文本 */
async function readPlanBar(page) {
  return page.evaluate(() => {
    const norm = (el) => (el ? el.textContent.trim().replace(/\s+/g, ' ') : '');
    return {
      bar: norm(document.getElementById('plan-summary-bar')),
      estimate: norm(document.getElementById('output-estimate-text')),
    };
  });
}

/**
 * 按**真实用户路径**打开插件工作台，并确认它真的可见。
 *
 * 路径（两宿主共通，2026-09-26 实地探明）：
 *   ① 点宿主顶栏的 `#extensionsMenuButton`（魔法棒图标）→ 菜单弹出
 *   ② 点菜单里带 `.drawer-opener` 的项 → `#rm_extensions_block` 由 `none` 变 `block`
 *      ⚠️ 文案**跨宿主不同**：ST 是「扩展程序」、Luker 是「扩展」⇒ 只能按 class 定位，
 *      按文字定位会在 Luker 上静默失效（实测 `n:0` 匹配不到）。
 *      ⚠️ class 名以**完整串**为准：`.drawer-opener` 的后缀是 `-opener`，
 *      先前一次探针用 `slice(0,40)` 打印 class，恰好把它截成 `.drawer-open`，
 *      我据此写了错选择器、两实例全红 —— **截断的输出会制造假事实**，
 *      dump 时必须打印完整 class（或明确标注截断长度）。
 *      ⚠️ 判可见**不能用 `offsetParent`**：宿主菜单是 `position:fixed`，
 *      fixed 元素的 `offsetParent` 恒为 `null` ⇒ 会把可见按钮判成不可见（实测踩过）。
 *   ③ 展开插件自己的 `#st_zip_converter_settings` inline-drawer
 *      —— **这一步不可省**：宿主的扩展抽屉打开 ≠ 插件抽屉展开，
 *      不展开则抽屉内所有控件 `getBoundingClientRect()` 仍是 0×0，
 *      Playwright 的 click / selectOption 会以「element is not visible」超时。
 *
 * @returns {{hostDrawer:boolean, pluginDrawer:boolean, menuItem:string, visible:boolean, reason?:string}}
 */
async function openWorkbench(page) {
  const out = { hostDrawer: false, pluginDrawer: false, menuItem: '', visible: false };

  // ① 宿主扩展菜单
  const menuClick = await page.click('#extensionsMenuButton').then(() => 'ok').catch((e) => e.message.slice(0, 80));

  // ② 菜单里的抽屉开关（.drawer-opener）；文案跨宿主不同，故按 class 找，
  //    有多个候选时优先取文字含「扩展」的（仍不写死「扩展程序」四个字）。
  let picked = null;
  let diag = null;
  for (let i = 0; i < 40 && !picked; i += 1) {
    const probe = await page.evaluate(() => {
      const sized = (e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const all = Array.from(document.querySelectorAll('.drawer-opener'));
      const cands = all.filter(sized);
      if (!cands.length) {
        return {
          clicked: false,
          totalDrawerOptener: all.length,
          sized: 0,
          // 菜单是否弹出：数一数有尺寸的、且文字含「扩展」的菜单项
          extish: Array.from(document.querySelectorAll('button, .menu_button, .list-group-item'))
            .filter((e) => sized(e) && /扩展/.test(e.textContent || ''))
            .map((e) => `${e.tagName} "${e.textContent.trim().slice(0, 16)}" .${(e.className || '').toString().slice(0, 50)}`)
            .slice(0, 4),
        };
      }
      const pref = cands.find((e) => /扩展/.test(e.textContent || ''));
      const el = pref || cands[0];
      el.click();
      return { clicked: true, text: (el.textContent || '').trim().slice(0, 20) };
    }).catch((e) => ({ clicked: false, error: e.message.slice(0, 80) }));
    if (probe.clicked) picked = { text: probe.text };
    else { diag = probe; await page.waitForTimeout(250); }
  }
  out.menuItem = picked ? picked.text : '';
  out.menuClick = menuClick;
  out.diag = diag;

  // 宿主抽屉容器真的打开了（有界等待，扩展面板是异步滑出的）
  try {
    await page.waitForFunction(() => {
      const b = document.getElementById('rm_extensions_block');
      return Boolean(b) && getComputedStyle(b).display !== 'none';
    }, null, { timeout: 15_000 });
    out.hostDrawer = true;
  } catch { out.hostDrawer = false; }

  // ③ 插件自己的 inline-drawer
  const plugin = await openDrawer(page);
  out.pluginDrawer = plugin.ok;
  if (!plugin.ok) out.reason = plugin.reason;

  // 可见性验收：工作台第一个控件有真实尺寸（这是后面所有真实交互的前提）
  try {
    await page.waitForFunction(() => {
      const el = document.getElementById('target-select');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }, null, { timeout: 15_000 });
    out.visible = true;
  } catch { out.visible = false; }

  return out;
}

/**
 * 把工作台清回「无源包」初态。
 *
 * **为什么必须做**：E2E 用的是**持久化** profile（`.pw-profile-dev`），而插件会把当前工作区
 * 状态写进 IndexedDB 的 `workspace` store（`active_session`）并在下次加载时恢复
 * （`restoreWorkspaceState`）。于是**同一个 spec 在两轮之间、两个实例之间会从不同初态起跑**：
 * 实测症状 —— 喂进新源包后计划读数纹丝不动（仍显示上一轮的包），
 * `#stash-list` 一张卡都没有，`targetSelect` 一会儿是 `native` 一会儿是 `l`。
 * 这使得「可重跑」（AC-5）与「分支断言」都不成立。
 *
 * 做法：删掉 `active_session` 会话记录后**重载页面**，让插件以空工作区启动。
 * 只动 `workspace` store —— `files` store 里的历史记录**不删**（它们不参与初态推断，
 * 而删除会波及用户在该 profile 里的既有测试数据，风险不对等）。
 *
 * @returns {boolean} 清理动作是否成功发出（重载后的就绪由调用方的有界等待负责）
 */
async function resetWorkspace(page) {
  const cleared = await page.evaluate(() => new Promise((resolve) => {
    let req;
    try { req = window.indexedDB.open('st_zip_converter_db'); } catch { resolve(false); return; }
    req.onerror = () => resolve(false);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction('workspace', 'readwrite');
        tx.objectStore('workspace').delete('active_session');
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch { resolve(false); }
    };
  }));
  if (cleared) await page.reload({ waitUntil: 'domcontentloaded' });
  return cleared;
}

/** 确定性高熵字节：SHA-256 计数器模式（不可压缩，故转换/分卷都有真实工作量） */
function detBytes(len, seed) {
  const outBuf = Buffer.alloc(len);
  let off = 0;
  let ctr = 0;
  while (off < len) {
    const h = crypto.createHash('sha256').update(`${seed}:${ctr}`).digest();
    const n = Math.min(h.length, len - off);
    h.copy(outBuf, off, 0, n);
    off += n;
    ctr += 1;
  }
  return outBuf;
}

/**
 * 造「大 ST 布局包」：`chats/` 下 `count` 个 1 MB 高熵条目。
 * 缓存判据 = 存在且 ≥ `minBytes`（确定性内容 ⇒ 可复用、可重跑）。
 */
async function ensureBigFixture(fileName, count, minBytes, seedPrefix) {
  const out = path.join(FIXTURE_DIR, fileName);
  if (fs.existsSync(out) && fs.statSync(out).size >= minBytes) return out;

  const genUrl = pathToFileURL(path.resolve(__dirname, '../../fixtures/gen.js')).href;
  const ioUrl = pathToFileURL(path.resolve(__dirname, '../../src/core/zip-io.js')).href;
  const [{ stEntries }, { zipIo }] = await Promise.all([import(genUrl), import(ioUrl)]);

  const MB = 1024 * 1024;
  const writer = await zipIo.createWriter(out);
  for (const [name, data] of stEntries()) await writer.add(name, data);
  for (let i = 0; i < count; i += 1) {
    // 每份用不同种子 ⇒ 内容互不相同（防按内容去重），且各自不可压缩
    await writer.add(
      `chats/Fixture Character/${seedPrefix}-${String(i).padStart(3, '0')}.jsonl`,
      detBytes(MB, `${seedPrefix}-${i}`),
    );
  }
  await writer.close();
  return out;
}

/**
 * 生成**放大夹具**（M-9 需要切出多分卷）
 *
 * 迷你夹具 2.5 KB：转换是毫秒级 —— 切不出第二个分卷。
 * 故此处造一个 ~6 MB 的 ST 布局包：`chats/` 下 6 个 1 MB 文件。
 *
 * ⚠️ 内容必须是**真正高熵**的字节：先用 LCG（`seed & 0xff`）生成过一版，
 * 结果 6 MB「随机」数据被 deflate 压到 **13 KB** —— 因为 LCG 的**低位周期极短**
 * （低位比特周期 2^k，取最低 8 位周期只有 ~256），序列高度可压缩，
 * 于是转换依旧瞬间完成、分卷也切不出来（实测：3 MB 输入 → 落盘 13582 字节）。
 * 现改用 **SHA-256 计数器模式**（`sha256("<seed>:<ctr>")` 逐块拼接）：
 * 输出不可压缩、且**完全确定性** ⇒ 包真的 ~6 MB，spec 仍可重跑。
 */
async function ensureLargeFixture() {
  return ensureBigFixture('fixture-large-st.zip', 6, 4 * 1024 * 1024, 'bulk');
}

/**
 * **暂停窗口夹具**（M-7b 用，2026-09-27 新增）
 *
 * 为什么 6 MB 不够：M-7b 要验「转换中途点暂停 → 续传」，而 6 MB 的转换在**数百毫秒**内结束 ——
 * 等控制条出现的往返里转换就完了，pause 会点在已隐藏的按钮上（**假红或假绿**）。
 * ⇒ 造 ~48 MB / 48 个 1 MB 条目，转换需**数秒**，pause 有可靠窗口；
 * 且条目数多 ⇒ 断点清单里会攒下若干条已完成条目 ⇒ 续传时能真的跳过（`totals.resumed > 0`）。
 */
async function ensurePauseFixture() {
  return ensureBigFixture('fixture-pause-st.zip', 48, 40 * 1024 * 1024, 'pausebulk');
}

module.exports = {
  name: '功能矩阵：宿主检测 / 计划预览',
  requiresInstances: ['dev-st', 'dev-luker'],

  async run(t, h) {
    const { page } = h;

    // —— 0a. 先把工作台清回初态（持久化 profile 会恢复上一轮的源包/目标 ⇒ 不清则不可重跑） ——
    const reset = await resetWorkspace(page);
    t.ok('工作台已清回初态（清 workspace 会话记录并重载页面）', reset);

    // —— 0. 前置：等插件完成初始化（有界等待，见上方 helper 注释） ——
    const ready = await waitForPluginReady(page);
    t.ok('插件在 40s 内完成初始化（#env-badge 脱离「检测中...」）', ready,
      `badge="${await page.evaluate(() => {
        const el = document.getElementById('env-badge');
        return el ? el.textContent.trim() : '(元素不存在)';
      })}"`);

    const fixtures = await ensureFixtures();
    t.ok('源包夹具已生成（fixtures/gen.js）',
      Boolean(fixtures['fixture-st.zip'] && fs.existsSync(fixtures['fixture-st.zip'])));
    t.ok('夹具包非空（> 1 KB）', fs.statSync(fixtures['fixture-st.zip']).size > 1024,
      `${fs.statSync(fixtures['fixture-st.zip']).size} bytes`);

    // ================= M-1 宿主检测 =================
    const badge = await page.evaluate(() => {
      const el = document.getElementById('env-badge');
      return el ? { text: el.textContent.trim(), color: el.style.color || '' } : null;
    });

    t.ok('M-1 环境徽标存在（#env-badge）', Boolean(badge));
    t.ok('M-1 环境徽标已脱离模板初始值（检测真的跑完了）',
      Boolean(badge && badge.text !== '检测中...'), `badge="${badge && badge.text}"`);
    const platformWord = h.instanceId === 'dev-luker' ? 'Luker' : 'SillyTavern';
    t.ok(`M-1 平台判定与实例匹配（期望含「${platformWord}」）`,
      Boolean(badge && badge.text.includes(platformWord)), `badge="${badge && badge.text}"`);
    // 读数（不判定）：版本号是**按宿主可得性**渲染的，两实例形态不同（实测 Luker 有、
    // ST 无）—— 故只报告，不写死断言（写死会变成臆造契约）。
    t.log(`  · 徽标读数：badge="${badge && badge.text}" color=${badge && badge.color}`);

    // 归一契约（`luker→l`）的可见证据：目标下拉里存在 native 选项，
    // 其语义就是「用 hostLayoutCode(平台码) 求有效目标」（index.js:193/732-739）。
    const nativeOpt = await page.evaluate(() => {
      const o = document.querySelector('#target-select option[value="native"]');
      return o ? { text: o.textContent.trim(), present: true } : { present: false };
    });
    t.ok('M-1 目标下拉含 native（宿主原生）选项 —— 平台码→布局码归一的入口', nativeOpt.present,
      `text="${nativeOpt.text}"`);

    // ================= 按真实用户路径打开工作台 =================
    const opened = await openWorkbench(page);
    t.ok('宿主扩展抽屉已打开（`.drawer-opener` 菜单项生效）', opened.hostDrawer,
      `菜单项="${opened.menuItem}" 菜单点击=${opened.menuClick}`);
    if (!opened.hostDrawer) {
      t.log(`      ! 诊断：${JSON.stringify(opened.diag)}`);
    }
    t.ok('插件工作台抽屉已展开（#st_zip_converter_settings）', opened.pluginDrawer,
      opened.reason || '');
    t.ok('工作台控件**真实可见**（target-select 有尺寸）—— 后续一切真实交互的前提',
      opened.visible);
    t.log(`  · 打开路径：宿主菜单项「${opened.menuItem}」`);

    // ================= M-3 计划预览 =================
    // 喂 ST 布局迷你包 → 插件应产出计划并在类目面板渲染。
    // 断言面取自 `renderCategoryStats`（category-filter.js:113-…）真正更新的元素：
    // `#plan-summary-bar` / `#action-stats-badges` / `#output-estimate-text` / `#category-checkboxes`。
    // ⚠️ 首版断言的是 `#count-chars` 等 —— 那几个属于`#module-grid`（宿主拉取路径），
    // **不参与外部包的计划渲染**，故恒为 0；是断言选错元素，不是缺陷。
    const input = await page.$('#file-input');
    t.ok('M-3 文件输入控件存在（#file-input）', Boolean(input));
    if (input) {
      await input.setInputFiles(fixtures['fixture-st.zip']);
    }

    let planReady = false;
    try {
      await page.waitForFunction(() => {
        const bar = document.getElementById('plan-summary-bar');
        return Boolean(bar) && bar.style.display !== 'none' && bar.textContent.trim().length > 0;
      }, null, { timeout: 40_000 });
      planReady = true;
    } catch { planReady = false; }
    t.ok('M-3 计划预览在 40s 内渲染（#plan-summary-bar 可见且非空）', planReady);

    // —— 显式指定目标，**不依赖插件的自动推断** ——
    // 实测教训（2026-09-26）：喂包后插件会把 target 切成 `l`（index.js:1475
    // `if (item.detection.layout === 'st') targetSelect.value = 'l'`），但该分支只在
    // `!currentFile` 时执行 ⇒ **同一 spec 在两实例上跑出了不同 target**
    // （Dev ST 因工作区残留状态保持 native，Dev Luker 被切成 l），
    // 于是「合成 1 / 产物 8」与「无合成 / 产物 7」两个读数一红一绿。
    // 这是**测试对隐式状态上瘾**，不是缺陷。矩阵要可重跑 ⇒ 每步都显式设定期望目标。
    // —— 先取「宿主原生格式」（native）这一支的读数 ——
    // ⚠️ 喂入 ST 布局包后插件会**自动把 target 切成 `l`**（`index.js:1475`
    //   `if (item.detection.layout === 'st') targetSelect.value = 'l'`），
    //   故必须**显式切回 `native`** 才拿得到 native 分支的真实读数
    //   （否则拿到的是 l 的读数，而下面那条「native 与显式布局码一致」的断言就名不副实了）。
    await page.selectOption('#target-select', 'native');
    // 修 N-1 后 `native` 会归一到宿主的布局码，故与显式宿主目标**同形**（产物 8，含 1 个合成项）
    await waitForPlanBar(page, /预计产物[:：]?\s*8\s*个文件/);
    const norm = await readPlanBar(page);
    t.log(`  · [target=native] ${norm.bar}`);

    const setTarget = async (value, pattern) => {
      await page.selectOption('#target-select', value);
      return waitForPlanBar(page, pattern);
    };

    // ===== 分支① 目标 = Luker（源 ST 布局 ⇒ 需合成 settings） =====
    const lReady = await setTarget('l', /预计产物[:：]?\s*8\s*个文件/);
    t.ok('M-3 切到 Luker 目标后计划在 40s 内重算（预计产物 8）', lReady,
      JSON.stringify(await readPlanBar(page)));

    const planL = await readPlanBar(page);
    t.log(`  · [target=l] ${planL.bar}`);
    // 确定性夹具 ⇒ 确定性读数。夹具 `stEntries()`（fixtures/gen.js:92）共 11 条：
    //   characters 1 / chats 1 / worlds 1 / OpenAI Settings 1 / User Avatars 1 /
    //   extensions 2（manifest+index.js） / settings.json 1 / secrets.json 1 /
    //   thumbnails 1 / backups 1
    // 目标 Luker 时：直通 7 + **合成 1**（Luker 包清单 `manifest.json`，plan-preview.js:372）
    // + 丢弃 4（secrets/缩略图/备份/…）⇒ 预计产物 8。
    // 计划逻辑若有意演进，这组数字会变 —— 那正是本矩阵要捕捉的信号。
    t.ok('M-3[l] 摘要条报出直通计数 7（对应夹具 7 条直通条目）',
      /直通\s*7/.test(planL.bar), `实际="${planL.bar}"`);
    t.ok('M-3[l] 摘要条报出合成计数 1（Luker 包清单 manifest.json，plan-preview.js:372）',
      /合成\s*1/.test(planL.bar), `实际="${planL.bar}"`);
    t.ok('M-3[l] 摘要条报出丢弃计数 4（secrets + 缩略图 + 备份等）',
      /丢弃\s*4/.test(planL.bar), `实际="${planL.bar}"`);
    t.ok('M-3[l] 预计产物 8 个文件（7 直通 + 1 合成）',
      /预计产物[:：]?\s*8\s*个文件/.test(planL.estimate), `estimate="${planL.estimate}"`);

    // ===== 分支② 目标 = ST（显式指定布局码） =====
    const stReady = await setTarget('st', /预计产物[:：]?\s*8\s*个文件/);
    t.ok('M-3 切到 ST 目标后计划在 40s 内重算（预计产物 8）', stReady,
      JSON.stringify(await readPlanBar(page)));

    const planSt = await readPlanBar(page);
    t.log(`  · [target=st] ${planSt.bar}`);
    t.ok('M-3[st] 直通同为 7（源与目标同为 ST 布局）',
      /直通\s*7/.test(planSt.bar), `实际="${planSt.bar}"`);
    t.ok('M-3[st] 合成 1（ST 转换说明 `_convert/README-ST.txt`，plan-preview.js:383）',
      /合成\s*1/.test(planSt.bar), `实际="${planSt.bar}"`);
    t.ok('M-3[st] 预计产物 8 个文件',
      /预计产物[:：]?\s*8\s*个文件/.test(planSt.estimate), `estimate="${planSt.estimate}"`);

    // ===== 分支③ 目标 = TT / PT（**跨布局** ⇒ 类目项必须「路由」而非「直通」） =====
    // 语义差异（不是缺陷）：ST 与 Luker 的 `data/default-user` 目录形态相同
    // ⇒ 类目条目原样直通；TT 的树根套 `data/default-user/` 前缀、扩展另有
    // `data/extensions/third-party/` 落点 ⇒ 条目必须**路由**到新路径。
    // 首版按「直通」断言，两目标全红 —— 又是**断言写错**，不是缺陷。
    for (const [tgt, label] of [['tt', 'TauriTavern'], ['pt', 'PureTavern']]) {
      await page.selectOption('#target-select', tgt);
      await page.waitForTimeout(1500);
      const p = await readPlanBar(page);
      t.log(`  · [target=${tgt}] ${p.bar}`);
      t.ok(`M-3[${tgt}] 目标 ${label} 的类目项按「路由」计（跨布局）`,
        /路由\s*7/.test(p.bar), `实际="${p.bar}"`);
      t.ok(`M-3[${tgt}] 摘要条不再报「直通」（跨布局无直通项）`,
        !/直通/.test(p.bar), `实际="${p.bar}"`);
      t.ok(`M-3[${tgt}] 丢弃仍为 4`,
        /丢弃\s*4/.test(p.bar), `实际="${p.bar}"`);
    }

    // —— 【N-1 已修】`native` 的读数必须与**该宿主的显式布局码**一致 ——
    // 修前（2026-09-26 本矩阵查出）：外部包路径上 `native` 未走归一 ——
    // `refreshPlan` / `btnConvert` 直接把字符串 `'native'` 交给计划器，
    // 而 `plan-preview.js` 的合成分支只认 `TARGETS.L`(:372) / `TARGETS.ST`(:383)
    // ⇒ `native` 不匹配任何分支，退化成**原样直通**。
    // 后果不对称，故长期没被发现：ST 宿主上（源本就是 ST 布局）恰好等价；
    // **Luker 宿主上选「宿主原生格式」会拿到未经布局转换的结果**。
    // 修法：`resolveTargetLayout(rawValue, platform, fallback)`（`src/ui/host-bridge.js`）统一归一，
    // `index.js` 的 5 处取目标全部改走它；单测 `test/target-resolve.test.js`（11 项，
    // 并已**实测证明判别力**：临时去掉归一后 6 项转红）。
    // 本断言在**两个实例上分别对照各自的布局码**：ST 宿主 ⇒ 与 `st` 一致；Luker 宿主 ⇒ 与 `l` 一致。
    // 后者正是 N-1 的核心场景（Luker 上选「宿主原生格式」必须真的产出 Luker 布局）。
    const nativeExpected = h.instanceId === 'dev-luker' ? planL.bar : planSt.bar;
    const nativeExpectedName = h.instanceId === 'dev-luker' ? 'l' : 'st';
    t.eq(`M-3【N-1 已修】native（宿主原生格式）读数 == 显式 ${nativeExpectedName} 的读数`,
      norm.bar, nativeExpected,
      `native="${norm.bar}" ${nativeExpectedName}="${nativeExpected}"`);

    // 动作预测 pill 与类目卡片（渲染链路的完整性）
    const widgets = await page.evaluate(() => ({
      pills: Array.from(document.querySelectorAll('#action-stats-badges .action-summary-pill'))
        .map((b) => b.textContent.trim()),
      cards: document.querySelectorAll('#category-checkboxes .category-card, #category-checkboxes label').length,
    }));
    t.log(`  · 动作预测 pill：${widgets.pills.join(' | ')}`);
    t.ge('M-3 动作预测 pill 已渲染', widgets.pills.length, 1);
    t.ge('M-3 类目卡片已渲染', widgets.cards, 1);

    // ============ 转换按钮可用性（源包入库后应被启用） ============
    const convertState = await page.evaluate(() => {
      const b = document.getElementById('btn-convert');
      return b ? { disabled: b.disabled } : null;
    });
    t.ok('M-3 源包就绪后「开始转换」按钮启用',
      Boolean(convertState && !convertState.disabled));

    // ============ M-4 转换：四目标分支各产出一份 ============
    // —— M-5 的前置采集：挂下载监听，证明「产物不自动下载」 ——
    const downloads = [];
    page.on('download', (d) => downloads.push(d.suggestedFilename()));

    const queueNames = () => page.evaluate(() => Array.from(
      document.querySelectorAll('#export-queue-panel .eq-name'),
    ).map((e) => e.textContent.trim()));

    const storedIds = () => page.evaluate(async (dbName) => {
      // 直接读插件自己的 IndexedDB（判定 M-6 的落库时序）
      return new Promise((resolve) => {
        const req = window.indexedDB.open(dbName);
        req.onerror = () => resolve({ error: 'open failed' });
        req.onsuccess = () => {
          const db = req.result;
          try {
            const tx = db.transaction('files', 'readonly');
            const all = tx.objectStore('files').getAll();
            all.onerror = () => resolve({ error: 'getAll failed' });
            all.onsuccess = () => resolve((all.result || []).map((r) => ({
              name: r.name, origin: r.origin, role: r.role, layout: r.layout,
              size: r.size || (r.blob && r.blob.size),
            })));
          } catch (e) { resolve({ error: String(e && e.message) }); }
        };
      });
    }, 'st_zip_converter_db');

    const convertTo = async (target, expectProduct) => {
      await page.selectOption('#target-select', target);
      await page.waitForTimeout(900);
      const before = (await queueNames()).length;
      await page.click('#btn-convert');
      // 转换完成的观测面：待导出区条目数增加（有界等待，L1-MR-7）
      let done = false;
      try {
        await page.waitForFunction(
          (n) => document.querySelectorAll('#export-queue-panel .eq-name').length > n,
          before, { timeout: 90_000 },
        );
        done = true;
      } catch { done = false; }
      const names = await queueNames();
      return { done, added: names.slice(before), all: names };
    };

    const TARGETS = [
      ['l', 'Luker'],
      ['st', 'SillyTavern'],
      ['tt', 'TauriTavern'],
      ['pt', 'PureTavern'],
    ];

    // —— M-6 的**基线**：转换前先把 `origin=converted` 的既有记录数记下来 ——
    // 判定一律走**增量**，因为 `.pw-profile-dev` 是持久化 profile、IndexedDB 跨轮次留存：
    // 用「converted 记录数 == 0」这种绝对判定，第二轮一定会红（上一轮的记录还在），
    // 那样这个 spec 就不是「可重跑」的（违反 AC-5）。实测踩过这个形态。
    const baselineStore = await storedIds();
    const baselineConverted = Array.isArray(baselineStore)
      ? baselineStore.filter((r) => r.origin === 'converted').length : -1;

    const produced = {};
    for (const [tgt, label] of TARGETS) {
      const r = await convertTo(tgt);
      produced[tgt] = r.added;
      t.ok(`M-4 目标 ${label}（${tgt}）转换完成并产出条目`, r.done && r.added.length > 0,
        `新增=${JSON.stringify(r.added)}`);
      t.log(`  · [target=${tgt}] 产物：${r.added.join(' | ') || '(无)'}`);
    }

    // 四个分支都产出 ⇒ 且各自都非空
    t.eq('M-4 四个目标分支全部产出（累计待导出条目数）',
      Object.values(produced).filter((a) => a.length > 0).length, 4);

    // 产物命名应体现目标（文件名模板默认含目标码）—— 四个目标不应产出完全相同的名字
    const allNames = Object.values(produced).flat();
    t.ok('M-4 四个目标的产物命名互不相同（目标码确实参与了命名）',
      new Set(allNames).size === allNames.length && allNames.length >= 4,
      JSON.stringify(allNames));

    // ============ M-5 导出队列：产物**不自动下载** ============
    t.eq('M-5 转换过程零自动下载（download 事件数）', downloads.length, 0,
      `实际触发的下载：${JSON.stringify(downloads)}`);

    const queueState = await page.evaluate(() => {
      const panel = document.getElementById('export-queue-panel');
      return {
        title: (panel.querySelector('.eq-title') || {}).textContent || '',
        rows: panel.querySelectorAll('.eq-name').length,
        stored: panel.querySelectorAll('.eq-stored').length,
        ephemeral: panel.querySelectorAll('.eq-ephemeral').length,
      };
    });
    t.log(`  · 待导出区：${queueState.title.trim()} | 行=${queueState.rows} 已入库=${queueState.stored} 临时=${queueState.ephemeral}`);
    t.ok('M-5 待导出区标题带条目计数', /待导出\s*\(\s*\d+\s*\)/.test(queueState.title),
      `title="${queueState.title.trim()}"`);
    t.ge('M-5 待导出区行数与产出数一致', queueState.rows, allNames.length);

    // ============ M-6 落库时序：转换产物**此时仍未入库** ============
    const afterConvertStore = await storedIds();
    t.ok('M-6 落库观测可用（IndexedDB 可读）', Array.isArray(afterConvertStore),
      JSON.stringify(afterConvertStore).slice(0, 120));
    const convertedAfter = Array.isArray(afterConvertStore)
      ? afterConvertStore.filter((r) => r.origin === 'converted').length : -1;
    t.log(`  · IndexedDB files 记录 ${Array.isArray(afterConvertStore) ? afterConvertStore.length : '?'} 条，`
      + `其中 converted=${convertedAfter}（基线 ${baselineConverted}）`);
    t.eq('M-6 转换产物此刻**尚未**入库（临时条目 ⇒ converted 记录数与基线相同）',
      convertedAfter, baselineConverted,
      `基线=${baselineConverted} 转换后=${convertedAfter}（差值应为 0；入库只发生在下载/存工作区时）`);

    // ============ M-6b 点「存到工作区」后才入库，且 origin 正确 ============
    const stored = await page.evaluate(() => {
      // 待导出区行内的动作按钮：「存入工作区」/「保存」
      const panel = document.getElementById('export-queue-panel');
      const btns = Array.from(panel.querySelectorAll('button'))
        .filter((b) => /工作区|保存|入库/.test(b.textContent || ''));
      if (!btns.length) return { clicked: false, candidates: [] };
      btns[0].click();
      return { clicked: true, text: btns[0].textContent.trim() };
    });
    t.ok('M-6b 待导出区存在「存入工作区」类动作按钮', stored.clicked,
      `候选=${JSON.stringify(stored.candidates)} text="${stored.text || ''}"`);

    if (stored.clicked) {
      let grew = false;
      try {
        await page.waitForFunction(async (dbName) => {
          const n = await new Promise((resolve) => {
            const req = window.indexedDB.open(dbName);
            req.onsuccess = () => {
              const tx = req.result.transaction('files', 'readonly');
              const c = tx.objectStore('files').getAll();
              c.onsuccess = () => resolve((c.result || []).filter((r) => r.origin === 'converted').length);
              c.onerror = () => resolve(-1);
            };
            req.onerror = () => resolve(-1);
          });
          return n > 0;
        }, 'st_zip_converter_db', { timeout: 30_000 });
        grew = true;
      } catch { grew = false; }
      t.ok('M-6b 点击后 converted 产物进入 IndexedDB（30s 内有界等待）', grew);

      const afterStore = await storedIds();
      const converted = Array.isArray(afterStore)
        ? afterStore.filter((r) => r.origin === 'converted') : [];
      t.log(`  · 入库后 converted 记录 ${converted.length} 条（基线 ${baselineConverted}）：`
        + converted.slice(0, 4).map((r) => `${r.name}(origin=${r.origin},role=${r.role})`).join(' | '));
      // 增量判定（同上，保证可重跑）：本轮点「存入工作区」应使 converted **正好增加产出数**
      t.eq('M-6b 点击「存入工作区」后 converted 记录增量 == 本轮产物数',
        converted.length - baselineConverted, allNames.length,
        `基线=${baselineConverted} 现在=${converted.length} 本轮产物=${allNames.length}`);
      t.ok('M-6b converted 记录带 name 与 role（落库契约完整）',
        converted.length > 0 && converted.every((r) => r.name && r.role),
        JSON.stringify(converted.slice(0, 2)));
      // 本轮四个产物必须都能在库里按名找到 —— 证明「入库的确是本轮这几份」
      const storedNames = new Set(converted.map((r) => r.name));
      t.ok('M-6b 本轮四份产物均可在 IndexedDB 中按名找到',
        allNames.every((n) => storedNames.has(n)),
        `产物=${JSON.stringify(allNames)} 库内=${JSON.stringify([...storedNames])}`);
    }

    // ============ M-7 任务控制条状态机 / 断点续传可达性 ============
    // 【2026-09-27 更新 —— R-16 已修】本节此前如实登记的是**旧现实**：
    //   「转换路径不给 TaskManager 注册任务（`taskControls.showRunning` 全仓一处，在宿主拉取路径）
    //    ⇒ 转换任务的暂停/续传在产品里不存在；`onResume` 只在 `id.startsWith('fetch-')` 时续传」。
    // 现 `btnConvert` → `handleExternalConvert` 已接 `taskManager.start`，
    // 且 `onResume` 按 `taskKindOf` **查表分派**（不再只认 `fetch-` 前缀）。
    // ⇒ M-7 从「只验初态隐藏」升级为**真实 pause → resume 续传**（见本段之后的 M-7b）。
    const tcInit = await page.evaluate(() => {
      const root = document.getElementById('task-controls');
      return { exists: Boolean(root), hidden: root ? root.hidden : null };
    });
    t.ok('M-7 任务控制条存在（#task-controls）', tcInit.exists);
    t.ok('M-7 无活动任务时控制条**隐藏**（状态机初态）', tcInit.hidden === true,
      `hidden=${tcInit.hidden}`);

    // —— R-19 只读探针：三态必须可被页面外读取（否则 E2E 断言不了真正的三态）——
    const probe = await page.evaluate(() => {
      const ns = window.__stZipConverterDebug;
      if (!ns || typeof ns.getRestoreProbe !== 'function') return { present: false };
      const p = ns.getRestoreProbe();
      const before = p.capability;
      let threw = false;
      try { p.capability = 'available'; } catch { threw = true; }   // 严格模式会抛
      return {
        present: true,
        capability: before,
        reasonLen: (p.unsupportedReason || '').length,
        frozen: Object.isFrozen(p),
        tamperThrew: threw,
        afterTamper: p.capability,
        namespaceFrozen: Object.isFrozen(ns),
      };
    });
    t.log(`  · R-19 调试探针：${JSON.stringify(probe)}`);
    t.ok('R-19 只读探针存在（window.__stZipConverterDebug.getRestoreProbe）', probe.present,
      JSON.stringify(probe));
    t.ok('R-19 未探测时三态为 `unknown`（延迟探测：不为探测预先发请求）',
      probe.capability === 'unknown', JSON.stringify(probe));
    t.ok('R-19 探针快照**冻结**且**改不动**（否则 E2E 能伪造状态，断言失去判别力）',
      probe.frozen === true && probe.afterTamper === 'unknown', JSON.stringify(probe));
    t.ok('R-19 命名空间对象本身也冻结（不可被追加/替换成员）',
      probe.namespaceFrozen === true, JSON.stringify(probe));

    // —— M-8 批量恢复：恢复入口的可见性契约 ——
    // 契约（源码）：`computeActionAvailability`（`index.js:134-144`）
    //   `restore.visible = isHost && hasArtifact`（`hasArtifact = !!lastConvertedBlob`）
    //   `restore.enabled = !isTaskRunning && !isRestoreInFlight && !isRestoreUnsupported`
    // ⇒ 可见性**由「宿主态 + 有产物」决定，与平台无关**；平台差异只在**点击后的探测结果**上
    // （`host-bridge.js:147/154` 三态 `unknown|available|unsupported`，404/405 才回退下一候选）。
    // ⚠️ 先前按 `index.js:712` 的注释「btn-restore-luker 仅 luker 显示」写过断言 —— 那句描述的是
    // **原实现**，现实现已改为按产物可见 ⇒ ST 上同样出现。**照过时注释写断言 = 臆造契约**（已改）。
    // ⚠️ 本 spec **不主动点该按钮**：`postRestoreWithFallback` 会真的 POST 到实例，
    // 而「候选端点全部 404」是 OQ-1 的既有结论、不是本 spec 要重验的事；
    // 一旦某个候选端点实际存在，就会对实例产生**真实写入** —— 风险不对等，故只验非破坏性的可见性契约。
    const restoreUi = await page.evaluate(() => {
      const btn = document.getElementById('btn-restore-luker');
      if (!btn) return { present: false };
      const r = btn.getBoundingClientRect();
      return {
        present: true,
        disabled: Boolean(btn.disabled),
        visible: r.width > 0 && r.height > 0,
        title: (btn.title || '').slice(0, 60),
        text: (btn.textContent || '').trim().slice(0, 24),
      };
    });
    t.log(`  · M-8 恢复入口（此刻已转换过 ⇒ 有产物）：${JSON.stringify(restoreUi)}`);
    t.ok('M-8 有转换产物时恢复入口可见（两宿主一致 —— 可见性由 hasArtifact 决定）',
      restoreUi.present && restoreUi.visible, JSON.stringify(restoreUi));
    t.ok('M-8 未探测前按钮**不禁用**（延迟探测：点一次才判定宿主能力，不为探测预先发请求）',
      restoreUi.present && restoreUi.disabled === false, JSON.stringify(restoreUi));

    // ============ M-9 分割：大包按 1 MB 阈值切出多分卷 ============
    const largePath = await ensureLargeFixture();
    t.ok('M-9 放大夹具已生成（> 4 MB，SHA-256 计数器模式 ⇒ 不可压缩）',
      fs.statSync(largePath).size > 4 * 1024 * 1024,
      `${(fs.statSync(largePath).size / 1048576).toFixed(1)} MB`);

    // ⚠️ 换源包**不能**只再喂一次 `#file-input`：`index.js:1473`
    //   `if (!currentFile) { currentFile = item.file; … }` 只在**尚无源包**时采纳新文件，
    //   否则只把它存进 IndexedDB（实测症状：喂了大包，计划读数纹丝不动，还是 570 B，
    //   且 `#stash-list` 一张卡都没有 —— 因为持久化 profile 在加载时已把上一轮的源包恢复了）。
    // ⇒ 唯一可靠的做法是**先清回无源包初态**，让大包成为唯一源包。
    const resetForSplit = await resetWorkspace(page);
    t.ok('M-9 分割前已把工作台清回初态（换源包的前提）', resetForSplit);
    const readySplit = await waitForPluginReady(page);
    t.ok('M-9 重载后插件重新就绪', readySplit);
    const openedSplit = await openWorkbench(page);
    t.ok('M-9 重载后工作台重新打开且控件可见', openedSplit.visible, JSON.stringify(openedSplit));

    await page.setInputFiles('#file-input', largePath);

    let largePlanned = false;
    try {
      // 放大包 = 迷你包 7 条直通 + 6 条新聊天 ⇒ 直通数应 ≥ 13
      await page.waitForFunction(() => {
        const el = document.getElementById('plan-summary-bar');
        if (!el) return false;
        const m = /直通\s*(\d+)/.exec(el.textContent.replace(/\s+/g, ' '));
        return Boolean(m) && Number(m[1]) >= 13;
      }, null, { timeout: 60_000 });
      largePlanned = true;
    } catch { largePlanned = false; }
    t.ok('M-9 放大包的计划已产出（直通数 ≥ 13，确实换了源包）', largePlanned,
      (await readPlanBar(page)).bar);

    await page.selectOption('#target-select', 'st');
    await page.waitForTimeout(600);
    await page.fill('#split-input', '1');   // 1 MB 阈值 ⇒ ~6 MB 应切出多份
    await page.waitForTimeout(600);

    const qBeforeSplit = (await queueNames()).length;
    await page.click('#btn-convert');
    let splitDone = false;
    try {
      await page.waitForFunction(
        (n) => document.querySelectorAll('#export-queue-panel .eq-name').length > n + 1,
        qBeforeSplit, { timeout: 240_000 },
      );
      splitDone = true;
    } catch { splitDone = false; }

    const qAfterSplit = await queueNames();
    const splitParts = qAfterSplit.slice(qBeforeSplit);
    t.ok('M-9 分割转换完成且产出**多个**分卷（> 1 份）', splitDone && splitParts.length > 1,
      `新增 ${splitParts.length} 份：${JSON.stringify(splitParts)}`);
    t.log(`  · 分卷产物（${splitParts.length} 份）：${splitParts.join(' | ') || '(无)'}`);

    const partIdx = splitParts.map((n) => {
      const m = /part(\d+)/i.exec(n);
      return m ? Number(m[1]) : null;
    });
    t.ok('M-9 分卷命名含 part 序号且从 1 起连续',
      partIdx.length > 1 && partIdx[0] === 1
      && partIdx.every((v) => v !== null)
      && partIdx.every((v, i) => i === 0 || v === partIdx[i - 1] + 1),
      `序号=${JSON.stringify(partIdx)}`);

    // —— 两态免费互证：分卷路径会把 `lastConvertedBlob` 置 null
    //    （`index.js` 分卷分支末尾 `lastConvertedBlob = null; // 原始整包不再有任何消费方`）
    //    ⇒ 恢复入口应随之**重新隐藏**。这把 M-8 的「可见性由 hasArtifact 决定」钉成双向可判别，
    //    而不是「碰巧一直可见」。 ——
    const restoreAfter = await page.evaluate(() => {
      const btn = document.getElementById('btn-restore-luker');
      if (!btn) return { present: false };
      const r = btn.getBoundingClientRect();
      return { present: true, visible: r.width > 0 && r.height > 0 };
    });
    t.ok('M-8 分卷接管后（lastConvertedBlob 置 null）恢复入口**重新隐藏** —— 可见性确实由产物决定',
      !restoreAfter.present || !restoreAfter.visible, JSON.stringify(restoreAfter));

    // —— 转换结束后控制条回到隐藏（`complete` → `taskControls.hide()`）——
    // ⚠️ 旧断言是「转换期间控制条**始终隐藏**（转换不进 TaskManager 的直接证据）」——
    //    R-16 修好后那句**变成假的**，此处随之反转为「结束后隐藏」。
    t.ok('M-7 转换结束后控制条回到隐藏（`complete` → `taskControls.hide()`）',
      await page.evaluate(() => {
        const root = document.getElementById('task-controls');
        return Boolean(root) && root.hidden === true;
      }));

    // ============ M-7b 真实 pause → resume 续传（R-16 的核心验收面）============
    // 用**暂停窗口夹具**（~48 MB / 48 条目）：6 MB 的转换在数百毫秒内结束，
    // 等控制条出现的往返里就完了 ⇒ pause 会点在已隐藏的按钮上（**假红或假绿**）。
    const pausePath = await ensurePauseFixture();
    t.ok('M-7b 暂停窗口夹具已生成（> 40 MB，确定性高熵 ⇒ 转换需数秒）',
      fs.statSync(pausePath).size > 40 * 1024 * 1024,
      `${(fs.statSync(pausePath).size / 1048576).toFixed(1)} MB`);

    // 换源包必须先清回初态（spec §11.2：持久化 profile 会恢复上一轮的源包，
    // 而 `index.js` 只在 `!currentFile` 时采纳新文件）
    const resetForPause = await resetWorkspace(page);
    const readyPause = await waitForPluginReady(page);
    const openedPause = await openWorkbench(page);
    t.ok('M-7b 工作台已清回初态并重新就绪', resetForPause && readyPause && openedPause.visible,
      JSON.stringify(openedPause));

    await page.setInputFiles('#file-input', pausePath);
    let pausePlanned = false;
    try {
      await page.waitForFunction(() => {
        const el = document.getElementById('plan-summary-bar');
        if (!el) return false;
        const m = /直通\s*(\d+)/.exec(el.textContent.replace(/\s+/g, ' '));
        return Boolean(m) && Number(m[1]) >= 13;
      }, null, { timeout: 90_000 });
      pausePlanned = true;
    } catch { pausePlanned = false; }
    t.ok('M-7b 大包计划已产出（确实换了源包）', pausePlanned, (await readPlanBar(page)).bar);

    await page.selectOption('#target-select', 'st');
    await page.fill('#split-input', '0');  // 关掉分卷：本段只验续传，不混入分卷语义
    await page.waitForTimeout(400);

    await page.click('#btn-convert');

    // ① 转换期间控制条**可见**（转换确实注册了 TaskManager —— 旧实现此处恒隐藏）
    let tcRunning = false;
    try {
      await page.waitForFunction(() => {
        const root = document.getElementById('task-controls');
        if (!root || root.hidden) return false;
        const r = root.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }, null, { timeout: 30_000 });
      tcRunning = true;
    } catch { tcRunning = false; }
    t.ok('M-7b 转换期间控制条**可见**（running 态 —— 转换已注册 TaskManager）', tcRunning);

    // ② 暂停 ⇒ 出现「继续」（running → paused）
    await page.click('#tc-pause');
    let pausedVisible = false;
    try {
      await page.waitForFunction(() => {
        const btn = document.getElementById('tc-resume');
        if (!btn || btn.hidden) return false;
        const r = btn.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }, null, { timeout: 30_000 });
      pausedVisible = true;
    } catch { pausedVisible = false; }
    t.ok('M-7b 点暂停后出现「继续」按钮（控制条 running → paused）', pausedVisible);

    // ③ 续传 ⇒ 跑完（complete → 控制条隐藏）
    await page.click('#tc-resume');
    let resumeDone = false;
    try {
      await page.waitForFunction(() => {
        const root = document.getElementById('task-controls');
        return Boolean(root) && root.hidden === true;
      }, null, { timeout: 300_000 });
      resumeDone = true;
    } catch { resumeDone = false; }
    t.ok('M-7b 续传跑完（控制条回到隐藏 = 任务 complete）', resumeDone);

    // ④ **续传命中可观测** —— 本任务新增的可观测面。
    //    真实字段是 `report.totals.resumed`（**不是** `resumedCount`，该字段从不存在），
    //    经 `resumedNote()` 渲染进成功日志，故可从日志 DOM 读到。
    const logText = await page.evaluate(() => {
      const mount = document.getElementById('log-console-mount');
      return mount ? mount.textContent : '';
    });
    const resumedMatch = /沿用断点跳过\s*(\d+)\s*项/.exec(logText);
    t.log(`  · M-7b 日志尾部：${JSON.stringify(logText.slice(-240))}`);
    t.ok('M-7b 续传**真的跳过了条目**（日志含「沿用断点跳过 N 项」）', Boolean(resumedMatch),
      `日志尾部=${JSON.stringify(logText.slice(-240))}`);
    if (resumedMatch) {
      t.ok('M-7b 跳过条数 > 0', Number(resumedMatch[1]) > 0, `N=${resumedMatch[1]}`);
    }

    // ============ M-10 批量转换：入口可达 + 暂停续传（U-7 / R-16 批量的验收面）============
    // 取证（本仓 2026-09-27）：`grep -rn runBatchConversion` ⇒ 只有**定义** + 3 处注释/测试注释，
    //   **零调用者**；暂存区批量栏只渲染「载入为源/下载/写回宿主/删除」；模板无批量入口。
    //   而 `README.md:74` 写着「…批量转换与自定义包名」 ⇒ 承诺有、入口无（与 R-16 同族）。
    // 本段验：① 入口**可达**；② 批量转换真产出；③ 批次中途 pause → resume 时
    //   **已完成子项不重跑**、从断点游标继续。
    //
    // 顺序设计：**先选小包、后选大包**（勾选顺序 = Set 插入顺序 = 批次顺序）
    //   ⇒ 第 0 个子项（小包）很快完成，第 1 个子项（48 MB 大包）跑得久
    //   ⇒ 在「队列新增 1 个产物」之后点暂停，暂停必然落在**第 1 个子项内部**
    //   ⇒ 断点游标 = 1、outputs = [第 0 项] ⇒ 续传时**必须跳过第 0 项**（这正是要验的语义）。
    const mini = await ensureFixtures();
    const smallPath = mini['fixture-st.zip'];

    const resetForBatch = await resetWorkspace(page);
    const readyBatch = await waitForPluginReady(page);
    const openedBatch = await openWorkbench(page);
    t.ok('M-10 工作台已清回初态并重新就绪',
      resetForBatch && readyBatch && openedBatch.visible, JSON.stringify(openedBatch));

    await page.setInputFiles('#file-input', [smallPath, pausePath]);
    let twoStashed = false;
    try {
      await page.waitForFunction(
        () => document.querySelectorAll('#stash-list .stash-select-box').length >= 2,
        null, { timeout: 60_000 },
      );
      twoStashed = true;
    } catch { twoStashed = false; }
    t.ok('M-10 暂存区有两个源包（小包 + 大包）', twoStashed);

    const idByName = (name) => page.evaluate((n) => {
      const rows = Array.from(document.querySelectorAll('#stash-list .eq-name-row'));
      const row = rows.find((r) => (r.querySelector('.archive-name')?.textContent || '').trim() === n);
      return row ? (row.querySelector('.stash-select-box')?.dataset.id ?? null) : null;
    }, name);
    const smallId = await idByName('fixture-st.zip');
    const bigId = await idByName('fixture-pause-st.zip');
    t.ok('M-10 两个源包都能按名定位到勾选框', Boolean(smallId) && Boolean(bigId),
      `small=${smallId} big=${bigId}`);

    if (smallId) await page.check(`.stash-select-box[data-id="${smallId}"]`);
    if (bigId) await page.check(`.stash-select-box[data-id="${bigId}"]`);
    await page.waitForTimeout(400);

    const batchBtn = await page.evaluate(() => {
      const bar = document.getElementById('stash-batch-bar');
      if (!bar || bar.hidden) return { ok: false, reason: '批量栏未显示' };
      const btn = Array.from(bar.querySelectorAll('button'))
        .find((b) => (b.textContent || '').includes('批量转换'));
      if (!btn) return { ok: false, reason: '无「批量转换」按钮' };
      const r = btn.getBoundingClientRect();
      return { ok: true, visible: r.width > 0 && r.height > 0, disabled: Boolean(btn.disabled) };
    });
    t.ok('M-10 多选后出现「批量转换」按钮且可用（U-7 的入口补上了）',
      batchBtn.ok && batchBtn.visible && batchBtn.disabled === false, JSON.stringify(batchBtn));

    await page.selectOption('#target-select', 'st');
    await page.fill('#split-input', '0');
    await page.waitForTimeout(400);

    const qBeforeBatch = (await queueNames()).length;
    await page.click('#stash-batch-bar button:has-text("批量转换")');

    // ① 批量期间控制条可见（批量是**一个**任务 —— 不是每个子项一个）
    let batchTcRunning = false;
    try {
      await page.waitForFunction(() => {
        const root = document.getElementById('task-controls');
        if (!root || root.hidden) return false;
        const r = root.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }, null, { timeout: 30_000 });
      batchTcRunning = true;
    } catch { batchTcRunning = false; }
    t.ok('M-10 批量期间控制条**可见**（批量转换已注册 TaskManager，不再是死代码路径）',
      batchTcRunning);

    // ② 等第 0 个子项完成（队列 +1）⇒ 此刻第 1 个子项正在跑 ⇒ 暂停
    let firstItemDone = false;
    try {
      await page.waitForFunction(
        (n) => document.querySelectorAll('#export-queue-panel .eq-name').length >= n + 1,
        qBeforeBatch, { timeout: 240_000 },
      );
      firstItemDone = true;
    } catch { firstItemDone = false; }
    t.ok('M-10 批次第 0 个子项已完成（队列 +1）', firstItemDone);

    await page.click('#tc-pause');
    let batchPaused = false;
    try {
      await page.waitForFunction(() => {
        const btn = document.getElementById('tc-resume');
        if (!btn || btn.hidden) return false;
        const r = btn.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }, null, { timeout: 60_000 });
      batchPaused = true;
    } catch { batchPaused = false; }
    t.ok('M-10b 批次中途可暂停（控制条 running → paused）', batchPaused);

    await page.click('#tc-resume');
    let batchResumed = false;
    try {
      await page.waitForFunction(() => {
        const root = document.getElementById('task-controls');
        return Boolean(root) && root.hidden === true;
      }, null, { timeout: 300_000 });
      batchResumed = true;
    } catch { batchResumed = false; }
    t.ok('M-10b 批次续传跑完（控制条回到隐藏 = 任务 complete）', batchResumed);

    // ③ **已完成子项不重跑**：整批只应新增 **2** 个产物（若第 0 项被重跑就是 3 个）
    const qAfterBatch = await queueNames();
    const batchNew = qAfterBatch.length - qBeforeBatch;
    t.log(`  · M-10 批次新增产物 ${batchNew} 份：${JSON.stringify(qAfterBatch.slice(qBeforeBatch))}`);
    t.ok('M-10b 整批新增产物 == 2（**已完成子项没有被重跑**）', batchNew === 2,
      `实际新增 ${batchNew} 份：${JSON.stringify(qAfterBatch.slice(qBeforeBatch))}`);

    // ④ 续传命中同样可观测（第 1 个子项在暂停前已完成的条目被跳过）
    const batchLogText = await page.evaluate(() => {
      const mount = document.getElementById('log-console-mount');
      return mount ? mount.textContent : '';
    });
    const batchResumedMatch = /沿用断点跳过\s*(\d+)\s*项/.exec(batchLogText);
    t.log(`  · M-10b 日志尾部：${JSON.stringify(batchLogText.slice(-240))}`);
    t.ok('M-10b 批次续传**真的跳过了条目**（日志含「沿用断点跳过 N 项」）',
      Boolean(batchResumedMatch), `日志尾部=${JSON.stringify(batchLogText.slice(-240))}`);
    t.ok('M-10b 批量成功日志出现两次（两个子项各一次）',
      (batchLogText.match(/批量转换|数据包转换成功/g) || []).length >= 2,
      `匹配数=${(batchLogText.match(/批量转换|数据包转换成功/g) || []).length}`);
  },
};
