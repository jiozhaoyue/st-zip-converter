/**
 * 宿主原生 toastr 通知「谁触发的」探针（Dev Luker 8003，只读）
 *
 * 背景（2026-09-25 用户报告 + 代码取证）：
 *   用户报「插件会让酒馆弹出一个通知的小长方形」。但本仓 `grep -rni toastr src/ index.js`
 *   **零命中**——插件从不直接调酒馆通知。所以必然是**宿主被插件某个动作间接触发**。
 *   本探针的目标不是猜，而是**把每一条 toast 连同创建时的调用栈一起抓下来**。
 *
 * 手段：
 *   1. `addInitScript` 里给 `window.toastr` 装 setter，宿主一挂上 toastr 就包装其
 *      success/info/warning/error/clear 五个方法，记录 (level, message, stack)；
 *   2. 同时在 `#toast-container`（无则 body）上挂 MutationObserver，兜住不经 toastr 方法
 *      的直接 DOM 插入，记录文本与外层 class；
 *   3. 记录带来源 URL 的 console error / pageerror，便于把 toast 与某条报错对上。
 *
 * 用法：node pw-toast-probe.cjs           # 仅加载期
 *       node pw-toast-probe.cjs --open    # 加载后再点开账号弹层等宿主面板
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
const OUT = path.join(__dirname, 'toast-probe.json');
const OPEN_PANELS = process.argv.includes('--open');

/** 在页面里注入的采集脚本（addInitScript，早于任何页面脚本） */
function collector() {
  window.__toastLog = [];
  window.__toastOrigin = null;

  const stamp = () => new Date().toISOString();
  const stackOf = () => {
    const e = new Error('toast-trace');
    return String(e.stack || '').split('\n').slice(1, 7).join(' | ').slice(0, 700);
  };

  const record = (kind, payload) => {
    window.__toastLog.push(Object.assign({ at: stamp(), kind }, payload));
  };

  // ---- 1. 包装 toastr 五个方法 ----
  const LEVELS = ['success', 'info', 'warning', 'error', 'clear'];
  let toastrRef = null;
  try {
    Object.defineProperty(window, 'toastr', {
      configurable: true,
      get() { return toastrRef; },
      set(v) {
        toastrRef = v;
        if (!v || v.__stZipWrapped) return;
        try {
          Object.defineProperty(v, '__stZipWrapped', { value: true, enumerable: false });
          LEVELS.forEach((lvl) => {
            if (typeof v[lvl] !== 'function') return;
            const orig = v[lvl].bind(v);
            v[lvl] = function (...args) {
              record('toastr-call', {
                level: lvl,
                args: args.map((a) => (typeof a === 'string' ? a.slice(0, 300) : String(a).slice(0, 120))),
                stack: stackOf(),
              });
              return orig(...args);
            };
          });
          record('toastr-wrapped', { levels: LEVELS.filter((l) => typeof v[l] === 'function') });
        } catch (err) {
          record('toastr-wrap-failed', { error: String(err).slice(0, 200) });
        }
      },
    });
  } catch (err) {
    record('toastr-define-failed', { error: String(err).slice(0, 200) });
  }

  // ---- 2. DOM 兜底：容器里冒出来的 .toast ----
  const attachDomWatcher = () => {
    const container = document.getElementById('toast-container') || document.body;
    if (!container || container.__stZipWatched) return;
    try {
      Object.defineProperty(container, '__stZipWatched', { value: true, enumerable: false });
      const seen = new WeakSet();
      const scan = (root) => {
        const nodes = root.matches?.('.toast') ? [root] : [];
        if (root.querySelectorAll) nodes.push(...root.querySelectorAll('.toast'));
        nodes.forEach((n) => {
          if (seen.has(n)) return;
          seen.add(n);
          record('toastr-dom', {
            id: container.id || '(body)',
            className: String(n.className || '').slice(0, 200),
            text: String(n.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
          });
        });
      };
      scan(container);
      new MutationObserver((muts) => {
        muts.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType === 1) scan(n); }));
      }).observe(container, { childList: true, subtree: true });
      record('dom-watcher-attached', { id: container.id || '(body)' });
    } catch (err) {
      record('dom-watcher-failed', { error: String(err).slice(0, 200) });
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachDomWatcher, { once: true });
  }
  document.addEventListener('readystatechange', attachDomWatcher);
  window.addEventListener('load', attachDomWatcher);
}

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 950 },
  });
  const consoleErrors = [];
  const requestFailures = [];
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + String(e).slice(0, 250)));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const loc = m.location && m.location();
      consoleErrors.push(`${m.text().slice(0, 200)} @ ${loc ? loc.url : '?'}:${loc ? loc.lineNumber : '?'}`);
    });
    page.on('requestfailed', (r) => requestFailures.push(`${r.method()} ${r.url().slice(0, 160)} → ${r.failure()?.errorText}`));
    page.on('response', (r) => {
      if (r.status() >= 400) requestFailures.push(`HTTP ${r.status()} ${r.url().slice(0, 160)}`);
    });

    await page.addInitScript(collector);
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(20000);

    if (OPEN_PANELS) {
      // 宿主原生入口按需渲染：先把账号弹层打开，再关掉，观察是否触发 toast
      const opened = await page.evaluate(async () => {
        const btn = document.getElementById('account_button')
          || document.querySelector('#user-settings-button, .user-settings-button, #sys-settings-button');
        if (!btn) return { opened: false, reason: 'no-account-entry' };
        btn.click();
        return { opened: true, id: btn.id || btn.className };
      });
      await page.waitForTimeout(4000);
      await page.evaluate(() => {
        const close = document.querySelector('.popup-button-close, #dialogue_popup_ok, .popup_ok');
        if (close) close.click();
      });
      await page.waitForTimeout(3000);
      var panelOpen = opened;
    }

    const result = await page.evaluate(() => {
      const log = window.__toastLog || [];
      return {
        toastLog: log,
        toastrPresent: typeof window.toastr === 'object' && window.toastr !== null,
        toastContainerExists: !!document.getElementById('toast-container'),
        pluginPresent: {
          drawer: !!document.querySelector('#app.st-converter-drawer-app'),
          settingsPanel: !!document.getElementById('st_zip_converter_settings'),
          menuItem: !!document.getElementById('st-zip-converter-menu-item'),
        },
        injectedButtons: Array.from(document.querySelectorAll('[data-st-zip-injected="1"]'))
          .map((n) => ({ id: n.id, tag: n.tagName, parent: n.parentElement?.className?.slice(0, 60) })),
      };
    });

    fs.writeFileSync(OUT, JSON.stringify({
      sampledAt: new Date().toISOString(),
      url: BASE,
      withPanelOpen: OPEN_PANELS,
      result: Object.assign(result, OPEN_PANELS ? { panelOpen: panelOpen } : {}),
      consoleErrors: consoleErrors.slice(0, 40),
      requestFailures: requestFailures.slice(0, 40),
    }, null, 2), 'utf8');

    console.log(JSON.stringify({
      toastCount: result.toastLog.length,
      toastLog: result.toastLog.slice(0, 8),
      toastrPresent: result.toastrPresent,
      toastContainerExists: result.toastContainerExists,
      pluginPresent: result.pluginPresent,
      errorSample: consoleErrors.slice(0, 6),
      reqFailSample: requestFailures.slice(0, 6),
    }, null, 1));
  } finally {
    await ctx.close();
  }
})();
