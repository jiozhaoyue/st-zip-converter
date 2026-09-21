/** 实测 08b：单次双 rAF 是否挂起排查 + 简化为 10 次 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  let page = null;
  for (const p of ctx.pages()) { if (p.url().includes('127.0.0.1:8004')) { page = p; break; } }
  const r = await page.evaluate(async () => {
    const ta = document.getElementById('send_textarea');
    if (!ta) return { error: 'no textarea' };
    const delays = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      ta.value += 'a';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(r));
      delays.push(+(performance.now() - t0).toFixed(1));
    }
    return { delays };
  });
  console.log(JSON.stringify(r));
})();
