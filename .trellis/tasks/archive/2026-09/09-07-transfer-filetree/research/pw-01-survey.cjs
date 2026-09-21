/**
 * 全面实测 01b：连接保活浏览器（CDP 9222），采样 Luker 8004 插件页
 * 输出：插件抽屉内徽标重复 / 配额条现状 / 插件容器结构
 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  let page = null;
  for (const p of ctx.pages()) {
    if (p.url().includes('127.0.0.1:8004')) { page = p; break; }
  }
  if (!page) {
    page = await ctx.newPage();
    await page.goto('https://127.0.0.1:8004/', { waitUntil: 'load', timeout: 30000 }).catch(() => {});
  }
  await page.waitForFunction(() => typeof globalThis.lukerContext !== 'undefined', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const report = await page.evaluate(() => {
    const out = {};
    const drawer = document.querySelector('.st-converter-drawer-app');
    out.pluginMounted = Boolean(drawer);
    if (drawer) {
      const heads = [];
      drawer.querySelectorAll('.wb-env-badge, [class*="env"], [class*="host-tag"], .zone-title').forEach((el) => {
        const t = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
        if (t) heads.push({ cls: el.className.toString().slice(0, 50), text: t });
      });
      out.drawerHeads = heads.slice(0, 20);

      const quotas = [];
      drawer.querySelectorAll('[class*="quota"],[id*="quota"],[class*="usage"],[id*="usage"],[class*="dashboard"]').forEach((el) => {
        const t = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100);
        if (t) quotas.push({ id: el.id, cls: el.className.toString().slice(0, 50), text: t });
      });
      out.drawerQuotas = quotas.slice(0, 15);
    }

    const hostDrawer = drawer ? drawer.closest('.inline-drawer') : null;
    const content = hostDrawer ? hostDrawer.querySelector('.inline-drawer-content') : null;
    out.hostDrawerOpen = content ? (content.style.display !== 'none' && content.offsetHeight > 0) : null;
    return out;
  });

  console.log(JSON.stringify(report, null, 2));
  await page.screenshot({ path: 'D:/Repo/Tavern-repo/My-repo/ST-zip-converter/.trellis/tasks/09-07-transfer-filetree/research/full-page-current.png' });
})();
