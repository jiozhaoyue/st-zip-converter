/**
 * CSRF 令牌来源比对（Dev Luker 8003 认证态，只读）
 *
 * 目的：验证插件新加的「getRequestHeaders() 官方优先路径」是否与 `/csrf-token` 返回**同一个**令牌。
 * 若二者不同，则该「纯增强」实为回归——插件会拿着错误令牌发请求，宿主回
 * 「Invalid CSRF token. Please refresh the page and try again.」。
 *
 * 只读：只做 GET，不提交任何恢复/导出请求。
 * 用法：node pw-csrf-compare.cjs
 */
const path = require('path');
const fs = require('fs');

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    const globalRoot = require('child_process').execSync('npm root -g').toString().trim();
    return require(path.join(globalRoot, 'playwright'));
  }
}

const { chromium } = loadPlaywright();
const BASE = process.env.DEV_URL || 'https://127.0.0.1:8003';
const PROFILE = path.resolve(__dirname, '../../../../.pw-profile-dev');
const OUT = path.join(__dirname, 'csrf-compare.json');

async function main() {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 950 },
  });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(3000);

    const result = await page.evaluate(async () => {
      const out = {};
      const ctxObj = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext)
        ? (() => { try { return SillyTavern.getContext(); } catch { return null; } })()
        : null;
      out.hostVersion = (typeof SillyTavern !== 'undefined') ? String(SillyTavern.version || '') : '';
      let ctxToken = null;
      try {
        const h = ctxObj?.getRequestHeaders?.() || {};
        ctxToken = h['X-CSRF-Token'] || null;
        out.headerKeys = Object.keys(h);
      } catch (e) { out.ctxError = String(e).slice(0, 120); }

      let netToken = null;
      try {
        const r = await fetch('/csrf-token', { credentials: 'same-origin' });
        out.csrfEndpointStatus = r.status;
        netToken = (await r.json()).token;
      } catch (e) { out.csrfEndpointError = String(e).slice(0, 120); }

      out.ctxTokenPrefix = ctxToken ? ctxToken.slice(0, 12) : null;
      out.netTokenPrefix = netToken ? netToken.slice(0, 12) : null;
      out.sameToken = Boolean(ctxToken && netToken && ctxToken === netToken);

      // 用两个令牌各打一次「只读但受 CSRF 保护」的端点，看宿主接受哪个
      const probe = async (token, label) => {
        if (!token) return { label, skipped: '无令牌' };
        try {
          const r = await fetch('/api/users/backup', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'X-CSRF-Token': token, 'Content-Type': 'application/json' },
            body: '{}', // 空对象：字段校验必失败，但 CSRF 通过与否可从状态码区分
          });
          const body = (await r.text()).slice(0, 160);
          return { label, status: r.status, body };
        } catch (e) { return { label, error: String(e).slice(0, 120) }; }
      };
      out.probeWithCtxToken = await probe(ctxToken, 'getRequestHeaders()');
      out.probeWithNetToken = await probe(netToken, '/csrf-token');
      return out;
    });

    fs.writeFileSync(OUT, JSON.stringify({ sampledAt: new Date().toISOString(), base: BASE, result }, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 1));
  } finally {
    await ctx.close();
  }
}

main().catch((e) => { console.error('探针失败:', e); process.exit(1); });
