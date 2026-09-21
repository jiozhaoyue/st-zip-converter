/**
 * 实测 04：selection 生效性判定
 * 直接用与插件完全相同的请求体（FULL_SELECTION vs settings-only），
 * 比对 Content-Length/字节量差异。带 Range: bytes=0-0 探测 total size，不全量下载。
 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  let page = null;
  for (const p of ctx.pages()) { if (p.url().includes('127.0.0.1:8004')) { page = p; break; } }
  if (!page) { console.log('NO_PAGE'); return; }

  const result = await page.evaluate(async () => {
    const token = (await (await fetch('/csrf-token', { credentials: 'same-origin' })).json()).token;
    const me = await (await fetch('/api/users/me', { credentials: 'same-origin' })).json();

    // 探测：不读完 body，读一小段就 cancel，用标记 chunk 计数推断
    async function probeBytes(selection, label) {
      const t0 = performance.now();
      const resp = await fetch('/api/users/backup', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({ handle: me.handle, selection }),
      });
      const reader = resp.body.getReader();
      let bytes = 0;
      // 读到 3MB 就取消——足够看出 selection 是否改变了打包内容
      while (bytes < 3 * 1048576) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
      }
      await reader.cancel().catch(() => {});
      return { label, status: resp.status, probedMB: +(bytes / 1048576).toFixed(3), ttfbMs: Math.round(performance.now() - t0) };
    }

    const full = await probeBytes({
      settings: true, secrets: true, characters: true, chats: true, lorebooks: true,
      presets: true, assets: true, extensions: true, globalExtensions: false, vectors: false,
    }, 'FULL');
    const settingsOnly = await probeBytes({ settings: true }, 'SETTINGS-ONLY');
    return { full, settingsOnly };
  });
  console.log(JSON.stringify(result, null, 2));
})();
