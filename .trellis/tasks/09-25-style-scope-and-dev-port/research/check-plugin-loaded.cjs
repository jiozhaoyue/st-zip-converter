/** 快速核对：本插件在 Dev Luker 8003 上是否仍然加载（只读） */
const path = require('path');
function loadPlaywright() {
  try { return require('playwright'); } catch {
    const g = require('child_process').execSync('npm root -g').toString().trim();
    return require(path.join(g, 'playwright'));
  }
}
const { chromium } = loadPlaywright();
const PROFILE = path.resolve(__dirname, '../../../../.p w-profile-dev'.replace(' ', ''));
(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, { ignoreHTTPSErrors: true });
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://127.0.0.1:8003/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    const r = await page.evaluate(() => ({
      sheets: Array.from(document.styleSheets).map((s) => s.href).filter(Boolean).filter((h) => h.includes('zip-converter')),
      menuItem: !!document.getElementById('st-zip-converter-menu-item'),
      settingsBlock: !!document.getElementById('st_zip_converter_settings'),
      drawerApp: !!document.querySelector('.st-converter-drawer-app'),
      appContainer: document.querySelectorAll('.app-container').length,
    }));
    console.log(JSON.stringify(r, null, 1));
  } finally { await ctx.close(); }
})();
