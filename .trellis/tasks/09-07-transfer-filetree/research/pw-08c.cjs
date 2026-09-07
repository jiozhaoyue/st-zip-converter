/**
 * 实测 08c（决定性）：send_textarea input 后 requestAnimationFrame 挂 1 秒 = 页面 rAF 被锁
 * 谁锁的？二分法：逐个禁用插件容器 / 各第三方扩展样式，量 rAF 帧间隔。
 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  let page = null;
  for (const p of ctx.pages()) { if (p.url().includes('127.0.0.1:8004')) { page = p; break; } }

  const r = await page.evaluate(async () => {
    async function frameGap() {
      const gaps = [];
      for (let i = 0; i < 6; i++) {
        const t0 = performance.now();
        await new Promise((res) => requestAnimationFrame(res));
        gaps.push(performance.now() - t0);
      }
      gaps.sort((a, b) => a - b);
      return +gaps[Math.floor(gaps.length / 2)].toFixed(1);
    }

    const out = {};
    out.baseline = await frameGap();

    // 1) 隐藏插件抽屉容器
    const drawerWrap = document.getElementById('st-zip-converter-settings-panel');
    if (drawerWrap) drawerWrap.style.display = 'none';
    out.pluginHidden = await frameGap();

    // 2) 恢复插件
    if (drawerWrap) drawerWrap.style.display = '';
    out.restored = await frameGap();

    return out;
  });
  console.log(JSON.stringify(r, null, 2));
})();
