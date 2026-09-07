/** 实测 05c：全页动画/过渡/大阴影盘点（打开即持续卡的候选根因） */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  let page = null;
  for (const p of ctx.pages()) { if (p.url().includes('127.0.0.1:8004')) { page = p; break; } }
  const r = await page.evaluate(() => {
    const drawer = document.querySelector('.st-converter-drawer-app');
    const anims = [];
    document.querySelectorAll('*').forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.animationName !== 'none' && cs.animationPlayState === 'running') {
        const inDrawer = drawer && drawer.contains(el);
        anims.push({ inDrawer, cls: (el.className || el.tagName || '').toString().slice(0, 40), name: cs.animationName, dur: cs.animationDuration, infinite: cs.animationIterationCount === 'infinite' });
      }
    });
    // 抽屉内 backdrop-filter / box-shadow 大面积层（合成层爆炸候选）
    let heavyEffects = 0;
    if (drawer) {
      drawer.querySelectorAll('*').forEach((el) => {
        const cs = getComputedStyle(el);
        if (cs.backdropFilter && cs.backdropFilter !== 'none') heavyEffects++;
      });
    }
    return {
      runningAnimations: anims.length,
      anims: anims.slice(0, 20),
      drawerBackdropFilterEls: heavyEffects,
      drawerNodes: drawer ? drawer.getElementsByTagName('*').length : -1,
    };
  });
  console.log(JSON.stringify(r, null, 2));
})();
