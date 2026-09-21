/**
 * 实测 08f（决定性）：8004 页面 rAF 锁 1s 是「有东西在每秒跑一个大任务」。
 * PerformanceObserver longtask + longtask attribution + 检查 document 上的
 * animation frame 消费者。给 8004 页面连续 5 秒 rAF 步进，同时收集 longtask 时刻对齐。
 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  let page = null;
  for (const p of ctx.pages()) { if (p.url().includes('127.0.0.1:8004')) { page = p; break; } }
  const r = await page.evaluate(async () => {
    const lts = [];
    const po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) lts.push({ t: Math.round(e.startTime), d: Math.round(e.duration) });
    });
    po.observe({ entryTypes: ['longtask'] });

    // 5 秒内同时量 rAF 间隔与 longtask
    const gaps = [];
    const t0 = performance.now();
    let last = t0;
    await new Promise((resolve) => {
      function step(t) {
        gaps.push(Math.round(t - last));
        last = t;
        if (t - t0 > 5000) resolve();
        else requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
    po.disconnect();
    // 每秒 rAF 次数
    const perSecond = Math.round(gaps.length / 5);
    const big = gaps.filter((g) => g > 200);
    return { framesIn5s: gaps.length, perSecond, bigGaps: big.slice(0, 10), longtasks: lts.slice(0, 10) };
  });
  console.log(JSON.stringify(r, null, 2));
})();
