/**
 * 实测 08：打字延迟对比（用户核心体感）——send_textarea input→keydown→绘制
 * 收起抽屉 vs 展开抽屉，各测 30 次按键间隔抖动
 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  let page = null;
  for (const p of ctx.pages()) { if (p.url().includes('127.0.0.1:8004')) { page = p; break; } }

  async function typingJitter() {
    return page.evaluate(async () => {
      const ta = document.getElementById('send_textarea');
      if (!ta) return { error: 'no textarea' };
      const delays = [];
      for (let i = 0; i < 30; i++) {
        const t0 = performance.now();
        ta.value += 'a';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        // 等一帧绘制
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        delays.push(+(performance.now() - t0).toFixed(1));
        await new Promise((r) => setTimeout(r, 30));
      }
      delays.sort((a, b) => a - b);
      return {
        p50: delays[15], p95: delays[28], max: delays[29], avg: +(delays.reduce((s, d) => s + d, 0) / 30).toFixed(1),
      };
    });
  }

  await page.evaluate(() => {
    const c = document.querySelector('#st_zip_converter_settings > .inline-drawer-content');
    if (c) c.style.display = 'none';
  });
  await page.waitForTimeout(400);
  const collapsed = await typingJitter();

  await page.evaluate(() => {
    const c = document.querySelector('#st_zip_converter_settings > .inline-drawer-content');
    if (c) c.style.display = 'block';
  });
  await page.waitForTimeout(400);
  const expanded = await typingJitter();

  console.log(JSON.stringify({ collapsed, expanded }, null, 2));
})();
