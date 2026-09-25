/**
 * 隐患消除验证（合成页，在本地 dev 上加载**当前** style.css）：
 * 构造「第三方扩展把 .app-container 直接挂在 body 下」的 DOM（无本插件 marker 类），
 * 断言宿主 body 的计算样式**不被插件改动**（改前的老规则正是靠这个形态生效）。
 */
const path = require('path');
const fs = require('fs');
function loadPlaywright() {
  try { return require('playwright'); } catch {
    const g = require('child_process').execSync('npm root -g').toString().trim();
    return require(path.join(g, 'playwright'));
  }
}
const { chromium } = loadPlaywright();
const OUT = path.join(__dirname, 'hazard-gone.json');
(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    // 模拟第三方：body 直接子元素带 .app-container，但**没有** app-standalone marker
    await page.setContent(`<!DOCTYPE html><html><head>
      <link rel="stylesheet" href="http://localhost:3040/style.css">
      </head><body><div class="app-container third-party"><p>third-party app</p></div></body></html>`,
      { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => {
      const bodyCs = getComputedStyle(document.body);
      const el = document.querySelector('.app-container');
      return {
        hazardShapePresent: document.body.matches('body:has(> .app-container)'),
        bodyBackgroundImage: bodyCs.backgroundImage,
        bodyBackgroundColor: bodyCs.backgroundColor,
        bodyFontFamily: bodyCs.fontFamily,
        bodyPadding: bodyCs.padding,
        bodyDisplay: bodyCs.display,
        bodyMinHeight: bodyCs.minHeight,
        thirdPartyWidth: Math.round(el.getBoundingClientRect().width),
        thirdPartyHasPageBackdrop: !!getComputedStyle(el, '::before').content && getComputedStyle(el, '::before').content !== 'none',
      };
    });
    fs.writeFileSync(OUT, JSON.stringify({ sampledAt: new Date().toISOString(), result: r }, null, 2), 'utf8');
    console.log(JSON.stringify(r, null, 1));
  } finally { await browser.close(); }
})();
