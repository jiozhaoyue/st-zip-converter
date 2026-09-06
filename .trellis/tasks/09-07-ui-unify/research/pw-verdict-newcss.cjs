/**
 * 决定性验证：注入修复后 style.css 到 Luker 8004，
 * 逐一对比顶栏按钮/抽屉/输入框的 computed style 是否被改动。
 * （上轮诊断同一方法，这次覆盖原生类选择器 menu_button 等）
 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
  await page.goto('https://127.0.0.1:8004/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => typeof globalThis.lukerContext !== 'undefined', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(6000);

  // 采样点：顶栏按钮、抽屉头、输入框、checkbox——全站原生类
  const SNAP_SEL = [
    '#top-bar .menu_button',
    '#top-bar button',
    '.drawer-toggle',
    '#send_textarea',
    '.text_pole',
    '.checkbox_label',
    '.inline-drawer-toggle',
    '#right-nav-panel .menu_button',
    'body',
    '#chat',
  ];
  const snapshot = () => page.evaluate((sels) => {
    const out = {};
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el) { out[sel] = null; continue; }
      const cs = getComputedStyle(el);
      out[sel] = {
        display: cs.display, padding: cs.padding, border: cs.border,
        borderRadius: cs.borderRadius, background: cs.backgroundColor,
        color: cs.color, fontSize: cs.fontSize, flexWrap: cs.flexWrap,
        whiteSpace: cs.whiteSpace, height: el.clientHeight, width: el.clientWidth,
      };
    }
    return out;
  }, SNAP_SEL);

  const before = await snapshot();
  await page.screenshot({ path: 'D:/Repo/Tavern-repo/My-repo/ST-zip-converter/.trellis/tasks/09-07-ui-unify/research/verdict-before-newcss.png' });

  // 注入修复后的 CSS（Git 仓库最新版）
  const newCss = fs.readFileSync('D:/Repo/Tavern-repo/My-repo/ST-zip-converter/style.css', 'utf8');
  await page.addStyleTag({ content: newCss });
  await page.waitForTimeout(500);
  const after = await snapshot();
  await page.screenshot({ path: 'D:/Repo/Tavern-repo/My-repo/ST-zip-converter/.trellis/tasks/09-07-ui-unify/research/verdict-after-newcss.png' });

  // 对比：全站采样点必须零差异
  const diffs = [];
  for (const sel of SNAP_SEL) {
    if (!before[sel] || !after[sel]) continue;
    for (const k of Object.keys(before[sel])) {
      if (String(before[sel][k]) !== String(after[sel][k])) {
        diffs.push(`${sel}.${k}: "${before[sel][k]}" -> "${after[sel][k]}"`);
      }
    }
  }
  console.log('采样点数:', SNAP_SEL.length);
  console.log(diffs.length === 0 ? '✓ 修复后 CSS 对宿主全站（顶栏/抽屉/输入框/checkbox）零污染' : '✗ 仍有污染:\n' + diffs.join('\n'));
  await browser.close();
})();
