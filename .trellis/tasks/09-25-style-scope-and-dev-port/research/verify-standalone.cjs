/** 独立态外观回归核对（本地 3040，纯前端本地页，只读） */
const path = require('path');
const fs = require('fs');
function loadPlaywright() {
  try { return require('playwright'); } catch {
    const g = require('child_process').execSync('npm root -g').toString().trim();
    return require(path.join(g, 'playwright'));
  }
}
const { chromium } = loadPlaywright();
const OUT = path.join(__dirname, 'standalone-check.json');
(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('http://localhost:3040/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    const r = await page.evaluate(() => {
      const root = document.querySelector('#app.app-container');
      const cs = root ? getComputedStyle(root) : null;
      const before = root ? getComputedStyle(root, '::before') : null;
      const rect = root ? root.getBoundingClientRect() : null;
      return {
        title: document.title,
        hasStandaloneMarker: !!root && root.classList.contains('app-standalone'),
        bodyBgImage: getComputedStyle(document.body).backgroundImage,
        bodyBgColor: getComputedStyle(document.body).backgroundColor,
        bodyFont: getComputedStyle(document.body).fontFamily,
        rootWidth: rect ? Math.round(rect.width) : null,
        rootLeft: rect ? Math.round(rect.left) : null,
        rootRightGap: rect ? Math.round(window.innerWidth - rect.right) : null,
        rootFont: cs ? cs.fontFamily : null,
        rootLineHeight: cs ? cs.lineHeight : null,
        rootColor: cs ? cs.color : null,
        rootMinHeight: cs ? cs.minHeight : null,
        rootPadding: cs ? cs.padding : null,
        beforePosition: before ? before.position : null,
        beforeInset: before ? `${before.top}/${before.right}/${before.bottom}/${before.left}` : null,
        beforeBg: before ? (before.backgroundColor || before.backgroundImage) : null,
      };
    });
    fs.writeFileSync(OUT, JSON.stringify({ sampledAt: new Date().toISOString(), result: r }, null, 2), 'utf8');
    console.log(JSON.stringify(r, null, 1));
  } finally { await browser.close(); }
})();
