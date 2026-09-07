/** 排查：reload 后插件抽屉是否还挂载（扩展抽屉可能按需注入） */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  let page = null;
  for (const p of ctx.pages()) { if (p.url().includes('127.0.0.1:8004')) { page = p; break; } }
  const r = await page.evaluate(() => ({
    panel: Boolean(document.getElementById('st-zip-converter-settings-panel')),
    drawerApp: Boolean(document.querySelector('.st-converter-drawer-app')),
    extSettings2: Boolean(document.getElementById('extensions_settings2')),
    extSettings: Boolean(document.getElementById('extensions_settings')),
    menuItem: Boolean(document.getElementById('st-zip-converter-menu-item')),
    url: location.href,
  }));
  console.log(JSON.stringify(r, null, 2));
})();
