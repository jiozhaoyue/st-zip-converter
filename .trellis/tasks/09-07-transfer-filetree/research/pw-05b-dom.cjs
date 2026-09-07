/** 实测 05b：日志行 DOM 累积 + 抽屉内持续动画盘点 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  let page = null;
  for (const p of ctx.pages()) { if (p.url().includes('127.0.0.1:8004')) { page = p; break; } }
  const r = await page.evaluate(() => {
    const stream = document.getElementById('log-stream-container');
    const drawer = document.querySelector('.st-converter-drawer-app');
    const anims = [];
    drawer && drawer.querySelectorAll('*').forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.animationName !== 'none') {
        anims.push({ cls: (el.className || '').toString().slice(0, 40), name: cs.animationName, dur: cs.animationDuration, infinite: cs.animationIterationCount === 'infinite' });
      }
    });
    return {
      logLineCount: stream ? stream.querySelectorAll('.log-line').length : -1,
      logStreamScrollHeight: stream ? stream.scrollHeight : -1,
      totalDrawerNodes: drawer ? drawer.getElementsByTagName('*').length : -1,
      animations: anims.slice(0, 15),
    };
  });
  console.log(JSON.stringify(r, null, 2));
})();
