/** 实测 05d：插件打开态 → 展开抽屉 → 10s longtask 采样（含插件交互）*/
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  let page = null;
  for (const p of ctx.pages()) { if (p.url().includes('127.0.0.1:8004')) { page = p; break; } }

  // 展开插件抽屉
  await page.evaluate(() => {
    const drawer = document.getElementById('st_zip_converter_settings');
    if (drawer) {
      const content = drawer.querySelector(':scope > .inline-drawer-content');
      if (content) content.style.display = 'block';
    }
  });
  await page.waitForTimeout(1000);

  await page.evaluate(() => {
    window.__lt = [];
    window.__po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__lt.push({ t: Math.round(e.startTime), d: Math.round(e.duration) });
    });
    window.__po.observe({ entryTypes: ['longtask'] });
  });

  // 模拟展开态下用户操作：滚动日志台、点击暂存区、打字到宿主输入框
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => {
      const stream = document.getElementById('log-stream-container');
      if (stream) stream.scrollTop = stream.scrollHeight;
      const ta = document.getElementById('send_textarea');
      if (ta) {
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.value = `测试${Date.now()}`;
      }
    });
    await page.waitForTimeout(900);
  }
  await page.waitForTimeout(1500);

  const r = await page.evaluate(() => {
    window.__po.disconnect();
    const lt = window.__lt;
    return {
      longTaskCount: lt.length,
      totalMs: lt.reduce((s, e) => s + e.d, 0),
      top5: [...lt].sort((a, b) => b.d - a.d).slice(0, 5),
      logLineCount: (() => {
        const s = document.getElementById('log-stream-container');
        return s ? s.querySelectorAll('.log-line').length : -1;
      })(),
    };
  });
  console.log(JSON.stringify(r, null, 2));
})();
