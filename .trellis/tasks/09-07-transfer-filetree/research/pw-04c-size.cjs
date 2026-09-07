/**
 * 实测 04c：settings.json 本体多大？settings-only 包完整拉完计时。
 * 若 settings.json 巨大（聊天内嵌数据搬迁），慢即数据量本身。
 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  let page = null;
  for (const p of ctx.pages()) { if (p.url().includes('127.0.0.1:8004')) { page = p; break; } }

  const result = await page.evaluate(async () => {
    const token = (await (await fetch('/csrf-token', { credentials: 'same-origin' })).json()).token;
    const me = await (await fetch('/api/users/me', { credentials: 'same-origin' })).json();

    const t0 = performance.now();
    const resp = await fetch('/api/users/backup', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify({ handle: me.handle, selection: { settings: true } }),
    });
    const reader = resp.body.getReader();
    let bytes = 0;
    let firstChunkMs = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstChunkMs === null) firstChunkMs = Math.round(performance.now() - t0);
      bytes += value.length;
    }
    const totalMs = Math.round(performance.now() - t0);
    return {
      packageMB: +(bytes / 1048576).toFixed(1),
      firstChunkMs,
      totalMs,
      throughputMBps: +(bytes / 1048576 / (totalMs / 1000)).toFixed(1),
    };
  });
  console.log(JSON.stringify(result, null, 2));
})();
