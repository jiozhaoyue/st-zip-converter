/**
 * 实例会话获取 —— 浏览器**只做这一件事**：取 cookie 串与 CSRF 令牌。
 *
 * 为什么单列成模块：导出（`export-backups.cjs`）与恢复（`restore-luker.cjs`）都需要它，
 * 而两处的取法必须一致（同一份实例登记、同一套 Playwright 解析）。**只留一份真源**，
 * 免得将来宿主换 CSRF 端点时改了一处漏一处。
 *
 * 用法：
 *   const { acquireSession } = require('./instance-session.cjs');
 *   const session = await acquireSession(inst);
 *
 * 纪律：
 *  - 只用浏览器**取会话**，数据字节一律走 Node 侧 https —— GB 级包不进浏览器内存。
 *  - 会话档案（`inst.profile`）是持久化上下文，**只读使用**，本模块不写它。
 */

const { loadPlaywright, warnOnVersionDrift } = require('../../../e2e/lib/resolve-playwright.cjs');

/**
 * 用已登录的会话取 cookie 串与 CSRF 令牌。
 * @param {{url: string, profile: string}} inst 实例登记项（见 `e2e/lib/instances.cjs`）
 * @returns {Promise<{cookieHeader: string, csrf: string, playwright: string, cookieCount: number}>}
 */
async function acquireSession(inst) {
  const pw = loadPlaywright();
  const version = warnOnVersionDrift(pw);
  const ctx = await pw.chromium.launchPersistentContext(inst.profile, {
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 800 },
  });
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(inst.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const csrf = await page.evaluate(async () => {
      const r = await fetch('/csrf-token', { credentials: 'include' });
      return r.ok ? (await r.json()).token : '';
    });
    const cookies = await ctx.cookies(inst.url);
    if (!cookies.length) throw new Error('未取到任何 cookie —— 会话档案可能未登录');
    if (!csrf) throw new Error('未取到 CSRF 令牌 —— /csrf-token 不可用');
    return {
      cookieHeader: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
      csrf,
      playwright: version,
      cookieCount: cookies.length,
    };
  } finally {
    await ctx.close();
  }
}

module.exports = { acquireSession };
