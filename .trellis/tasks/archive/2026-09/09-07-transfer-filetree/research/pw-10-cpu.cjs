/**
 * 实测 10：整个页面 15s CPU 时间（performance.memory / CDP Performance.getMetrics）
 * 展开插件抽屉 vs 收起：量真实 CPU 消耗差
 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  let page = null;
  for (const p of ctx.pages()) { if (p.url().includes('127.0.0.1:8004')) { page = p; break; } }
  const cdp = await ctx.newCDPSession(page);

  async function cpuFor(durationMs, expanded) {
    await cdp.send('Performance.enable');
    const m0 = await cdp.send('Performance.getMetrics');
    await page.waitForTimeout(durationMs);
    const m1 = await cdp.send('Performance.getMetrics');
    const pick = (arr, name) => (arr && Array.isArray(arr.metrics) ? arr.metrics.find((m) => m.name === name)?.value ?? 0 : 0);
    return {
      expanded,
      scriptDurationDeltaMs: Math.round((pick(m1.metrics, 'ScriptDuration') - pick(m0.metrics, 'ScriptDuration')) * 1000),
      layoutDurationDeltaMs: Math.round((pick(m1.metrics, 'LayoutDuration') - pick(m0.metrics, 'LayoutDuration')) * 1000),
      recalcStyleDeltaMs: Math.round((pick(m1.metrics, 'RecalcStyleCount') - pick(m0.metrics, 'RecalcStyleCount'))),
      nodes: pick(m1.metrics, 'Nodes'),
      jsHeapMB: Math.round(pick(m1.metrics, 'JSHeapUsedSize') / 1048576 * 10) / 10,
    };
  }

  // 展开
  await page.evaluate(() => {
    const c = document.querySelector('#st_zip_converter_settings > .inline-drawer-content');
    if (c) c.style.display = 'block';
  });
  await page.waitForTimeout(600);
  const exp = await cpuFor(12000, true);
  // 收起
  await page.evaluate(() => {
    const c = document.querySelector('#st_zip_converter_settings > .inline-drawer-content');
    if (c) c.style.display = 'none';
  });
  await page.waitForTimeout(600);
  const col = await cpuFor(12000, false);
  console.log(JSON.stringify({ expanded: exp, collapsed: col }, null, 2));
})();
