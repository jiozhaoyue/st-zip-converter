/**
 * 复测：四项修复真机验证
 * 1. 徽标唯一（无重复 id，无重复 status-row）
 * 2. 配额条 = 浏览器配额 + 用户配额
 * 3. 拉取进度 = 阶段+实时速度文案
 * 4. 拉取期 longtask 应显著减少（rAF 节流后）
 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  let page = null;
  for (const p of ctx.pages()) { if (p.url().includes('127.0.0.1:8004')) { page = p; break; } }

  // 强刷加载新插件代码
  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => typeof globalThis.lukerContext !== 'undefined', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(5000);

  // 1+2: 静态检查
  const ui = await page.evaluate(() => {
    const drawer = document.querySelector('.st-converter-drawer-app');
    const envBadges = document.querySelectorAll('#env-badge').length;
    const statusRows = document.querySelectorAll('#status-row').length;
    const hostTags = document.querySelectorAll('.host-tag-platform').length;
    const envText = document.getElementById('env-badge')?.textContent || '';
    const dash = document.getElementById('usage-dashboard')?.textContent?.replace(/\s+/g, ' ') || '';
    return { envBadges, statusRows, hostTags, envText, dashboard: dash.slice(0, 160) };
  });
  console.log('== 徽标与配额 ==');
  console.log(JSON.stringify(ui, null, 2));

  // 3+4: 启动拉取，采样进度文案与 longtask
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
    const s = await page.evaluate(() => ({
      status: document.getElementById('status-label')?.textContent?.slice(0, 100) || '',
    }));
    samples.push(s.status);
  }
  // 中止
  await page.evaluate(() => {
    const btn = document.getElementById('tc-abort');
    if (btn && btn.offsetParent) btn.click();
  });
  await page.waitForTimeout(1200);
  const perf = await page.evaluate(() => {
    window.__po.disconnect();
    return { longTaskCount: window.__lt.length, totalMs: window.__lt.reduce((s, d) => s + d, 0), top: [...window.__lt].sort((a,b)=>b-a).slice(0,3) };
  });
  console.log('== 拉取进度文案采样 ==');
  for (const s of samples.filter((_, i) => i % 2 === 0)) console.log(' ·', s);
  console.log('== longtask（修复后应显著少于 14 个） ==');
  console.log(JSON.stringify(perf, null, 2));
})();
