/**
 * 真机 UI 异常诊断：Luker 8004
 * 全面采样：第三方扩展注入的样式/全局变量覆盖、body/主题异常、插件级冲突
 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 120)));

  await page.goto('https://127.0.0.1:8004/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => typeof globalThis.SillyTavern !== 'undefined', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(6000); // 等扩展全部挂载

  const report = await page.evaluate(() => {
    const out = {};
    const rootStyle = getComputedStyle(document.documentElement);
    const bodyStyle = getComputedStyle(document.body);

    // 1. 关键主题变量现状（Luker 默认 vs 被覆盖后）
    out.themeVars = {
      SmartThemeBodyColor: rootStyle.getPropertyValue('--SmartThemeBodyColor').trim(),
      SmartThemeQuoteColor: rootStyle.getPropertyValue('--SmartThemeQuoteColor').trim(),
      SmartThemeEmColor: rootStyle.getPropertyValue('--SmartThemeEmColor').trim(),
      SmartThemeBorderColor: rootStyle.getPropertyValue('--SmartThemeBorderColor').trim(),
      smartThemeFont: rootStyle.getPropertyValue('--SmartThemeFont').trim().slice(0, 40),
    };
    out.body = {
      background: bodyStyle.backgroundColor,
      color: bodyStyle.color,
      fontFamily: bodyStyle.fontFamily.slice(0, 60),
      overflow: bodyStyle.overflow,
      className: document.body.className.slice(0, 80),
    };

    // 2. 枚举页面上全部 <style> 与外部样式表归属（找出谁在注入全局规则）
    out.styleSheets = [];
    try {
      for (const sheet of document.styleSheets) {
        let owner = 'inline <style>';
        try {
          if (sheet.href) owner = sheet.href.split('/').slice(-3).join('/');
          const rules = Array.from(sheet.cssRules || []);
          const suspicious = rules.filter((r) => {
            const t = r.cssText || '';
            return /^\s*\*\s*[{,]/.test(t) || /^body\s*[{,]/.test(t) || /::-webkit-scrollbar/.test(t) || /^:root/.test(t);
          }).map((r) => (r.cssText || '').slice(0, 90));
          if (suspicious.length > 0) {
            out.styleSheets.push({ owner, globalRuleCount: suspicious.length, samples: suspicious.slice(0, 4) });
          }
        } catch (e) {
          // 跨域样式表读不了 cssRules，跳过
        }
      }
    } catch (e) { out.styleSheetsError = e.message; }

    // 3. 可见性异常检测：主 UI 容器
    const mainIds = ['main', 'chat', 'left-nav-panel', 'right-nav-panel', 'top-bar', 'dialogue_popup'];
    out.containers = {};
    for (const id of mainIds) {
      const el = document.getElementById(id);
      if (el) {
        const cs = getComputedStyle(el);
        out.containers[id] = { display: cs.display, visibility: cs.visibility, opacity: cs.opacity, h: el.clientHeight };
      }
    }

    // 4. inline style 数量（动态注入痕迹）
    out.inlineStyleCount = document.querySelectorAll('style').length;
    out.linkStyleCount = document.querySelectorAll('link[rel=stylesheet]').length;

    return out;
  });

  console.log('=== Luker 8004 UI 异常诊断 ===');
  console.log(JSON.stringify(report, null, 2));
  console.log('页面 JS 错误:', errors.length === 0 ? '无' : errors.slice(0, 5));
  await page.screenshot({ path: 'D:/Repo/Tavern-repo/My-repo/ST-zip-converter/.trellis/tasks/09-07-host-detect/research/luker-ui-diagnosis.png', fullPage: false });
  await browser.close();
})();
