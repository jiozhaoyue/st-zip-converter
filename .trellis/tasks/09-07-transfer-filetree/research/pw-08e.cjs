/** 实测 08e：新开 about:blank 标签在同一个 Chrome 里测 rAF——区分页面问题 vs 全浏览器问题 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const p2 = await ctx.newPage();
  await p2.goto('about:blank');
  const r = await p2.evaluate(async () => {
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
    return { p50: stamps[10], min: stamps[0] };
  });
  await p2.close();
  console.log(JSON.stringify(r));
})();
