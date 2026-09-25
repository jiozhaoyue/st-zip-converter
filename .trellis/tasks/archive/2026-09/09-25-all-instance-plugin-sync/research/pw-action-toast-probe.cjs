/**
 * 「哪个插件动作触发宿主 toastr」动作矩阵探针（Dev Luker 8003，认证态）
 *
 * 前置结论（2026-09-25 静态取证）：
 *   · 本仓 `grep -rni toastr src/ index.js` **零命中** → 插件从不直接调酒馆通知；
 *   · 宿主「Extension updates available」通知（`public/scripts/extensions.js:2028`）只对
 *     `manifest.auto_update === true` 的扩展生效，而本仓 `manifest.json` 无该字段
 *     → 这条**不可能**由本插件触发（已排除）；
 *   · 故只能靠**动态动作矩阵**：逐个驱动插件在宿主上的真实入口，全程钩住 toastr，
 *     看哪一步（若有）触发了宿主通知。
 *
 * 动作序（每步之间清空 toast 记录，便于归因）：
 *   A 打开宿主账号弹层（`#account_button`）
 *   B 点账号弹层里的插件注入按钮「数据包互转」（`#st-zip-converter-native-btn`）
 *   C 点宿主扩展菜单里的插件项（`#st-zip-converter-menu-item`）
 *   D 重开账号弹层 → 点**宿主原生** `.userBackupButton`（打开 Luker 备份管理器）
 *   E 点备份管理器里插件注入的「数据包互转」（`#st-zip-converter-luker-manager-btn`）
 *   F（`--fetch`）点「一键拉取」（`#st-zip-converter-native-btn-quick-fetch`）—— 真实拉 Dev 数据包
 *
 * 只读：不改插件文件、不写实例；`--fetch` 会真实请求宿主导出端点（Dev 环境，服务端只读）。
 *
 * 用法：node pw-action-toast-probe.cjs [--fetch]
 */
const path = require('path');
const fs = require('fs');

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    const g = require('child_process').execSync('npm root -g').toString().trim();
    return require(path.join(g, 'playwright'));
  }
}

const { chromium } = loadPlaywright();
const BASE = process.env.DEV_URL || 'https://127.0.0.1:8003';
const PROFILE = path.resolve(__dirname, '../../../../.pw-profile-dev');
// 按实例端口分文件落盘，避免 8003/8004 两轮互相覆盖（首次运行曾覆盖过一次）
const PORT_TAG = (BASE.match(/:(\d+)/) || [, 'unknown'])[1];
const OUT = path.join(__dirname, `action-toast-matrix-${PORT_TAG}.json`);
const DO_FETCH = process.argv.includes('--fetch');

