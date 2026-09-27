/**
 * 独立形态的浏览器夹具
 *
 * 与 `e2e/lib/harness.cjs` 的分工：那个是**宿主实例**夹具（持久化档案、HTTPS 自签、
 * 端口守卫、按 slug 归因第三方扩展的报错）；本文件是**独立 Web / 云部署**夹具——
 * 页面 100% 是本插件自己的产物，**整页错误全部可归因于本插件**，故判定可以直接看全量。
 *
 * 不新装包：Playwright 复用 `e2e/lib/resolve-playwright.cjs` 的解析器（本机全局 1.62.1）。
 *
 * @module e2e/standalone/lib/harness
 */

const { loadPlaywright, warnOnVersionDrift } = require('../../lib/resolve-playwright.cjs');

/**
 * 打开一个 URL（独立站点）并挂上采集器。
 * @param {string} url
 * @returns {Promise<{page: object, rec: object, download: object, close: function(): Promise<void>}>}
 */
async function openSite(url) {
  const pw = loadPlaywright();
  warnOnVersionDrift(pw);

  const browser = await pw.chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 950 },
    acceptDownloads: true,
    ignoreHTTPSErrors: true,
  });
  ctx.setDefaultTimeout(30_000);
  const page = await ctx.newPage();

  const rec = { consoleErrors: [], pageErrors: [], failedRequests: [], badResponses: [], crossOrigin: [] };
  /** 本页 origin：跨源请求单独记账（后台读数，不参与「子路径可用」的判定） */
  const pageOrigin = new URL(url).origin;
  page.on('request', (req) => {
    try {
      if (new URL(req.url()).origin !== pageOrigin) rec.crossOrigin.push(req.url());
    } catch { /* data:/blob: 等非 URL 形态：不记账 */ }
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') rec.consoleErrors.push({ text: msg.text(), url: (msg.location() || {}).url || '' });
  });
  page.on('pageerror', (err) => {
    rec.pageErrors.push(String((err && err.stack) || (err && err.message) || err));
  });
  page.on('requestfailed', (req) => {
    rec.failedRequests.push({ url: req.url(), error: ((req.failure() || {}).errorText) || '' });
  });
  page.on('response', (res) => {
    if (res.status() >= 400) rec.badResponses.push({ url: res.url(), status: res.status() });
  });

  return {
    page,
    rec,
    /** 等待一次下载并落盘：返回 `{ suggestedFilename, saveAs(path) }` */
    waitDownload: (trigger, timeout = 30_000) => Promise.all([
      page.waitForEvent('download', { timeout }),
      trigger(),
    ]).then(([d]) => d),
    async goto() {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return page;
    },
    async close() {
      await browser.close();
    },
  };
}

/**
 * 等到工作台就绪：`#env-badge` 脱离模板初值「检测中...」。
 * 有界等待（`L1-MR-7`）。
 * @param {object} page
 * @param {number} [timeout]
 * @returns {Promise<string|null>} 就绪时的徽标文案；超时返回 null
 */
async function waitForReady(page, timeout = 30_000) {
  try {
    await page.waitForFunction(() => {
      const el = document.getElementById('env-badge');
      if (!el) return false;
      const txt = el.textContent.trim();
      return txt.length > 0 && txt !== '检测中...';
    }, null, { timeout });
    return await page.$eval('#env-badge', (el) => el.textContent.trim());
  } catch {
    return null;
  }
}

module.exports = { openSite, waitForReady };
