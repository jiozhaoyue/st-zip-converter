/**
 * PureTavern（第 4 宿主）的**插件加载与注入**冒烟
 *
 * 为什么单独一条：`smoke.e2e.cjs` 是按 Dev ST / Dev Luker 写的（`requiresInstances` 里就那两个，
 * 且部分断言绑定了宿主名），因此 **PT 这个宿主此前没有任何自动化**。本用例只做与宿主无关的判读：
 * 插件挂上来了、注入点齐全、工作台真渲染、零本插件报错。
 *
 * 与 ST/Luker 的差别（登记，避免误判）：
 *  - PT 是**纯前端**宿主：用户数据不在磁盘（浏览器侧存储）⇒ 没有 `/api/users/backup` 那类端点，
 *    「从宿主拉取 / 恢复写入」在 PT 上**不可用是预期**，本用例**不**断言它们存在；
 *  - PT 的初始化较慢（实测 t+15 s 仍在「正在初始化…」，t+30 s 插件抽屉才出现）⇒ 就绪等待给足。
 */

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const DRAWER_ID = 'st_zip_converter_settings';
const FIXTURE_DIR = path.resolve(__dirname, '..', '..', 'test-results', 'fixtures');

module.exports = {
  name: 'PureTavern 冒烟：插件加载 / 注入点 / 工作台渲染 / 零本插件报错',
  requiresInstance: 'pt-web',
  async run(t, h) {
    const { page } = h;

    // PT 初始化慢：等宿主骨架 + 插件抽屉出现（有界）
    const ready = await page.waitForFunction(
      () => Boolean(document.getElementById('send_form')),
      null, { timeout: 60_000 },
    ).then(() => true).catch(() => false);
    t.ok('P1 PT 页面骨架就绪（`#send_form` 出现）', ready);

    const drawerAppeared = await page.waitForFunction(
      (id) => Boolean(document.getElementById(id) && document.querySelector(`#${id} .st-converter-drawer-app`)),
      DRAWER_ID, { timeout: 90_000 },
    ).then(() => true).catch(() => false);
    t.ok('P2 插件抽屉已注入 PT（`#st_zip_converter_settings` 内有工作台容器）', drawerAppeared);

    // 宿主注入点：菜单锚点与扩展设置面板（PT 兼容 ST 的这批 id）
    const spots = await page.evaluate(() => ({
      extPanel: Boolean(document.getElementById('extensions_settings')),
      hostMenuAnchor: Boolean(document.querySelector('#extensionsMenu') || document.querySelector('#options')),
      injectedButtons: document.querySelectorAll('[data-st-zip-injected="1"]').length,
    }));
    t.ok('P3 PT 有扩展设置面板（注入落点存在）', spots.extPanel, JSON.stringify(spots));

    // 打开抽屉要**两步**（与实例侧用例同一教训）：先开**宿主**的扩展设置抽屉 —— 插件抽屉嵌在它里面，
    // 祖先隐藏时 Playwright 一律判「不可见」，`selectOption`/`click` 都会超时。
    const hostOpened = await page.evaluate(() => {
      const btn = document.querySelector('#extensions-settings-button .drawer-toggle')
        || document.querySelector('.drawer-opener[data-target="extensions-settings-button"]');
      if (!btn) return 'not-found';
      btn.click();
      return 'clicked';
    });
    await page.waitForTimeout(1200);
    t.ok('P3b 宿主扩展设置抽屉已打开（原生 toggle；不打开则工作台控件一律不可见）',
      hostOpened !== 'not-found', `via=${hostOpened}`);

    // 打开插件抽屉并读工作台真实渲染（与矩阵同一手法）
    const opened = await page.evaluate((id) => {
      const drawer = document.getElementById(id);
      if (!drawer) return { ok: false, reason: '抽屉不存在' };
      const content = drawer.querySelector(':scope > .inline-drawer-content');
      if (content) content.style.display = 'block';
      const app = drawer.querySelector('.st-converter-drawer-app');
      return {
        ok: true,
        hasApp: Boolean(app),
        categoryPanel: app ? app.querySelectorAll('.category-panel').length : 0,
        dropzone: Boolean(app && app.querySelector('#dropzone')),
        controlIds: app ? ['file-input', 'btn-convert', 'stash-list', 'export-queue-panel', 'task-controls']
          .filter((x) => app.querySelector(`#${x}`)).length : 0,
      };
    }, DRAWER_ID);
    t.ok('P4 工作台容器渲染（`.st-converter-drawer-app`）', opened.ok && opened.hasApp,
      JSON.stringify(opened));
    t.eq('P4b 关键控件齐全（file-input / btn-convert / stash-list / export-queue-panel / task-controls 五项）',
      opened.controlIds, 5, JSON.stringify(opened));

    // 平台徽标：PT 上应给出一个**非模板初值**的判定（具体文案由 host-bridge 决定，不断言字面）
    const badge = await page.evaluate(() => {
      const el = document.getElementById('env-badge');
      return el ? el.textContent.trim() : null;
    });
    t.ok('P5 平台徽标已脱离模板初值「检测中...」（宿主判定跑完了）',
      typeof badge === 'string' && badge.length > 0 && badge !== '检测中...', `badge=${badge}`);

    // PT 上「从宿主拉取」**是可见的**（实测）：PT 以 ST 兼容宿主自居（徽标「SillyTavern 插件」、
    // 有 `#extensions_settings` / 菜单锚点）⇒ `host.isPlugin` 为真 ⇒ 该按钮按可用性求值显示出来。
    // ⚠️ 本条**订正一次错误结论**：最初这里断言"应不可见"，理由是"PT 纯前端、无整包端点" ——
    //    那是**臆造**：那次之所以量到 visible=false，是因为**宿主的扩展抽屉没打开**、
    //    祖先隐藏导致按钮没有尺寸（量的是"祖先隐藏"，不是"插件隐藏了它"）。
    //    规范里也已同步更正（§11.9）。判据只断言"与 isHost 求值一致的可见性"，不臆测宿主能力。
    const hostFetch = await page.evaluate(() => {
      const el = document.getElementById('btn-host-fetch');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { present: true, visible: r.width > 0 && r.height > 0, disabled: Boolean(el.disabled) };
    });
    t.ok('P6 PT 上「从宿主拉取」按宿主判定**可见**（PT 被当作酒馆宿主；不断言其端点能力）',
      Boolean(hostFetch) && hostFetch.visible === true, JSON.stringify(hostFetch));

    // 判读只看**属于本插件**的那一栏（同页跑着别的扩展）
    t.eq('P7 本插件控制台/页面错误数（只看能归因到本插件的）',
      h.rec.pluginConsoleErrors.length, 0,
      JSON.stringify(h.rec.pluginConsoleErrors.slice(0, 2)));
    t.eq('P8 本插件失败请求数（4xx/5xx + 网络失败）', h.rec.pluginFailures.length, 0,
      JSON.stringify(h.rec.pluginFailures.slice(0, 2)));
    t.log(`  · 背景读数（不判定）：整页 console.error ${h.rec.consoleErrors.length} 条、`
      + `pageerror ${h.rec.pageErrors.length} 条、失败请求 ${h.rec.failedRequests.length} 条`);
    t.log(`  · 注入读数：extPanel=${spots.extPanel} 菜单锚点=${spots.hostMenuAnchor} `
      + `注入按钮=${spots.injectedButtons}`);

    // ============ 功能闭环：在 PT 上真转一次（上传 → 计划 → 转换 → 下载 → 解包核对）============
    // 加载通过只说明"挂上来了"；用户在 PT 上真正要的是**能转**。PT 无宿主拉取端点，
    // 但**上传包转换**这条路径与宿主无关 ⇒ 在第 4 宿主上同样应当闭环。
    const fixturePath = path.join(FIXTURE_DIR, 'fixture-st.zip');
    if (!fs.existsSync(fixturePath)) {
      const genUrl = pathToFileURL(path.resolve(__dirname, '..', '..', 'fixtures', 'gen.js')).href;
      await import(genUrl).then((m) => m.generateAll(FIXTURE_DIR));
    }
    t.ok('P9 PT 用例夹具就绪', fs.existsSync(fixturePath), fixturePath);

    // 前置门：控件真的可见（否则后面的 select/click 只会以超时告终，红得没信息量）
    const controlsVisible = await page.evaluate(() => {
      const sel = document.getElementById('target-select');
      const input = document.getElementById('file-input');
      if (!sel || !input) return { ok: false };
      const r = sel.getBoundingClientRect();
      return { ok: r.width > 0 && r.height > 0, w: Math.round(r.width) };
    });
    t.ok('P9b 【前置门】`#target-select` 真实可见（抽屉已两层打开）', controlsVisible.ok,
      JSON.stringify(controlsVisible));

    await page.setInputFiles('#file-input', fixturePath);
    const planned = await page.waitForFunction(() => {
      const bar = document.getElementById('plan-summary-bar');
      const est = document.getElementById('output-estimate-text');
      return Boolean(bar) && getComputedStyle(bar).display !== 'none'
        && Boolean(est) && est.textContent.trim().length > 0;
    }, null, { timeout: 60_000 }).then(() => true).catch(() => false);
    t.ok('P10 PT 上上传夹具后计划预览渲染（纯前端宿主也走同一条计划路径）', planned);

    await page.selectOption('#target-select', 'st');
    const t0 = Date.now();
    await page.click('#btn-convert');
    const queued = await page.waitForFunction(
      () => document.querySelectorAll('.eq-name').length >= 1, null, { timeout: 180_000 },
    ).then(async () => page.$$eval('.eq-name', (els) => els.map((e) => e.textContent.trim())))
      .catch(() => null);
    t.ok('P11 PT 上转换完成并产出待导出条目',
      Array.isArray(queued) && queued.length >= 1, JSON.stringify(queued));
    t.log(`  · 读数：PT 上转换耗时 ${Date.now() - t0} ms，产物 ${JSON.stringify(queued)}`);

    // 下载并**解包核对**（只数队列行会把空壳判成通过）
    const outPath = path.join(FIXTURE_DIR, 'pt-product.zip');
    if (Array.isArray(queued) && queued.length >= 1) {
      const dl = await Promise.all([
        page.waitForEvent('download', { timeout: 60_000 }),
        page.click('.btn-archive-action.download'),
      ]).then(([d]) => d);
      await dl.saveAs(outPath);
      const { zipIo } = await import(pathToFileURL(
        path.resolve(__dirname, '..', '..', 'src', 'core', 'zip-io.js')).href);
      const reader = await zipIo.openReader(outPath);
      const names = [];
      try { for await (const e of reader.entries()) names.push(e.fileName); } finally { await reader.close(); }
      t.ge('P12 PT 产物是合法 zip 且条目数 > 0', names.length, 1, `entries=${names.length}`);
      t.ok('P13 PT 产物内容与源包对应（含角色卡与聊天）',
        names.some((n) => n.startsWith('characters/')) && names.some((n) => n.startsWith('chats/')),
        JSON.stringify(names.slice(0, 6)));
      t.ok('P14 PT 目标落位正确（ST 目标保留平铺，不含 data/ 前缀）',
        !names.some((n) => n.startsWith('data/')), JSON.stringify(names.slice(0, 4)));
    }

    t.eq('P15 功能闭环后本插件仍零报错', h.rec.pluginConsoleErrors.length, 0,
      JSON.stringify(h.rec.pluginConsoleErrors.slice(0, 2)));
  },
};
