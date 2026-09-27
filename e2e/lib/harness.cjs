/**
 * E2E 运行夹具 —— 打开实例、采集**可归因**的错误与失败请求
 *
 * 归因原则（本仓纪律「先证明判定能抓到违规，再相信它报 0」）：
 * 页面上跑着 30 个第三方扩展，整页报错**不能**算到本插件头上。
 * 故此处把采集分成两栏：
 *   - `*`        —— 整页所有错误（只作背景读数，**不参与判定**）；
 *   - `plugin*`  —— URL / 位置 / 堆栈里出现本插件 slug 的才算（**判定只看这一栏**）。
 *
 * 一律先过端口守卫（`guard.cjs`，I-4），再打开页面。
 *
 * @module e2e/lib/harness
 */

const { loadPlaywright, warnOnVersionDrift } = require('./resolve-playwright.cjs');
const { assertDevTarget } = require('./guard.cjs');

/** 插件资源路径里的稳定 slug；两侧（ST / Luker）共用同一 URL 形态 */
const PLUGIN_SLUG = 'st-zip-converter';

/** 该 URL / 文本 / 堆栈是否属于本插件 */
function isPluginRef(value) {
  return typeof value === 'string' && value.includes(PLUGIN_SLUG);
}

/**
 * 打开一个实例并挂上采集器。
 * @param {import('./instances.cjs').Instance} inst
 * @returns {Promise<{page: import('playwright').Page, ctx: object, rec: object, close: Function, goto: Function}>}
 */
async function openInstance(inst) {
  // I-4：目标必须过守卫（Real 端口在此直接抛错，不会进入自动化）
  assertDevTarget(inst.url);

  const pw = loadPlaywright();
  const version = warnOnVersionDrift(pw);

  const ctx = await pw.chromium.launchPersistentContext(inst.profile, {
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 950 },
  });
  ctx.setDefaultTimeout(30_000);

  const page = ctx.pages()[0] || await ctx.newPage();
  const rec = {
    /** 整页背景读数（不参与判定） */
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    /** **只属于本插件**的读数（判定看这两栏） */
    pluginConsoleErrors: [],
    pluginFailures: [],
  };

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const url = (msg.location() && msg.location().url) || '';
    const entry = { text: msg.text(), url };
    rec.consoleErrors.push(entry);
    if (isPluginRef(url) || isPluginRef(entry.text)) rec.pluginConsoleErrors.push(entry);
  });

  page.on('pageerror', (err) => {
    const entry = { text: String((err && err.message) || err), stack: String((err && err.stack) || '') };
    rec.pageErrors.push(entry);
    if (isPluginRef(entry.stack) || isPluginRef(entry.text)) rec.pluginConsoleErrors.push(entry);
  });

  page.on('requestfailed', (req) => {
    const entry = { url: req.url(), error: (req.failure() || {}).errorText || '' };
    rec.failedRequests.push(entry);
    if (isPluginRef(entry.url)) rec.pluginFailures.push(entry);
  });

  page.on('response', (res) => {
    if (res.status() < 400) return;
    if (!isPluginRef(res.url())) return;
    rec.pluginFailures.push({ url: res.url(), status: res.status() });
  });

  return {
    page,
    ctx,
    rec,
    /** 实例登记 id（如 `dev-st`）与登记对象 —— spec 需要按实例写差异化断言时用 */
    instanceId: inst.id,
    instance: inst,
    playwright: version,
    /**
     * 打开实例首页并等 DOM 就绪，随后**等宿主的 splash 关掉**。
     *
     * ⚠️ 为什么必须等 splash（2026-09-28 实测两次复现）：
     * 宿主初始化期间有一条 `<dialog open class="popup …">`（内含 `#loader`，文案「正在初始化…」）
     * **拦截全页指针事件** ⇒ Playwright 的点按会一直重试到超时，报错长这样：
     * ```
     * - element is visible, enabled and stable
     * - <dialog open class="popup popup--animation-fast">…</dialog> intercepts pointer events
     * ```
     * 这不是"按钮不可用"，而是**宿主还没初始化完**（本仓规范 §11.7「宿主冷启动窗口」同类）。
     * 在高负载机器上它可能持续几十秒，于是矩阵会在任意一次点击上失败、且**看起来毫无头绪**。
     *
     * 处置：有界等待 splash 消失；超时**只告警不失败**（真有初始化故障时，让 spec 自己的
     * 就绪断言去如实报错，而不是在这里变成一句"超时"）。
     */
    async goto() {
      await page.goto(inst.url, { waitUntil: 'domcontentloaded' });
      try {
        await page.waitForFunction(() => {
          const ds = Array.from(document.querySelectorAll('dialog[open]'));
          return !ds.some((d) => d.querySelector('#loader') || /正在初始化/.test(d.textContent || ''));
        }, null, { timeout: 90_000 });
      } catch {
        process.stdout.write(`  · ⚠ ${inst.id}: 宿主 splash（#loader / 「正在初始化…」）90 s 内未关闭`
          + ' —— 后续点击可能被它拦截（规范 §11.7 宿主冷启动窗口）\n');
      }
      return page;
    },
    async close() {
      await ctx.close();
    },
  };
}

module.exports = { openInstance, isPluginRef, PLUGIN_SLUG };
