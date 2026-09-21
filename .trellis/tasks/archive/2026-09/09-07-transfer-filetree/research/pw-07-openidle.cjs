/** 实测 07：抽屉展开 vs 收起 各 10s 主线程漂移对比（不动任何东西） */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  let page = null;
  for (const p of ctx.pages()) { if (p.url().includes('127.0.0.1:8004')) { page = p; break; } }

  async function sampleDrift(ms) {
    return page.evaluate((dur) => new Promise((resolve) => {
      const drifts = [];
      let last = performance.now();
      const timer = setInterval(() => {
        const now = performance.now();
        drifts.push(now - last - 10);
        last = now;
      }, 10);
      setTimeout(() => {
        clearInterval(timer);
        drifts.sort((a, b) => a - b);
        resolve({
          n: drifts.length,
          p50: +drifts[Math.floor(drifts.length * 0.5)].toFixed(1),
          p95: +drifts[Math.floor(drifts.length * 0.95)].toFixed(1),
          max: +drifts[drifts.length - 1].toFixed(1),
          over50: drifts.filter((d) => d > 50).length,
        });
      }, dur);
    }), ms);
  }

  // 收起抽屉
  await page.evaluate(() => {
    const d = document.getElementById('st_zip_converter_settings');
    const c = d && d.querySelector(':scope > .inline-drawer-content');
    if (c) c.style.display = 'none';
  });
  await page.waitForTimeout(500);
  const collapsed = await sampleDrift(10000);

  // 展开抽屉
  await page.evaluate(() => {
    const d = document.getElementById('st_zip_converter_settings');
    const c = d && d.querySelector(':scope > .inline-drawer-content');
    if (c) c.style.display = 'block';
  });
  await page.waitForTimeout(500);
  const expanded = await sampleDrift(10000);

  console.log(JSON.stringify({ collapsed, expanded }, null, 2));
})();