/** 页面侧采集器（addInitScript）：包装 toastr，记录 level/message/stack */
function collector() {
  window.__toastLog = [];
  const stamp = () => new Date().toISOString();
  const stackOf = () => String(new Error('t').stack || '').split('\n').slice(1, 7).join(' | ').slice(0, 800);
  const record = (kind, payload) => window.__toastLog.push(Object.assign({ at: stamp(), kind }, payload));

  const LEVELS = ['success', 'info', 'warning', 'error', 'clear'];
  let ref = null;
  try {
    Object.defineProperty(window, 'toastr', {
      configurable: true,
      get() { return ref; },
      set(v) {
        ref = v;
        if (!v || v.__stZipWrapped) return;
        try {
          Object.defineProperty(v, '__stZipWrapped', { value: true, enumerable: false });
          LEVELS.forEach((lvl) => {
            if (typeof v[lvl] !== 'function') return;
            const orig = v[lvl].bind(v);
            v[lvl] = function (...args) {
              record('toastr', {
                level: lvl,
                args: args.map((a) => (typeof a === 'string' ? a.slice(0, 300) : String(a).slice(0, 150))),
                stack: stackOf(),
              });
              return orig(...args);
            };
          });
          record('wrapped', { levels: LEVELS.filter((l) => typeof v[l] === 'function') });
        } catch (err) { record('wrap-failed', { error: String(err).slice(0, 200) }); }
      },
    });
  } catch (err) { record('define-failed', { error: String(err).slice(0, 200) }); }

  // DOM 兜底：真正的 .toast 节点出现
  const attach = () => {
    const c = document.getElementById('toast-container') || document.body;
    if (!c || c.__stZipWatched) return;
    try {
      Object.defineProperty(c, '__stZipWatched', { value: true, enumerable: false });
      const seen = new WeakSet();
      const scan = (root) => {
        const nodes = root.matches?.('.toast') ? [root] : [];
        if (root.querySelectorAll) nodes.push(...root.querySelectorAll('.toast'));
        nodes.forEach((n) => {
          if (seen.has(n)) return;
          seen.add(n);
          record('toast-dom', {
            container: c.id || '(body)',
            className: String(n.className || '').slice(0, 160),
            title: String(n.querySelector?.('.toast-title')?.textContent || '').slice(0, 200),
            message: String(n.querySelector?.('.toast-message')?.textContent || n.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
          });
        });
      };
      scan(c);
      new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType === 1) scan(n); })))
        .observe(c, { childList: true, subtree: true });
      record('dom-watcher', { container: c.id || '(body)' });
    } catch (err) { record('dom-watcher-failed', { error: String(err).slice(0, 200) }); }
  };
  document.addEventListener('DOMContentLoaded', attach, { once: true });
  document.addEventListener('readystatechange', attach);
  window.addEventListener('load', attach);
}

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, { ignoreHTTPSErrors: true, viewport: { width: 1600, height: 950 } });
  const consoleErrors = [];
  const steps = [];
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + String(e).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });

    await page.addInitScript(collector);
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(18000); // 等宿主扩展全部加载

    /** 执行一步：先清空页面侧记录，再跑 action，最后取回该步新增的 toast */
    const step = async (name, action, settleMs = 4000) => {
      await page.evaluate(() => { window.__toastLog = (window.__toastLog || []).slice(0, 0); });
      let outcome;
      try {
        outcome = await action();
      } catch (err) {
        outcome = { error: String(err).slice(0, 200) };
      }
      await page.waitForTimeout(settleMs);
      const toasts = await page.evaluate(() => (window.__toastLog || []).filter((x) => x.kind !== 'wrapped' && x.kind !== 'dom-watcher'));
      steps.push({ step: name, outcome, toasts });
      return toasts;
    };

    // A 打开账号弹层
    await step('A 打开账号弹层', () => page.evaluate(() => {
      const b = document.getElementById('account_button');
      if (!b) return { clicked: false };
      b.click();
      return { clicked: true };
    }));

    // B 点插件在账号弹层注入的「数据包互转」
    await step('B 点注入按钮·数据包互转', () => page.evaluate(() => {
      const b = document.getElementById('st-zip-converter-native-btn');
      if (!b) return { clicked: false, reason: 'btn-absent' };
      b.click();
      return { clicked: true };
    }));

    // C 点宿主扩展菜单里的插件项
    await step('C 点扩展菜单插件项', () => page.evaluate(() => {
      const item = document.getElementById('st-zip-converter-menu-item');
      if (!item) return { clicked: false, reason: 'menu-item-absent' };
      const visible = !!item.offsetParent;
      item.click();
      return { clicked: true, visible };
    }));

    // D 重开账号弹层 → 点宿主原生备份按钮（打开 Luker 备份管理器）
    await step('D 点宿主原生备份按钮', () => page.evaluate(() => {
      const close = document.querySelector('.popup-button-close, #dialogue_popup_ok, .popup_ok');
      if (close) close.click();
      const acct = document.getElementById('account_button');
      if (acct) acct.click();
      const native = document.querySelector('.userBackupButton');
      if (!native) return { clicked: false, reason: 'userBackupButton-absent' };
      native.click();
      return { clicked: true };
    }), 6000);

    // E 点备份管理器里的插件注入按钮
    await step('E 点注入按钮·备份管理器', () => page.evaluate(() => {
      const b = document.getElementById('st-zip-converter-luker-manager-btn');
      if (!b) return { clicked: false, reason: 'btn-absent' };
      b.click();
      return { clicked: true };
    }));

    if (DO_FETCH) {
      // F 一键拉取（真实拉 Dev 数据包）
      await step('F 一键拉取', () => page.evaluate(() => {
        const close = document.querySelector('.popup-button-close, #dialogue_popup_ok, .popup_ok');
        if (close) close.click();
        const acct = document.getElementById('account_button');
        if (acct) acct.click();
        const b = document.getElementById('st-zip-converter-native-btn-quick-fetch');
        if (!b) return { clicked: false, reason: 'quick-fetch-absent' };
        b.click();
        return { clicked: true };
      }), 30000);
    }

    const injected = await page.evaluate(() => ({
      nativeBtnParent: document.getElementById('st-zip-converter-native-btn')?.parentElement?.className || null,
      quickFetchPresent: !!document.getElementById('st-zip-converter-native-btn-quick-fetch'),
      managerBtnPresent: !!document.getElementById('st-zip-converter-luker-manager-btn'),
      menuItemParent: document.getElementById('st-zip-converter-menu-item')?.parentElement?.id
        || document.getElementById('st-zip-converter-menu-item')?.parentElement?.className || null,
      drawerPresent: !!document.querySelector('#app.st-converter-drawer-app'),
      toastContainer: document.getElementById('toast-container')?.id || null,
    }));

    fs.writeFileSync(OUT, JSON.stringify({
      sampledAt: new Date().toISOString(), url: BASE, withFetch: DO_FETCH, injected, steps,
      consoleErrors: consoleErrors.slice(0, 30),
    }, null, 2), 'utf8');

    console.log(JSON.stringify({
      injected,
      perStep: steps.map((s) => ({ step: s.step, outcome: s.outcome, toastCount: s.toasts.length, toasts: s.toasts.slice(0, 4) })),
    }, null, 1));
  } finally {
    await ctx.close();
  }
})();
