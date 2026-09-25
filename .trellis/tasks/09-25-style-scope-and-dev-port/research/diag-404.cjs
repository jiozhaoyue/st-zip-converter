/** 抓取 Dev Luker 8003 页面加载期间的 404 资源 URL（只读） */
const path = require('path');
function loadPlaywright() {
  try { return require('playwright'); } catch {
    const g = require('child_process').execSync('npm root -g').toString().trim();
    return require(path.join(g, 'playwright'));
  }
}
const { chromium } = loadPlaywright();
const PROFILE = path.resolve(__dirname, '../../../../.pw-profile-dev');
(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, { ignoreHTTPSErrors: true });
  const bad = [];
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
    await page.goto('https://127.0.0.1:8003/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(7000);
    console.log(JSON.stringify(bad.slice(0, 15), null, 1));
    const probe = await page.evaluate(async () => {
      const urls = [
        '/scripts/extensions/third-party/st-zip-converter/index.js',
        '/scripts/extensions/third-party/st-zip-converter/style.css',
        '/scripts/extensions/third-party/st-zip-converter/src/core/restore-batch.js',
      ];
      const out = {};
      for (const u of urls) {
        try { const r = await fetch(u, { credentials: 'same-origin' }); out[u] = r.status; }
        catch (e) { out[u] = String(e).slice(0, 60); }
      }
      return out;
    });
    console.log(JSON.stringify(probe, null, 1));
  } finally { await ctx.close(); }
})();
