/** 诊断：Dev Luker 8003 上插件为何未加载（只读：看禁用清单 + 控制台报错 + 扩展清单） */
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
  const errors = [];
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 200)));
    await page.goto('https://127.0.0.1:8003/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
    const r = await page.evaluate(async () => {
      const out = {};
      const ctxObj = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? SillyTavern.getContext() : null;
      try {
        const es = ctxObj?.extensionSettings || {};
        out.disabledExtensions = es.disabledExtensions || null;
        out.hasDisabledList = Array.isArray(es.disabledExtensions);
      } catch (e) { out.esError = String(e).slice(0, 120); }
      try {
        const res = await fetch('/api/extensions/discover', { method: 'POST', credentials: 'same-origin', headers: ctxObj?.getRequestHeaders?.() || {} });
        const j = await res.json().catch(() => null);
        const list = Array.isArray(j) ? j : (j?.extensions || []);
        out.discoverStatus = res.status;
        out.discoverHasZipConverter = JSON.stringify(list).includes('st-zip-converter');
        out.discoverSample = JSON.stringify(list).slice(0, 300);
      } catch (e) { out.discoverError = String(e).slice(0, 150); }
      return out;
    });
    console.log(JSON.stringify({ ...r, consoleErrors: errors.slice(0, 12) }, null, 1));
  } finally { await ctx.close(); }
})();
