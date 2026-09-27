/**
 * 实例侧：「宿主拉取 → 聊天库补齐」这条**接线**（此前从未被任何 E2E 驱动过）
 *
 * ## 为什么需要它
 *
 * 聊天库适配的**主路径**是「宿主拉取后把库里缺的聊天补进包」（纯库模式下备份包的 chats/
 * 是空的）。而在此之前：
 *  - 消费侧的**模块与链路**已由独立形态的 `specs-src/chat-store-module.e2e.cjs` 验过（源码树挂载直驱真实模块）；
 *  - 唯独 `#btn-host-fetch` → `injectLibraryChatsIntoSource()` 这一段**按钮接线**没有任何自动化覆盖
 *    （矩阵 spec 不驱动宿主拉取：它只走上传包的路径）。
 *
 * ## 成本控制（为什么选 dev-luker + 只勾一个小类目）
 *
 * 完整宿主拉取在 dev-st 上是 **1.5 GB**（ST 端点不支持 selection，只能拉全量）。而
 * **Luker 端点支持 selection** ⇒ 只勾一个**小的**类目就能把拉取量压到几十 MB。
 * ⚠️ **不能勾 `settings`**：规范明写它会隐含打包 `backups/`（GB 级历史快照）。
 *
 * ## 判据（都是正向读数，不看"没崩"）
 *
 * 1. 日志出现「已把 N 条库中聊天补入源包」，且 N > 0 —— 这是接线走通的**直接证据**；
 * 2. 只读探针记下实际调用读数（`lastListCount > 0`、`lastExportOk > 0`）；
 * 3. 桩的调用账本：`listChats` 被调过；`exportChat` 只被调过**库里那些**（源包同名的不重导）；
 * 4. 全流程零本插件报错（拉取被中止也**不得**报成失败）。
 */

const { isPluginRef } = require('../lib/harness.cjs');

/** 桩供给方：两条可导出聊天 + 一条隐藏容器（都被源包"缺"⇒ 应全部被导出） */
const STUB = ({ chats }) => {
  globalThis.__stubCalls = { list: 0, export: [], import: [] };
  globalThis.ChatFilesysApi = Object.freeze({
    apiVersion: 1,
    capabilities: Object.freeze({ list: true, export: true, import: true }),
    mode: () => 'pure',
    listChats: async () => { globalThis.__stubCalls.list += 1; return chats; },
    exportChat: async ({ fileName }) => {
      globalThis.__stubCalls.export.push(fileName);
      return `${JSON.stringify({ name: 'You', is_user: true, mes: `stub-chat:${fileName}` })}\n`;
    },
    importChat: async () => ({ ok: true }),
  });
};

const STUB_CHATS = [
  { fileName: 'e2e-stub-only-1.jsonl' },
  { fileName: 'e2e-stub/only-2.jsonl' },
  { fileName: '__cfsys__探针.jsonl' },
];

/** 展开插件日志（折叠态读不到任何行 —— 实例矩阵踩过这个坑） */
async function readLog(page) {
  await page.evaluate(() => {
    const body = document.getElementById('log-console-body');
    if (body && getComputedStyle(body).display === 'none') {
      const btn = document.getElementById('btn-toggle-log');
      if (btn) btn.click();
    }
  });
  await page.waitForTimeout(300);
  return page.evaluate(() => {
    const el = document.getElementById('log-stream-container');
    return el ? el.textContent : '';
  });
}

/** 等日志出现匹配（有界） */
async function waitLogMatch(page, pattern, timeout) {
  try {
    await page.waitForFunction((src) => {
      const el = document.getElementById('log-stream-container');
      if (!el) return false;
      return new RegExp(src).test(el.textContent);
    }, pattern.source, { timeout });
    return true;
  } catch { return false; }
}

