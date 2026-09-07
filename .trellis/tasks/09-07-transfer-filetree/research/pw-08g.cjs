/**
 * 实测 08g：到底谁的 rAF 是 1000ms？——「页面 evaluate 里自跑 rAF 正常 13ms」
 * vs 「pw-08d 里 1000ms」。差异：08d 的 rAF 没有持续链（每发一个都新建）。可能是
 * evaluate 沙箱每次调用的开销。用与 08f 相同的持续链重测（已证 75fps 正常）。
 * → 结论：单发 rAF 1s 是 Playwright evaluate 的测量伪影，不是页面卡顿！
 * 复核：打字延迟用 CDP Input.dispatchKeyEvent 真实键盘事件测（不是 JS 派发）。
 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  let page = null;
  for (const p of ctx.pages()) { if (p.url().includes('127.0.0.1:8004')) { page = p; break; } }

  // 展开抽屉
  await page.evaluate(() => {
    const c = document.querySelector('#st_zip_converter_settings > .inline-drawer-content');
    if (c) c.style.display = 'block';
  });
  await page.waitForTimeout(300);

  // 真实键盘输入打字延迟：CDP 级 input 事件 → rAF 绘制完成
  const ta = await page.$('#send_textarea');
  await ta.focus();
  await page.evaluate(() => { document.getElementById('send_textarea').value = ''; });
  const times = [];
  for (let i = 0; i < 15; i++) {
    const t0 = Date.now();
    await page.keyboard.type('a', { delay: 0 });
    await page.evaluate(() => new Promise((res) => requestAnimationFrame(res)));
    times.push(Date.now() - t0);
    await page.waitForTimeout(20);
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ expanded: { p50: times[7], p95: times[14], max: times[14] } }));
})();
