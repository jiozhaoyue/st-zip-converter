/**
 * 实测 08d：rAF 1000ms 挂起是页面级还是 headless/CDP 节流？
 * 对照：页面可见性、CPU 节流、以及原生动画钟 requestAnimationFrame+performance.now 差分。
 * 再对照普通网页（example.com 新标签）排除 CDP 连接本身。
 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  let page = null;
  for (const p of ctx.pages()) { if (p.url().includes('127.0.0.1:8004')) { page = p; break; } }

  const info = await page.evaluate(() => ({
    visibility: document.visibilityState,
    hidden: document.hidden,
    hasFocus: document.hasFocus(),
  }));

  const r = await page.evaluate(async () => {
    // 连续 20 帧 rAF 时间戳差
    const stamps = [];
    await new Promise((resolve) => {
      let last = performance.now();
      let n = 0;
      function step(t) {
        stamps.push(t - last);
        last = t;
        if (++n >= 20) resolve();
        else requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
    stamps.sort((a, b) => a - b);
    return { p50: stamps[10], p95: stamps[19], min: stamps[0], all: stamps.slice(0, 5) };
  });
  console.log(JSON.stringify({ info, frames: r }, null, 2));
})();
