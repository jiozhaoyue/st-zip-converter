/** 最终复测：刷新页面验证徽标短版本号 + 截图存档 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  let page = null;
  for (const p of ctx.pages()) { if (p.url().includes('127.0.0.1:8004')) { page = p; break; } }
  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => typeof globalThis.lukerContext !== 'undefined', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(6000);
  const r = await page.evaluate(() => {
    const drawer = document.querySelector('.st-converter-drawer-app');
    return {
      badge: drawer.querySelector('#env-badge')?.textContent || '',
      quota: drawer.querySelector('#usage-dashboard')?.textContent?.replace(/\s+/g, ' ').slice(0, 140) || '',
    };
  });
  // 展开抽屉截图
  await page.evaluate(() => {
    const c = document.querySelector('#st_zip_converter_settings > .inline-drawer-content');
    if (c) c.style.display = 'block';
  });
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'D:/Repo/Tavern-repo/My-repo/ST-zip-converter/.trellis/tasks/09-07-transfer-filetree/research/final-verify.png' });
  console.log(JSON.stringify(r, null, 2));
})();
