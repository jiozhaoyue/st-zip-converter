/**
 * 实测 04b：selection 失效根因判定
 * settings-only 包的头 200 字节（找 manifest.json 内容 selection 字段）+
 * 前几个条目名（zip local file header），看打进包里的是什么。
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

    const resp = await fetch('/api/users/backup', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify({ handle: me.handle, selection: { settings: true } }),
    });
    const reader = resp.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (bytes < 2 * 1048576) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      bytes += value.length;
    }
    await reader.cancel().catch(() => {});

    // 拼接前 2MB，找 manifest.json 内容 + local file header 文件名
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
    const text = new TextDecoder('latin1').decode(buf);

    // zip local header: PK\x03\x04 后跟文件名
    const names = [];
    let idx = 0;
    while (names.length < 30) {
      idx = text.indexOf('PK\x03\x04', idx);
      if (idx === -1) break;
      const nameLen = buf[idx + 26] | (buf[idx + 27] << 8);
      const name = text.slice(idx + 30, idx + 30 + nameLen);
      names.push(name);
      idx += 30;
    }
    const manifestIdx = text.indexOf('"selection"');
    return {
      firstEntries: names,
      manifestSelection: manifestIdx > -1 ? text.slice(manifestIdx, manifestIdx + 200) : null,
    };
  });
  console.log(JSON.stringify(result, null, 2));
})();
