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
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://127.0.0.1:8003/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
    const r = await page.evaluate(() => ({
      ourScripts: Array.from(document.querySelectorAll('script[src]')).map((s) => s.src).filter((s) => s.includes('zip-converter')),
      anyStZip: Array.from(document.querySelectorAll('[id*="st_zip"],[class*="st-converter"],[id*="st-zip"]')).slice(0, 6)
        .map((el) => `${el.tagName.toLowerCase()}#${el.id}.${String(el.className).slice(0, 40)}`),
      extensionBlocks: document.querySelectorAll('#extensions_settings2 .extension_block, #extensions_settings .extension_block').length,
      globalVar: typeof window.stZipConverterLoaded !== 'undefined' ? String(window.stZipConverterLoaded) : 'n/a',
    }));
    console.log(JSON.stringify(r, null, 1));
  } finally { await ctx.close(); }
})();