module.exports = {
  name: '聊天库补齐：宿主拉取 → 自动并入库中聊天（接线验证）',
  requiresInstance: 'dev-luker',
  async run(t, h) {
    const { page } = h;

    // 桩必须在**页面加载前**注入（探针在 bootstrap 时就挂上了）
    await page.addInitScript(STUB, { chats: STUB_CHATS });
    await page.goto(h.instance.url, { waitUntil: 'domcontentloaded' });

    // 等宿主就绪（有界）——与冒烟 spec 同一判据
    const ready = await page.waitForFunction(
      () => Boolean(document.getElementById('extensionsMenu') || document.querySelector('#send_form')),
      null, { timeout: 60_000 },
    ).then(() => true).catch(() => false);
    t.ok('I1 宿主页面就绪', ready);

    // ⚠️ **必须等插件初始化完**：宿主 DOM 就绪 ≠ 插件已注入。矩阵的判据是
    //    `#env-badge` 脱离模板初值「检测中...」（Luker 上实测要 ~14 s，故给 60 s 上界）。
    //    首版只等宿主 DOM ⇒ 抽屉尚未注入 ⇒ 后续点击全部"element is not visible"（一次假红连锁）。
    const pluginReady = await page.waitForFunction(() => {
      const el = document.getElementById('env-badge');
      if (!el) return false;
      const txt = el.textContent.trim();
      return txt.length > 0 && txt !== '检测中...';
    }, null, { timeout: 60_000 }).then(() => true).catch(() => false);
    t.ok('I1b 插件在工作台里完成初始化（#env-badge 脱离模板初值）', pluginReady);

    // 打开抽屉要**两步**（矩阵同款）：
    //  ① 先开**宿主**的扩展设置抽屉 —— 插件抽屉嵌在它里面，祖先隐藏时 Playwright 一律判不可见
    //     （首版只强制显示了插件抽屉的内容 ⇒ `#btn-host-fetch` "element is not visible"，点击超时）；
    //  ② 再展开插件自己的抽屉内容。
    const hostOpened = await page.evaluate(() => {
      const btn = document.querySelector('#extensions-settings-button .drawer-toggle')
        || document.querySelector('.drawer-opener[data-target="extensions-settings-button"]');
      if (!btn) return 'not-found';
      btn.click();
      return 'clicked';
    });
    await page.waitForTimeout(1200);
    t.ok('I2a 宿主扩展设置抽屉已打开（原生 toggle）', hostOpened !== 'not-found', `via=${hostOpened}`);
    const opened = await page.evaluate(() => {
      const drawer = document.getElementById('st_zip_converter_settings');
      if (!drawer) return { ok: false, reason: '抽屉不存在（插件未挂载？）' };
      const content = drawer.querySelector(':scope > .inline-drawer-content');
      if (content) content.style.display = 'block';
      return { ok: true, app: Boolean(drawer.querySelector('.st-converter-drawer-app')) };
    });
    t.ok('I2 插件工作台抽屉可打开', opened.ok && opened.app, JSON.stringify(opened));
    t.ok('I3 宿主态下「从宿主拉取」入口可见',
      await page.evaluate(() => {
        const el = document.getElementById('btn-host-fetch');
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }));

    // 先喂一个**小夹具**：类目卡片是"计划渲染的产物"，没有源包就没有卡片，selection 也就无从调整。
    // 它只进暂存区，不影响宿主拉取（拉取会另出产物放进待导出区）。
    // 夹具目录在**仓根**的 `test-results/fixtures`（本文件在 `e2e/specs/` ⇒ 上两级；
    // 首版只上了 1 级 ⇒ 路径落到 `e2e/test-results` ⇒ ENOENT）
    const pathM = require('path');
    const fsx = require('fs');
    const FIXTURE_DIR = pathM.resolve(__dirname, '..', '..', 'test-results', 'fixtures');
    if (!fsx.existsSync(FIXTURE_DIR)) fsx.mkdirSync(FIXTURE_DIR, { recursive: true });
    const fixturePath = pathM.join(FIXTURE_DIR, 'fixture-st.zip');
    if (!fsx.existsSync(fixturePath)) {
      const genUrl = require('url').pathToFileURL(
        pathM.resolve(__dirname, '..', '..', 'fixtures', 'gen.js'),
      ).href;
      // 与矩阵 spec 同一手法：现场生成（确定性内容）
      await import(genUrl).then((m) => m.generateAll(FIXTURE_DIR));
    }
    t.ok('I3b 实例侧夹具存在（复用 `fixtures/gen.js` 产物）', fsx.existsSync(fixturePath), fixturePath);
    await page.setInputFiles('#file-input', fixturePath);
    const planReady = await page.waitForFunction(() => {
      const bar = document.getElementById('plan-summary-bar');
      const est = document.getElementById('output-estimate-text');
      return Boolean(bar) && getComputedStyle(bar).display !== 'none'
        && Boolean(est) && est.textContent.trim().length > 0;
    }, null, { timeout: 60_000 }).then(() => true).catch(() => false);
    t.ok('I3c 喂夹具后计划渲染（类目卡片可用）', planReady);

    // —— 收窄拉取量：只勾一个小类目（Luker 端点支持 selection）——
    // ⚠️ 取舍：**必须包含 `characters`**（它是布局判据之一：`characters/` 或 `settings.json`），
    //    否则拉回来的包认不出布局、转换阶段会如实报错（那会让 I15「零报错」变红，且掩盖真正的目标）；
    //    **绝不能勾 `settings`**（Luker 会隐含打包 `backups/`，GB 级）。
    //    `characters` 在 dev 实例上约 40 MB ⇒ 拉取量可接受。
    const narrowed = await page.evaluate(() => {
      const deselect = document.getElementById('btn-deselect-all');
      if (deselect) deselect.click();
      return true;
    });
    t.ok('I4 已点「全不选」（为收窄拉取量）', narrowed);
    await page.waitForTimeout(400);
    const picked = await page.evaluate(() => {
      const card = document.querySelector('.category-card[data-category="characters"]');
      if (!card) return null;
      const box = card.querySelector('input[type="checkbox"]');
      if (!box || box.disabled) return null;
      if (!box.checked) box.click();
      return card.dataset.category;
    });
    t.ok('I5 只勾选 `characters`（小、且是布局判据；拉取量与可识别性兼顾）',
      picked === 'characters', `picked=${picked}`);

    // ⚠️ **回读前置门（本用例的命门）**：只断言"点了全不选"是不够的 —— 若那个按钮不存在，
    //    点击静默无效、selection 仍是**全量**，于是拉的是 GB 级 Luker 数据（含 backups/），
    //    300 s 内根本跑不到注入点 ⇒ 核心断言假红（首版的真实失败原因）。
    //    故这里把"只剩一个类目被勾选"读出来当**前置门**；不成立就早退，不白烧几分钟。
    const selectionNow = await page.evaluate(() => {
      const out = {};
      for (const c of document.querySelectorAll('.category-card')) {
        const box = c.querySelector('input[type="checkbox"]');
        if (box && !box.disabled) out[c.dataset.category] = box.checked;
      }
      return out;
    });
    const checkedKeys = Object.keys(selectionNow).filter((k) => selectionNow[k]);
    t.eq('I5b 【前置门】此刻**只有一个**类目被勾选（否则拉取会是全量，本用例无法在时限内跑完）',
      checkedKeys.join(','), 'characters', JSON.stringify(selectionNow));
    if (checkedKeys.join(',') !== 'characters') {
      t.log('  · 收窄未生效 ⇒ 提前结束（不做那次全量拉取）');
      return;
    }

    // 点「从宿主拉取」——此后：拉取 → 扫描前**注入** → 日志给出补齐读数
    //
    // 两条分支（同一条接线的两面）：
    //  · **快档（默认）**：chats 未勾选 ⇒ 插件**正确地不注入**（尊重用户选择），
    //    但"路径被走到"与"为什么没注入"都必须可观测（探针 + 日志）。拉取量 ~40 MB。
    //  · **重档（`SZC_HEAVY_HOSTPULL=1`）**：把 chats 也勾上 ⇒ 真注入。dev-luker 的 chats
    //    约 670 MB，全量拉取要几分钟 ⇒ 默认**不跑**（不让这条用例拖慢他人每次的 E2E）。
    const heavy = process.env.SZC_HEAVY_HOSTPULL === '1';
    if (heavy) {
      await page.evaluate(() => {
        const card = document.querySelector('.category-card[data-category="chats"]');
        const box = card && card.querySelector('input[type="checkbox"]');
        if (box && !box.checked) box.click();
      });
      await page.waitForTimeout(300);
      t.log('  · 重档：已把 chats 也勾上（真注入分支；拉取量大，耗时数分钟）');
    }

    await page.click('#btn-host-fetch');

    if (heavy) {
      const matched = waitLogMatch(page, /已把\s*\d+\s*条库中聊天补入源包/, 900_000);
      t.ok('I6【重档】日志出现「已把 N 条库中聊天补入源包」（**接线走通的直接证据**）', await matched);
      const logHeavy = await readLog(page);
      const mHeavy = logHeavy.match(/已把\s*(\d+)\s*条库中聊天补入源包/);
      t.ok('I7【重档】补齐条数 > 0（真的从库里取了东西）', mHeavy && Number(mHeavy[1]) > 0,
        mHeavy ? mHeavy[0] : 'MISSING');
    } else {
      // 快档：等的是**说明原因**的那一行（而不是成功行）
      // ⚠️ 必须用 `[\s\S]*` 而不是 `.*`：日志面板的 textContent 里每条日志之间是**换行 + 缩进**，
      //    而 `.` 不跨行 ⇒ 首版这里白等 600 s 超时（现象是"日志没有那句话"，其实是正则读不到）。
      const explained = waitLogMatch(page, /聊天库检查完毕：[\s\S]*（跳过：[\s\S]*类目关断\s*3）/, 300_000);
      t.ok('I6【快档】日志**说明**了为什么没注入（含「类目关断 3」—— 用户关掉了聊天类目）',
        await explained);
      const logLight = await readLog(page);
      t.ok('I7【快档】没有任何"已并入"成功行（尊重用户选择：一条都不注入）',
        !/已把\s*\d+\s*条库中聊天补入源包/.test(logLight),
        JSON.stringify(logLight.slice(-200)));
    }

    const probe = await page.evaluate(() => {
      const ns = globalThis.__stZipConverterDebug;
      return ns && typeof ns.getChatStoreProbe === 'function' ? ns.getChatStoreProbe() : null;
    });
    t.ok('I8 只读探针读到桩且模式为 pure',
      Boolean(probe) && probe.present === true && probe.mode === 'pure', JSON.stringify(probe));
    t.ge('I9 探针记下「库索引条数 > 0」（**路径确实被走到** —— 这条不依赖哪条分支）',
      probe ? probe.lastListCount : -1, 1, JSON.stringify(probe));
    if (heavy) {
      t.ge('I10【重档】探针记下「实际导出成功条数 > 0」', probe ? probe.lastExportOk : -1, 1,
        JSON.stringify(probe));
    } else {
      t.eq('I10【快档】探针记下「导出 0 条」（与"尊重选择"一致，不是悄无声息）',
        probe ? probe.lastExportOk : -1, 0, JSON.stringify(probe));
    }

    const calls = await page.evaluate(() => globalThis.__stubCalls);
    t.ge('I11 桩的 listChats 被调过（接缝确实被问到）', calls.list, 1, JSON.stringify(calls));
    t.ok('I12 隐藏容器条目从未被导出（过滤生效）',
      !calls.export.some((n) => n.startsWith('__cfsys__')), JSON.stringify(calls.export));

    // 收尾：中止这次拉取/转换（宿主数据只读，中止不写任何东西）
    const aborted = await page.evaluate(() => {
      const btn = document.getElementById('tc-abort');
      if (!btn) return false;
      btn.click();
      return true;
    });
    t.ok('I13 能中止该任务（不留下悬空状态）', aborted);
    await page.waitForTimeout(1500);
    const after = await page.evaluate(() => {
      const tc = document.getElementById('task-controls');
      return { hidden: tc ? tc.hidden : null };
    });
    t.ok('I14 中止后任务控制条回到隐藏（状态机收尾）', after.hidden === true, JSON.stringify(after));

    const pluginErrors = h.rec.pluginConsoleErrors.length + h.rec.pluginFailures.length;
    t.eq('I15 全流程零本插件报错（中止**不得**被报成失败）', pluginErrors, 0,
      JSON.stringify([...h.rec.pluginConsoleErrors.slice(0, 2), ...h.rec.pluginFailures.slice(0, 2)]));
    t.ok('I16 整页错误读数里没有本插件的影子（背景读数核对）',
      !h.rec.pageErrors.some((e) => isPluginRef(e)), JSON.stringify(h.rec.pageErrors.slice(0, 2)));
  },
};
