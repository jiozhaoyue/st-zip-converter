/**
 * 实测 05：抽屉打开态持续卡主因量化
 * - 插件日志行 DOM 数量（无上限累积 = 每条日志全量重排）
 * - 日志滚动容器高度
 * - 抽屉展开/收起时序（性能面）
 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  let page = null;
  for (const p of ctx.pages()) { if (p.url().includes('127.0.0.1:8004')) { page = p; break; } }
  const r = await page.evaluate(() => {
    const drawer = document.querySelector('.st-converter-drawer-app');
    const stream = drawer ? drawer.querySelector('.log-stream, [class*="log-stream"]') : null;
    return {
      logLineCount: stream ? stream.querySelectorAll('.log-line').length : -1,
      logStreamHeight: stream ? stream.scrollHeight : -1,
      drawerVisible: drawer ? drawer.offsetHeight : -1,
      // 是否有 CSS animation/transition 持续跑（打开态持续 GPU/CPU 消耗）
      animatedEls: (() => {
        let n = 0;
        drawer && drawer.querySelectorAll('*').forEach((el) => {
          const cs = getComputedStyle(el);
          if (cs.animationName !== 'none' || (cs.transitionDuration !== '0s' && cs.transitionProperty !== 'all' && cs.transitionProperty !== 'none')) n++;
        });
        return n;
      })(),
      pulseAnimations: (() => {
        let n = 0;
        drawer && drawer.querySelectorAll('*').forEach((el) => {
          const cs = getComputedStyle(el);
          if (cs.animationName !== 'none' && cs.animationPlayState === 'running') n++;
        });
        return n;
      })(),
    };
  });
  console.log(JSON.stringify(r, null, 2));
})();
