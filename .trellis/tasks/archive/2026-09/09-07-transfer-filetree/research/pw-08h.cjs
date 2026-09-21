/** 实测 08h：收起抽屉再测打字延迟，与展开态对比 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  let page = null;
  for (const p of ctx.pages()) { if (p.url().includes('127.0.0.1:8004')) { page = p; break; } }

  await page.evaluate(() => {
    const c = document.querySelector('#st_zip_converter_settings > .inline-drawer-content');
    if (c) c.style.display = 'none';
  });
  await page.waitForTimeout(300);

  const ta = await page.$('#send_textarea');
  await ta.focus();
  await page.evaluate(() => { document.getElementById('send_textarea').value = ''; });
  const times = [];
  for (let i = 0; i < 15; i++) {
    const t0 = Date.now();
    await page.keyboard.type('a', { delay: 0 });
    await page.evaluate(() => new Promise((res) => requestAnimationFrame(res)));
    times.push(Date.now() - t0);
    await page.waitForTimeout(20);
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ collapsed: { p50: times[7], p95: times[14], max: times[14] } }));
})();
