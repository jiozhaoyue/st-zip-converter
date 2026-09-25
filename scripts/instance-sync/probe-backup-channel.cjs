/**
 * 备份通道探针 —— **只读响应头与首块，不下载全量**
 *
 * 目的（`implement.md` 1.4）：在跑 3.8 G 全量导出**之前**，先确认
 * `POST /api/users/backup` 这条通路真的通、且返回的是 zip 流。
 *
 * 做法：在**页面上下文**里发请求（cookie 同源自带），读到 `response.headers` 与
 * **第一块 body** 后立刻 `abort()` —— 服务端会收到连接中断，不会写完整包。
 *
 * 用法：
 *   node scripts/instance-sync/probe-backup-channel.cjs --id real-luker
 *
 * 产出：stdout 一行 JSON（供落 `research/backup-channel-probe.md`）。
 * **不写任何文件到实例目录**；不产生下载。
 */

const { loadPlaywright, warnOnVersionDrift } = require('../../e2e/lib/resolve-playwright.cjs');
const { getInstance } = require('../../e2e/lib/instances.cjs');

function parseArgs(argv) {
  const out = { id: '', handle: 'default-user' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--id') out.id = argv[++i] || '';
    else if (argv[i] === '--handle') out.handle = argv[++i] || 'default-user';
  }
  return out;
}

(async () => {
  const { id, handle } = parseArgs(process.argv.slice(2));
  if (!id) {
    console.error('用法：node scripts/instance-sync/probe-backup-channel.cjs --id <instance>');
    process.exit(2);
  }
  const inst = getInstance(id);
  const pw = loadPlaywright();
  const version = warnOnVersionDrift(pw);

  const ctx = await pw.chromium.launchPersistentContext(inst.profile, {
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 800 },
  });

  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(inst.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const result = await page.evaluate(async ({ handle }) => {
      const t0 = Date.now();
      const csrf = (await (await fetch('/csrf-token', { credentials: 'include' })).json()).token;

      const ctrl = new AbortController();
      let res;
      try {
        res = await fetch('/api/users/backup', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
          body: JSON.stringify({ handle }),
          signal: ctrl.signal,
        });
      } catch (e) {
        return { ok: false, stage: 'request', error: String(e) };
      }

      const headers = {};
      res.headers.forEach((v, k) => { headers[k] = v; });

      if (!res.ok) {
        // 失败时 body 通常是小 JSON，直接读完便于诊断
        const text = await res.text().catch(() => '');
        return { ok: false, stage: 'status', status: res.status, headers, body: text.slice(0, 400) };
      }

      // 只读第一块，然后立刻中断
      const reader = res.body.getReader();
      const { value, done } = await reader.read();
      const first = value || new Uint8Array();
      const hexHead = Array.from(first.slice(0, 4))
        .map((b) => b.toString(16).padStart(2, '0')).join(' ');
      const asciiHead = String.fromCharCode(...first.slice(0, 4));
      ctrl.abort();
      try { await reader.cancel(); } catch { /* 已中断 */ }

      return {
        ok: true,
        status: res.status,
        headers,
        firstChunkBytes: first.length,
        hexHead,
        asciiHead,
        isZipMagic: hexHead === '50 4b 03 04',
        elapsedMs: Date.now() - t0,
      };
    }, { handle });

    console.log(JSON.stringify({
      instance: id,
      port: inst.port,
      url: inst.url,
      handle,
      playwright: version,
      ...result,
    }, null, 2));
    process.exit(result.ok ? 0 : 1);
  } finally {
    await ctx.close();
  }
})();
