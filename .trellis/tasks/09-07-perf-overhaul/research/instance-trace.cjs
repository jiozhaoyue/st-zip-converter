const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await page.goto('https://127.0.0.1:8004/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => typeof globalThis.SillyTavern !== 'undefined', { timeout: 30000 }).catch(() => {});

  // 空闲期采样：主线程长任务 + 内存 + 扩展数量
  await page.evaluate(() => {
    window.__tasks = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__tasks.push([e.startTime | 0, e.duration | 0]); }).observe({ entryTypes: ['longtask'] });
  });
  await page.waitForTimeout(8000); // 空闲观察 8 秒

  const report = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script[src]')).map((s) => s.src).filter((s) => s.includes('extensions/third-party'));
    return {
      longTasks: window.__tasks,
      jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      thirdPartyScripts: scripts.length,
      domNodes: document.querySelectorAll('*').length,
      iframes: document.querySelectorAll('iframe').length,
      extensionsList: scripts.map((s) => s.split('/extensions/')[1]?.split('/')[0]).filter(Boolean),
    };
  });
  console.log('Luker 实例空闲期性能采样:', JSON.stringify(report, null, 2));
  await browser.close();
})();
