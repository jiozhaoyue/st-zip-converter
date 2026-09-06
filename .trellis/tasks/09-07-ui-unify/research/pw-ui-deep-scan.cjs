/**
 * 深挖 UI 异常根源 #2：持久化脏数据扫描
 * 检查 localStorage/settings 中保存的主题值、第三方扩展的双份加载、
 * 以及 enableServerPlugins 级别的脏状态。
 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
  await page.goto('https://127.0.0.1:8004/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => typeof globalThis.SillyTavern !== 'undefined', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(6000);

  const report = await page.evaluate(async () => {
    const out = {};

    // 1. settings.json 里的主题与 UI 状态（宿主持久化设置）
    try {
      const token = (await (await fetch('/csrf-token', { credentials: 'same-origin' })).json()).token;
      const s = await (await fetch('/api/settings/get', {
        method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': token }, body: '{}',
      })).json();
      const settings = s.result || s;
      out.powerUser = settings.power_user ? {
        theme: settings.power_user.theme,
        main_text_colors: settings.power_user.main_text_colors ? '自定义了' : '默认',
        custom_css: (settings.power_user.custom_css || '').slice(0, 300),
        movingUI: settings.power_user.movingUI,
        noShadows: settings.power_user.noShadows,
        blur_strength: settings.power_user.blur_strength,
      } : 'no power_user';
    } catch (e) { out.settingsError = e.message; }

    // 2. 第三方扩展加载清单与重复检测
    const scripts = Array.from(document.querySelectorAll('script[src]'))
      .map((s) => s.src).filter((s) => s.includes('third-party'));
    const nameCount = {};
    for (const s of scripts) {
      const name = decodeURIComponent(s.split('/third-party/')[1] || '').split('/')[0];
      nameCount[name] = (nameCount[name] || 0) + 1;
    }
    out.extensionLoadCounts = nameCount;
    out.duplicatedExtensions = Object.entries(nameCount).filter(([, n]) => n > 1).map(([n, c]) => `${n} x${c}`);

    // 3. 重复的 <style> 注入（同 owner 出现两次=双份扩展实例）
    const styleOwners = Array.from(document.querySelectorAll('link[rel=stylesheet]'))
      .map((l) => l.href.split('/').slice(-2).join('/'));
    const styleCount = {};
    for (const s of styleOwners) styleCount[s] = (styleCount[s] || 0) + 1;
    out.duplicatedStyles = Object.entries(styleCount).filter(([, n]) => n > 1);

    // 4. localStorage 脏键扫描（第三方扩展留在宿主页面的键）
    out.localStorageKeys = Object.keys(localStorage).length;
    out.suspiciousLocalKeys = Object.keys(localStorage).filter((k) =>
      /luker|converter|menu-cleaner|paws|persona|companion|reminder|swipe/i.test(k)).slice(0, 15);

    // 5. movingUI 状态（body class 里已有 movingUI —— 这是拖拽模式，会让 UI 元素乱飘！）
    out.bodyClasses = document.body.className;
    out.movingUIActive = document.body.classList.contains('movingUI');

    return out;
  });

  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})();
