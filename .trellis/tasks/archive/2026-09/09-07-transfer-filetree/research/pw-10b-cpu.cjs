/** 实测 10b：CDP Performance.getMetrics 正确读取（返回 {metrics:[{name,value}]}）*/
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  let page = null;
  for (const p of ctx.pages()) { if (p.url().includes('127.0.0.1:8004')) { page = p; break; } }
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  const probe = await cdp.send('Performance.getMetrics');
  console.log('RAW keys:', Object.keys(probe));
  console.log('sample:', JSON.stringify((probe.metrics || probe).slice ? (probe.metrics || probe).slice(0, 3) : probe).slice(0, 200));

  async function delta(ms) {
    const m0 = await cdp.send('Performance.getMetrics');
    await page.waitForTimeout(ms);
    const m1 = await cdp.send('Performance.getMetrics');
    const A = m0.metrics || m0, B = m1.metrics || m1;
    const get = (arr, n) => arr.find((m) => m.name === n)?.value ?? 0;
    return {
      scriptMs: Math.round((get(B, 'ScriptDuration') - get(A, 'ScriptDuration')) * 1000),
      layoutMs: Math.round((get(B, 'LayoutDuration') - get(A, 'LayoutDuration')) * 1000),
      styleRecalc: Math.round(get(B, 'RecalcStyleCount') - get(A, 'RecalcStyleCount')),
      nodes: Math.round(get(B, 'Nodes')),
      heapMB: Math.round(get(B, 'JSHeapUsedSize') / 1048576),
    };
  }

  await page.evaluate(() => {
    const c = document.querySelector('#st_zip_converter_settings > .inline-drawer-content');
    if (c) c.style.display = 'block';
  });
  await page.waitForTimeout(600);
  const expanded = await delta(12000);
  await page.evaluate(() => {
    const c = document.querySelector('#st_zip_converter_settings > .inline-drawer-content');
    if (c) c.style.display = 'none';
  });
  await page.waitForTimeout(600);
  const collapsed = await delta(12000);
  console.log(JSON.stringify({ expanded, collapsed }, null, 2));
})();
