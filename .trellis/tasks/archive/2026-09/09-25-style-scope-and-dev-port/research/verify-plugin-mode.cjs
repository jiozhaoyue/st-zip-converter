/** 插件态实机回归核对（Dev 8003，只读）：确认根选择器收紧后抽屉态仍正常渲染 */
const path = require('path');
const fs = require('fs');
function loadPlaywright() {
  try { return require('playwright'); } catch {
    const g = require('child_process').execSync('npm root -g').toString().trim();
    return require(path.join(g, 'playwright'));
  }
}
const { chromium } = loadPlaywright();
const PROFILE = path.resolve(__dirname, '../../../../.pw-profile-dev');
const OUT = path.join(__dirname, 'plugin-mode-check.json');
(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, { ignoreHTTPSErrors: true, viewport: { width: 1600, height: 950 } });
  const errors = [];
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 160)));
    page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text().slice(0, 160)); });
    await page.goto('https://127.0.0.1:8003/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(18000);
    const r = await page.evaluate(() => {
      const drawer = document.querySelector('#app.st-converter-drawer-app');
      const card = drawer?.querySelector('.card') || drawer?.querySelector('.zone-card');
      const dropzone = drawer?.querySelector('#dropzone');
      const cs = card ? getComputedStyle(card) : null;
      return {
        drawerPresent: !!drawer,
        settingsDrawer: !!document.getElementById('st_zip_converter_settings'),
        menuItem: !!document.getElementById('st-zip-converter-menu-item'),
        cardsInDrawer: drawer ? drawer.querySelectorAll('.card, .zone-card').length : 0,
        dropzoneVisible: !!dropzone && getComputedStyle(dropzone).display !== 'none',
        cardBackground: cs ? cs.backgroundColor : null,
        cardBorder: cs ? cs.borderTopColor : null,
        cardRadius: cs ? cs.borderRadius : null,
        bodyUntouched: {
          bgImage: getComputedStyle(document.body).backgroundImage,
          bgColor: getComputedStyle(document.body).backgroundColor,
        },
      };
    });
    fs.writeFileSync(OUT, JSON.stringify({ sampledAt: new Date().toISOString(), result: r, consoleErrors: errors }, null, 2), 'utf8');
    console.log(JSON.stringify({ ...r, consoleErrors: errors.slice(0, 5) }, null, 1));
  } finally { await ctx.close(); }
})();
