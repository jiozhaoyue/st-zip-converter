const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await page.goto('https://127.0.0.1:8004/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => typeof globalThis.SillyTavern !== 'undefined', { timeout: 30000 }).catch(() => {});

  await page.evaluate(() => {
    window.__tasks = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__tasks.push([e.startTime | 0, e.duration | 0]); }).observe({ entryTypes: ['longtask'] });
  });
  await page.waitForTimeout(6000);

  const report = await page.evaluate(() => {
    // 第三方扩展脚本路径细节（script.js 是主 bundle，extension 路径形如 .../extensions/third-party/<name>/index.js）
    const scripts = Array.from(document.querySelectorAll('script[src]'))
      .map((s) => s.src)
      .filter((s) => s.includes('third-party'))
      .map((s) => decodeURIComponent(s.split('/third-party/')[1] || '').split('/').slice(0, 2).join('/'));
    // 插件 style 检查：本插件是否装在实例里
    const styles = Array.from(document.querySelectorAll('style, link[rel=stylesheet]'))
      .map((el) => el.href || el.textContent?.slice(0, 40))
      .filter((t) => t && (t.includes('zip-converter') || t.includes('tavern-convert')));
    return {
      longTasks: window.__tasks,
      jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      extensionNames: [...new Set(scripts.map((s) => s.split('/')[0]))],
      converterPluginLoaded: styles.length > 0 || scripts.some((s) => s.includes('zip-converter')),
    };
  });
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})();
