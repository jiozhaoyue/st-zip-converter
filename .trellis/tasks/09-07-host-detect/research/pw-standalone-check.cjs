const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4519/', { waitUntil: 'load', timeout: 25000 });
  await page.waitForSelector('.app-container', { timeout: 15000 });
  const layout = await page.evaluate(() => {
    const app = document.querySelector('.app-container');
    const bodyStyle = getComputedStyle(document.body);
    const appStyle = app ? getComputedStyle(app) : null;
    const drawer = document.querySelector('.inline-drawer');
    return {
      appLoaded: Boolean(app),
      bodyFlexCentered: bodyStyle.display === 'flex',
      bodyBg: bodyStyle.backgroundImage.substring(0, 40),
      appMaxWidth: appStyle ? appStyle.maxWidth : null,
      variablesOnApp: app ? getComputedStyle(app).getPropertyValue('--tavern-gold').trim() : null,
      drawerRadius: drawer ? getComputedStyle(drawer).borderRadius : null,
    };
  });
  console.log('独立 Web 模式布局:', JSON.stringify(layout, null, 2));
  await page.screenshot({ path: 'D:/Repo/Tavern-repo/My-repo/ST-zip-converter/.trellis/tasks/09-07-host-detect/research/standalone-ui-check.png' });
  await browser.close();
})();
