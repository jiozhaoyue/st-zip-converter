/**
 * 验证方案 A 效果：在页面上下文执行 movingUI 复位后对比 UI 几何
 * 注意：这是只读验证（改的是浏览器内存态，不写实例文件；saveSettings 需用户在页面确认）
 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
  await page.goto('https://127.0.0.1:8004/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => typeof globalThis.lukerContext !== 'undefined', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(8000);

  const before = await page.evaluate(() => ({
    movingUI: document.body.classList.contains('movingUI'),
    absoluteDrawers: Array.from(document.querySelectorAll('.drawer-content, #rm_api_block, #AdvancedFormatting, #WorldInfo')).filter((e) => getComputedStyle(e).position === 'absolute').length,
  }));

  // 执行复位（内存态验证）
  const reset = await page.evaluate(() => {
    const ctx = globalThis.lukerContext;
    const pu = ctx.powerUserSettings;
    if (!pu) return { ok: false, reason: 'no powerUserSettings' };
    pu.movingUI = false;
    pu.movingUIState = {};
    document.body.classList.remove('movingUI');
    return { ok: true, movedKeys: 'cleared' };
  });

  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => ({
    movingUI: document.body.classList.contains('movingUI'),
    absoluteDrawers: Array.from(document.querySelectorAll('.drawer-content, #rm_api_block, #AdvancedFormatting, #WorldInfo')).filter((e) => getComputedStyle(e).position === 'absolute').length,
  }));
  console.log('复位前:', JSON.stringify(before));
  console.log('复位操作:', JSON.stringify(reset));
  console.log('复位后:', JSON.stringify(after));
  await browser.close();
})();
