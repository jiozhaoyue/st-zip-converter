/**
 * 实测 03：传输速度瓶颈定位
 * A. 直接 fetch /api/users/backup（与插件相同路径），TTFB / 总时长 / 字节
 * B. 对照：fetch 一个大静态资源（无压缩打包），测纯传输速度
 * C. 检查服务端是否 gzip 了 zip 响应（双重压缩浪费）
 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  let page = null;
  for (const p of ctx.pages()) {
    if (p.url().includes('127.0.0.1:8004')) { page = p; break; }
  }
  if (!page) { console.log('NO_PAGE'); return; }

  const result = await page.evaluate(async () => {
    const token = (await (await fetch('/csrf-token', { credentials: 'same-origin' })).json()).token;
    const me = await (await fetch('/api/users/me', { credentials: 'same-origin' })).json();

    // A. 备份拉取（只选 settings 最小类目先测 TTFB，再全量测吞吐）
    async function timedBackup(selection) {
      const t0 = performance.now();
      const resp = await fetch('/api/users/backup', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({ handle: me.handle, selection }),
      });
      const ttfb = performance.now() - t0;
      const reader = resp.body.getReader();
      let bytes = 0;
      const marks = [];
      let lastT = ttfb;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (performance.now() - lastT > 1000) {
          marks.push({ tSec: Math.round((performance.now() - t0) / 100) / 10, mb: +(bytes / 1048576).toFixed(2) });
          lastT = performance.now();
        }
      }
      const total = performance.now() - t0;
      return {
        status: resp.status,
        contentEncoding: resp.headers.get('Content-Encoding'),
        contentLength: resp.headers.get('Content-Length'),
        ttfbMs: Math.round(ttfb),
        totalMs: Math.round(total),
        bytesMB: +(bytes / 1048576).toFixed(2),
        throughputMBps: +(bytes / 1048576 / (total / 1000)).toFixed(3),
        marks,
      };
    }

    const settingsOnly = await timedBackup({ settings: true });
    const full = await timedBackup({
      settings: true, secrets: true, characters: true, chats: true, lorebooks: true,
      presets: true, assets: true, extensions: true, globalExtensions: false, vectors: false,
    });

    // B. 对照：静态大文件纯传输
    let staticCtl = null;
    try {
      const t0 = performance.now();
      const r = await fetch('/img/ai4.png', { credentials: 'same-origin' });
      const b = await r.arrayBuffer();
      staticCtl = {
        url: '/img/ai4.png', status: r.status,
        ms: Math.round(performance.now() - t0), mb: +(b.byteLength / 1048576).toFixed(2),
      };
    } catch (e) { staticCtl = { error: e.message }; }

    return { me: me.handle, settingsOnly, full, staticCtl };
  });

  console.log(JSON.stringify(result, null, 2));
})();
