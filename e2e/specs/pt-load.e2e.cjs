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

const DRAWER_ID = 'st_zip_converter_settings';

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

    // 打开抽屉并读工作台真实渲染（与矩阵同一手法）
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

    // PT 是纯前端宿主 ⇒ 「从宿主拉取」**不该**出现（与 ST/Luker 的可见契约相反，这是预期的形态差异）
    const hostFetchVisible = await page.evaluate(() => {
      const el = document.getElementById('btn-host-fetch');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    t.ok('P6 PT 上「从宿主拉取」不可见（纯前端宿主没有整包拉取端点 —— 预期差异，非缺陷）',
      hostFetchVisible === false, `visible=${hostFetchVisible}`);

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
  },
};
