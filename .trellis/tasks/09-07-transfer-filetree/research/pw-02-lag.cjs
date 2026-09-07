/**
 * 实测 02：宿主页卡顿量化（longtask 采样 15s）+ 插件事件监听/定时器盘点
 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  let page = null;
  for (const p of ctx.pages()) {
    if (p.url().includes('127.0.0.1:8004')) { page = p; break; }
  }
  if (!page) { console.log('NO_PAGE'); return; }

  // 注入 longtask 采样器（页面内 15 秒）
  await page.evaluate(() => {
    window.__lt = [];
    window.__po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__lt.push({ start: Math.round(e.startTime), dur: Math.round(e.duration), name: e.name });
      }
    });
    window.__po.observe({ entryTypes: ['longtask'] });
    window.__busyMs = 0;
    window.__busyStart = performance.now();
    window.__busyTimer = setInterval(() => {
      window.__busyMs += 50; // 粗采样：setInterval 漂移即主线程繁忙
    }, 50);
  });

  await page.waitForTimeout(15000);

  const result = await page.evaluate(() => {
    clearInterval(window.__busyTimer);
    window.__po.disconnect();
    const wall = performance.now() - window.__busyStart;
    const totalLt = window.__lt.reduce((s, e) => s + e.dur, 0);
    const top = [...window.__lt].sort((a, b) => b.dur - a.dur).slice(0, 8);
    return {
      wallMs: Math.round(wall),
      longTaskCount: window.__lt.length,
      longTaskTotalMs: Math.round(totalLt),
      busyPercent: Math.round((totalLt / wall) * 100),
      topLongTasks: top,
      timers: {
        // 盘点插件可能注册的定时器数量（无法直接枚举，用启发：性能面板误差）
      },
    };
  });
  console.log('== 15s 主线程采样 ==');
  console.log(JSON.stringify(result, null, 2));

  // 插件监听器/observer 盘点：查找插件容器上的事件与 DOM 变动观察
  const probe = await page.evaluate(() => {
    const drawer = document.querySelector('.st-converter-drawer-app');
    const out = { inputCount: 0, observerHints: [] };
    if (drawer) {
      out.inputCount = drawer.querySelectorAll('input,select,textarea,button').length;
      out.logLines = drawer.querySelectorAll('.log-line, [class*="log-line"]').length;
      const logMount = document.getElementById('log-console-mount');
      out.logConsoleChildren = logMount ? logMount.children.length : 0;
    }
    // 全页 DOM 规模（卡顿常见根因：DOM 过大 + 频繁重排）
    out.totalDomNodes = document.getElementsByTagName('*').length;
    out.drawerDomNodes = drawer ? drawer.getElementsByTagName('*').length : 0;
    return out;
  });
  console.log('== DOM/监听盘点 ==');
  console.log(JSON.stringify(probe, null, 2));
})();
