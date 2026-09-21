/**
 * 实测 09：展开抽屉瞬间的 longtask 采样（用户报告"展开瞬间卡"）
 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  let page = null;
  for (const p of ctx.pages()) { if (p.url().includes('127.0.0.1:8004')) { page = p; break; } }

  // 先收起
  await page.evaluate(() => {
    const c = document.querySelector('#st_zip_converter_settings > .inline-drawer-content');
    if (c) c.style.display = 'none';
  });
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    window.__lt = [];
    window.__po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__lt.push({ t: Math.round(e.startTime), d: Math.round(e.duration) });
    });
    window.__po.observe({ entryTypes: ['longtask'] });
  });

  // 展开瞬间
  await page.evaluate(() => {
    const c = document.querySelector('#st_zip_converter_settings > .inline-drawer-content');
    if (c) c.style.display = 'block';
  });
  await page.waitForTimeout(2500);

  const r = await page.evaluate(() => {
    window.__po.disconnect();
    return { longtasks: window.__lt, count: window.__lt.length, totalMs: window.__lt.reduce((s, e) => s + e.d, 0) };
  });
  console.log(JSON.stringify(r, null, 2));
})();
