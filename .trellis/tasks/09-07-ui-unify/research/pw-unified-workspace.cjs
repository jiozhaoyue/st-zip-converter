/**
 * ui-unify 端到端验证：统一工作台 / 工作区单列表 / 待导出区 / 用量看板
 * 在独立 Web 模式（生产构建 preview）运行。
 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto('http://127.0.0.1:4519/', { waitUntil: 'load', timeout: 25000 });
  await page.waitForSelector('.app-container', { timeout: 15000 });

  const checks = {};

  // 1. 唯一工作区：状态条 + 工作区抽屉
  checks.statusBarText = await page.textContent('#workspace-status-text');
  checks.workspaceDrawerTitle = await page.textContent('#workspace-panel-drawer .inline-drawer-header b');

  // 2. 待导出区面板存在
  checks.exportQueuePanel = Boolean(await page.$('#export-queue-panel'));
  checks.exportQueueEmptyText = await page.textContent('.export-queue-empty').catch(() => null);

  // 3. 用量看板存在
  checks.usageDashboard = Boolean(await page.$('#usage-dashboard'));
  checks.usageEmpty = await page.textContent('.usage-empty').catch(() => null);

  // 4. 工作区单列表空状态文案（不再出现"已上传源包/已转换生成包"双栏）
  checks.archiveEmpty = await page.textContent('.archive-empty').catch(() => null);
  checks.noDualColumns = (await page.$('.archive-manager-grid')) === null;

  // 5. 展开工作区抽屉看渲染
  await page.click('#workspace-panel-drawer .inline-drawer-toggle');
  await page.waitForTimeout(300);
  checks.drawerExpands = Boolean(await page.$('#workspace-panel-drawer .inline-drawer-content'));

  // 6. 宿主导出区在独立模式应隐藏
  checks.hostCardHidden = !(await page.isVisible('#host-export-card'));

  // 7. 0 Emoji 扫描（页面文本）
  const emojiCount = await page.evaluate(() => {
    const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu;
    return (document.querySelector('.app-container').innerText.match(emojiRe) || []).length;
  });
  checks.emojiCount = emojiCount;

  console.log(JSON.stringify(checks, null, 2));
  console.log('JS errors:', errors.length === 0 ? '无' : errors.join('\n'));
  await page.screenshot({ path: 'D:/Repo/Tavern-repo/My-repo/ST-zip-converter/.trellis/tasks/09-07-ui-unify/research/unified-workspace-check.png', fullPage: true });
  await browser.close();
})();
