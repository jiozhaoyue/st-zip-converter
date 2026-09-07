/** 复测（修正版）：插件容器在 settings 面板内部，直接查内部元素 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  let page = null;
  for (const p of ctx.pages()) { if (p.url().includes('127.0.0.1:8004')) { page = p; break; } }

  const ui = await page.evaluate(() => {
    const drawer = document.querySelector('.st-converter-drawer-app');
    const envBadges = drawer.querySelectorAll('#env-badge').length;
    const statusRows = drawer.querySelectorAll('#status-row').length;
    const hostTags = drawer.querySelectorAll('.host-tag-platform').length;
    const envText = drawer.querySelector('#env-badge')?.textContent || '';
    const dash = drawer.querySelector('#usage-dashboard')?.textContent?.replace(/\s+/g, ' ') || '';
    return { envBadges, statusRows, hostTags, envText, dashboard: dash.slice(0, 200) };
  });
  console.log('== 徽标与配额 ==');
  console.log(JSON.stringify(ui, null, 2));

  // 3+4: 启动拉取采样
  await page.evaluate(() => {
    const d = document.getElementById('st_zip_converter_settings');
    const c = d && d.querySelector(':scope > .inline-drawer-content');
    if (c) c.style.display = 'block';
    window.__lt = [];
    window.__po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration));
    });
    window.__po.observe({ entryTypes: ['longtask'] });
    document.getElementById('btn-host-fetch').click();
  });

  const samples = [];
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(1000);
    samples.push(await page.evaluate(() => document.getElementById('status-label')?.textContent?.slice(0, 110) || ''));
  }
  await page.evaluate(() => {
    const btn = document.getElementById('tc-abort');
    if (btn && btn.offsetParent) btn.click();
  });
  await page.waitForTimeout(1200);
  const perf = await page.evaluate(() => {
    window.__po.disconnect();
    return { longTaskCount: window.__lt.length, totalMs: window.__lt.reduce((s, d) => s + d, 0), top: [...window.__lt].sort((a,b)=>b-a).slice(0,3) };
  });
  console.log('== 拉取进度文案 ==');
  for (const s of samples.filter((_, i) => i % 2 === 0)) console.log(' ·', s);
  console.log('== longtask（修复前 14 个/20s） ==');
  console.log(JSON.stringify(perf, null, 2));
})();
