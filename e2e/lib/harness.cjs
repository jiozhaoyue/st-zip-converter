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
 * **诊断**：把页面上拦路的 `<dialog>` 报出来（不改动任何东西）。
 *
 * 为什么需要：宿主/第三方插件的**模态弹窗会拦截全页指针事件**，于是 Playwright 的点按会
 * 一直重试到超时，报错长这样（而且看起来毫无头绪）：
 * ```
 * - element is visible, enabled and stable
 * - <dialog open class="popup …">…</dialog> intercepts pointer events
 * ```
 * 2026-09-28 实测两次：dev-st 的矩阵就是被 **ChatFilesys 的「入库提醒」弹窗**
 * （`chatfilesys-ip-mute-key` / `chatfilesys-ip-mute-all`）拦住的 —— 而 dev-luker 因为
 * 它的 `import_prompt.never = true`（已静音）从不发生。**同一份代码，一个宿主绿一个红。**
 *
 * 处置：**只看不碰**（用例可能有自己的弹窗断言，自动关掉会破坏它们），
 * 但把 id 与文案打出来，让"红灯来自别人"这件事**一眼可判**。
 */
async function reportBlockingPopups(page, instanceId) {
  try {
    const popups = await page.evaluate(() => Array.from(document.querySelectorAll('dialog[open]'))
      .map((d) => ({
        cls: d.className,
        ids: Array.from(d.querySelectorAll('[id]')).map((e) => e.id).slice(0, 6),
        text: (d.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
      })));
    for (const p of popups) {
      process.stdout.write(`  · ⚠ ${instanceId}: 页面存在打开的 <dialog>（会拦截指针事件）`
        + ` cls=${p.cls} ids=${JSON.stringify(p.ids)} text=${JSON.stringify(p.text)}\n`);
    }
  } catch { /* 诊断失败不影响任何判定 */ }
}

/**
 * **处置**一个**已知的第三方**模态弹窗：ChatFilesys 的「入库提醒」（`.chatfilesys-import-prompt`，**类名**）。
 *
 * WHY（2026-09-29 实测）：dev-st 上打开任何**尚未入库**的聊天时，ChatFilesys 会弹这条
 * `<dialog open class="popup popup--animation-fast">`（内含 `.chatfilesys-import-prompt`，
 * 按钮「纯库 / 双写 / 不入库 / 确定 / 取消」）并**拦截全页指针事件** ⇒ 矩阵在
 * 第一次点 `#btn-convert` 时超时（`<dialog …> intercepts pointer events`）而**整段假红**。
 * dev-luker 不发生，因为它的 `import_prompt.never = true`（已静音）——
 * **同一份代码、两个宿主、一绿一红**，这正是「红灯来自别人」的教科书形态。
 *
 * 与宿主的 splash 弹窗（见 `goto()`）**同类**：都不是被测对象，却都会拦指针事件。
 *
 * 为什么装 **init script + MutationObserver** 而不是「goto 之后点一下」：
 * 2026-09-29 实测**按需点击抓不到** —— 该弹窗是**宿主把聊天载进来之后**才出现的，
 * 比 `goto()` 返回晚（第一次实现因此在 goto 里 `count() === 0` 直接空过，矩阵照样假红）。
 * 观察者挂在页面里，**任何时候弹出都能收拾**，且零等待（不对每个页面白付超时）。
 *
 * 处置动作取「**不入库**」——语义是「这次就照常走聊天文件」（**不写库、不改任何数据**），
 * 是三个选项里唯一**不产生副作用**的；**不勾**「这个聊天不再提醒 / 全部不再提醒」
 * （那会**留下持久设置**，等于偷偷改实例状态）。
 *
 * 边界：仅当 `.chatfilesys-import-prompt` 存在时才动它；未装 ChatFilesys / 已静音 / 已在库时
 * 是**零操作**。将来若有 spec 要断言这条弹窗，需在此加开关（现行 spec 无一断言它，已 grep 确认）。
 *
 * @param {object} ctx Playwright 持久化上下文
 */
async function installChatFilesysPromptGuard(ctx) {
  await ctx.addInitScript(() => {
    window.__szcDismissedCfPrompt = 0;
    const dismiss = () => {
      // ⚠️ 实测两点（2026-09-29，两次都踩过）：
      //  ① `chatfilesys-import-prompt` 是**类名不是 id**（按 id 找恒为空 → 守卫静默空过）；
      //  ② 它的按钮是宿主的 `.menu_button` **div**，不是 `<button>`（只查 button 得到空集）。
      const box = document.querySelector('.chatfilesys-import-prompt');
      if (!box) return;
      const root = box.closest('dialog') || box;
      const btn = Array.from(root.querySelectorAll('button, .menu_button'))
        .find((b) => (b.textContent || '').trim() === '不入库');
      if (!btn) return;                       // 找不到就**不猜按钮**，留给 reportBlockingPopups 告警
      btn.click();
      window.__szcDismissedCfPrompt += 1;
    };
    const start = () => {
      dismiss();                              // 页面加载时就已存在的情况
      new MutationObserver(dismiss).observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['open'],
      });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  });
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
  // 页内守卫：自动处置**已知的第三方**拦路弹窗（ChatFilesys 入库提醒）。
  // 必须在导航前装（init script 对之后每次导航都生效）；见 installChatFilesysPromptGuard
  await installChatFilesysPromptGuard(ctx);

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
      // splash 之后看一眼页内守卫收拾了几个拦路弹窗（详见 installChatFilesysPromptGuard）
      const dimmed = await page.evaluate(() => window.__szcDismissedCfPrompt || 0).catch(() => 0);
      if (dimmed) {
        process.stdout.write(`  · ℹ ${inst.id}: 已自动关闭 ChatFilesys「入库提醒」× ${dimmed}`
          + '（点「不入库」；不写库、不勾「不再提醒」，实例状态零改动）\n');
      }
      await reportBlockingPopups(page, inst.id);
      return page;
    },
    async close() {
      await ctx.close();
    },
  };
}

module.exports = { openInstance, isPluginRef, PLUGIN_SLUG };
