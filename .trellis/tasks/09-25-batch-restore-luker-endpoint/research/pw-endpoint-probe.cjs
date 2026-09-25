/**
 * Dev Luker(8003) 认证态端点存在性探针（**只读 + 空体探测**）
 *
 * 目的（新任务 OQ-1）：
 *   1. 确认认证态下 `/api/users/me` 的真实状态（匿名 curl 为 403，spec 记过 404，三次口径不一致）；
 *   2. 确认 `/api/users/restore` 与 `/api/users/restore-backup` 哪个**存在**——
 *      判据用「空 FormData POST」：路由存在 → 400 `No backup file uploaded`（**不写任何数据，包体为空**）；
 *      路由不存在 → 404。此判据沿用 09-22 任务的既有做法。
 *   3. 枚举 `getContext()` 中可能代表**账户句柄**的字段（`name1` 是用户人设名，不可当句柄）；
 *   4. 确认 `getRequestHeaders()` 是否可用（CSRF 官方来源）。
 *
 * 安全约束：不提交任何真实数据包、不调用任何会写用户数据的端点（全部空体）、不点任何执行类按钮。
 * 用法：node pw-endpoint-probe.cjs
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
const REPO_ROOT = path.resolve(__dirname, '../../../..');
// 两个候选档案（历史脚本落在两处），逐个试，取第一个「已登录」的
const PROFILE_CANDIDATES = [
  path.join(REPO_ROOT, '.pw-profile-dev'),
  path.join(REPO_ROOT, '.trellis', 'tasks', '.pw-profile-dev'),
];
const OUT = path.join(__dirname, 'host-endpoint-facts.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在页面上下文内跑全部探测（带会话 Cookie 与 CSRF） */
function pageProbes() {
  return async () => {
    const out = {};
    const j = async (r) => {
      let body = '';
      try { body = (await r.text()).slice(0, 300); } catch { body = '(读取失败)'; }
      return { status: r.status, body };
    };

    out.csrfEndpoint = await fetch('/csrf-token', { credentials: 'same-origin' }).then(j);

    const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext)
      ? (() => { try { return SillyTavern.getContext(); } catch { return null; } })()
      : (typeof getContext === 'function' ? (() => { try { return getContext(); } catch { return null; } })() : null);
    out.hasGetContext = !!ctx;
    if (ctx) {
      out.contextKeys = Object.keys(ctx).sort();
      out.handleCandidates = {};
      for (const k of ['name1', 'name2', 'handle', 'user_handle', 'userHandle', 'account', 'user', 'userName', 'username', 'userId', 'directories']) {
        if (k in ctx) {
          const v = ctx[k];
          out.handleCandidates[k] = (typeof v === 'object' && v !== null)
            ? `[${Array.isArray(v) ? 'array' : 'object'}]`
            : String(v).slice(0, 60);
        }
      }
      out.hasGetRequestHeaders = typeof ctx.getRequestHeaders === 'function';
      if (out.hasGetRequestHeaders) {
        try {
          const h = ctx.getRequestHeaders();
          out.requestHeaderKeys = Object.keys(h || {});
          out.csrfHeaderFromContext = Boolean(h && h['X-CSRF-Token']);
        } catch (e) { out.getRequestHeadersError = String(e).slice(0, 120); }
      }
    }

    const csrf = out.csrfEndpoint.status === 200
      ? (() => { try { return JSON.parse(out.csrfEndpoint.body).token; } catch { return null; } })()
      : null;

    // 端点存在性：空体 POST（路由存在 → 400；不存在 → 404）
    for (const ep of ['/api/users/restore', '/api/users/restore-backup']) {
      try {
        const r = await fetch(ep, {
          method: 'POST',
          credentials: 'same-origin',
          headers: csrf ? { 'X-CSRF-Token': csrf } : {},
          body: new FormData(), // 空体：不写任何数据
        });
        out[`post_${ep}`] = await j(r);
      } catch (e) {
        out[`post_${ep}`] = { error: String(e).slice(0, 160) };
      }
    }

    out.get_users_me = await fetch('/api/users/me', { credentials: 'same-origin' }).then(j);
    return out;
  };
}

async function main() {
  const report = { sampledAt: new Date().toISOString(), base: BASE, attempts: [] };
  for (const profile of PROFILE_CANDIDATES) {
    if (!fs.existsSync(profile)) { report.attempts.push({ profile, skipped: '不存在' }); continue; }
    const ctx = await chromium.launchPersistentContext(profile, {
      ignoreHTTPSErrors: true,
      viewport: { width: 1600, height: 950 },
    });
    try {
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await sleep(2500);
      const landing = await page.evaluate(() => ({ url: location.href, title: document.title }));
      const probes = await page.evaluate(pageProbes());
      const authed = probes.get_users_me?.status === 200;
      report.attempts.push({ profile, landing, probes, authed });
      if (authed) { report.usedProfile = profile; break; }
    } catch (e) {
      report.attempts.push({ profile, error: String(e).slice(0, 200) });
    } finally {
      await ctx.close();
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 1).slice(0, 4000));
}

main().catch((e) => { console.error('探针失败:', e); process.exit(1); });
