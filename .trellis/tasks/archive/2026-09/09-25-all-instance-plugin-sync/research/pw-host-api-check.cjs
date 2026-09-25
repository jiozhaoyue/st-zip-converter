/**
 * 前置核查探针（Dev Luker 8003，只读）：OQ-2 宿主 Popup 层级 + OQ-3 运行时 API 面
 *
 * 回答两件事（都不许猜）：
 *   1. 宿主原生 Popup（`.popup`）及其遮罩的计算 `z-index` 是多少？
 *      —— 用来判定 `src/ui/split-deliver-modal.js:59` 的 `z-index = 100000` 会不会压住宿主弹窗。
 *   2. `getContext().Popup.show` 运行时到底挂了哪些方法？
 *      —— 官方文档（docs.sillytavern.app）只文档化了 `confirm` / `input` / `text`，**没有 alert**；
 *         本探针核对运行时是否与文档一致（文档优先，运行时为辅；不一致要在 spec 里写明）。
 *
 * 用法：node pw-host-api-check.cjs    [DEV_URL=...]
 */
const path = require('path');
const fs = require('fs');

function loadPlaywright() {
  try { return require('playwright'); } catch {
    const g = require('child_process').execSync('npm root -g').toString().trim();
    return require(path.join(g, 'playwright'));
  }
}

const { chromium } = loadPlaywright();
const BASE = process.env.DEV_URL || 'https://127.0.0.1:8003';
const PORT_TAG = (BASE.match(/:(\d+)/) || [, 'unknown'])[1];
const PROFILE = path.resolve(__dirname, '../../../../.pw-profile-dev');

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, { ignoreHTTPSErrors: true, viewport: { width: 1600, height: 950 } });
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(18000);

    // 触发一个宿主原生弹窗：账号弹层走的就是 Popup
    await page.evaluate(() => document.getElementById('account_button')?.click());
    await page.waitForTimeout(3000);

    const r = await page.evaluate(() => {
      const z = (el) => (el ? getComputedStyle(el).zIndex : null);
      const posOf = (el) => (el ? getComputedStyle(el).position : null);
      const popup = document.querySelector('.popup');
      const overlay = document.querySelector('.popup_backdrop, .popup-overlay, #dialogue_popup_backdrop')
        || (popup && popup.parentElement);
      let ctxApi = null;
      try {
        const c = globalThis.SillyTavern?.getContext?.();
        const show = c?.Popup?.show;
        ctxApi = {
          popupPresent: !!c?.Popup,
          showType: typeof show,
          showKeys: show ? Object.keys(show).sort() : null,
          showMethodTypes: show ? Object.fromEntries(Object.keys(show).map((k) => [k, typeof show[k]])) : null,
          resultKeys: c?.POPUP_RESULT ? Object.keys(c.POPUP_RESULT).sort() : null,
          typeKeys: c?.POPUP_TYPE ? Object.keys(c.POPUP_TYPE).sort() : null,
        };
      } catch (err) { ctxApi = { error: String(err).slice(0, 160) }; }
      return {
        popup: popup ? { zIndex: z(popup), position: posOf(popup), className: String(popup.className).slice(0, 80) } : null,
        overlay: overlay ? { tag: overlay.tagName, id: overlay.id, zIndex: z(overlay), position: posOf(overlay) } : null,
        // 页面上所有高 z-index 元素（用于横向对照，找出比 100000 更高/更低的分位）
        topZ: Array.from(document.querySelectorAll('body *'))
          .map((el) => ({ el, z: parseInt(getComputedStyle(el).zIndex, 10) }))
          .filter((x) => Number.isFinite(x.z) && x.z >= 1000)
          .sort((a, b) => b.z - a.z)
          .slice(0, 12)
          .map((x) => ({ z: x.z, sig: `${x.el.tagName.toLowerCase()}${x.el.id ? '#' + x.el.id : ''}${typeof x.el.className === 'string' && x.el.className ? '.' + x.el.className.trim().split(/\s+/)[0] : ''}` })),
        ctxApi,
      };
    });

    fs.writeFileSync(path.join(__dirname, `host-api-check-${PORT_TAG}.json`),
      JSON.stringify({ sampledAt: new Date().toISOString(), url: BASE, ...r }, null, 2), 'utf8');
    console.log(JSON.stringify(r, null, 1));
  } finally { await ctx.close(); }
})();
