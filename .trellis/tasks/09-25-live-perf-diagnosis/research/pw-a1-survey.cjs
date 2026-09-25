/**
 * 阶段 A · 8004 Real Luker 只读体检盘点
 *
 * 只读约束（用户硬约束 + T1 R1）：
 *   - 仅 page.goto + page.evaluate 读 DOM / 读样式表 / 读动画
 *   - 不点击任何按钮、不提交表单、不调用任何写端点、不写 Instance/**
 *
 * 用法：node pw-a1-survey.cjs
 */
const path = require('path');
const fs = require('fs');

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    const globalRoot = require('child_process').execSync('npm root -g').toString().trim();
    return require(path.join(globalRoot, 'playwright'));
  }
}

const { chromium } = loadPlaywright();

const BASE = process.env.LUKER_URL || 'https://127.0.0.1:8004';
const PROJECT_ROOT = path.resolve(__dirname, '../../../..');
const PROFILE_DIR = path.join(PROJECT_ROOT, '.pw-profile');
const OUT = path.join(__dirname, 'a1-survey.json');

async function main() {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 950 },
    args: ['--disable-dev-shm-usage'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + String(e).slice(0, 300)));

  console.log('[A] 打开', BASE);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // 等 Luker 前端就绪（扩展设置锚点 / 发送表单任一出现）
  await page
    .waitForFunction(
      () => document.querySelector('#extensions_settings2, #extensions_settings, #send_form, #chat'),
      { timeout: 60_000 }
    )
    .catch(() => console.log('[A] 警告：宿主就绪锚点未出现，继续盘点'));

  // 等第三方扩展开机自检稳定（历史实测空闲期有数百 ms 长任务）
  await page.waitForTimeout(12_000);

  const data = await page.evaluate(() => {
    const out = {};

    out.url = location.href;
    out.title = document.title;
    out.nodeCount = document.getElementsByTagName('*').length;

    // ── 样式表规模 ──
    let sheets = 0;
    let totalRules = 0;
    let pluginRules = 0;
    const pluginSheets = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // 跨域样式表跳过
      }
      if (!rules) continue;
      sheets++;
      totalRules += rules.length;
      let hit = 0;
      for (const r of Array.from(rules)) {
        const t = r.cssText || '';
        if (t.includes('.st-converter-drawer-app') || t.includes('.app-container')) hit++;
      }
      if (hit > 0) {
        pluginRules += hit;
        pluginSheets.push({ href: sheet.href || '(inline)', rules: rules.length, pluginHits: hit });
      }
    }
    out.stylesheets = sheets;
    out.totalCssRules = totalRules;
    out.pluginCssRules = pluginRules;
    out.pluginSheets = pluginSheets;

    // ── 插件注入面 ──
    out.pluginDrawerNodes = document.querySelectorAll('.st-converter-drawer-app').length;
    out.appContainers = document.querySelectorAll('.app-container').length;
    out.injectedMarkers = document.querySelectorAll('[data-st-zip-injected]').length;
    out.dashboards = document.querySelectorAll('#usage-dashboard').length;
    out.badges = document.querySelectorAll('#env-badge').length;
    out.workbenchHosts = document.querySelectorAll('#log-console-mount').length;

    // ── 宿主环境标识 ──
    out.hasLukerContext = typeof globalThis.lukerContext !== 'undefined';
    out.hasSillyTavern = typeof globalThis.SillyTavern !== 'undefined';

    // ── 运行中的 Web Animations（含 CSS animation 与 transition）──
    const anims = document.getAnimations ? document.getAnimations() : [];
    out.runningAnimations = anims.length;
    const byType = {};
    const byOwner = {};
    for (const a of anims) {
      const t = a.constructor ? a.constructor.name : 'unknown';
      byType[t] = (byType[t] || 0) + 1;
      // 归属：最近的带 id 的祖先
      let el = a.effect && a.effect.target;
      let owner = '(no-target)';
      let depth = 0;
      while (el && depth < 12) {
        if (el.id) {
          owner = '#' + el.id;
          break;
        }
        const cls = (el.className && typeof el.className === 'string' ? el.className : '')
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .join('.');
        if (cls && !owner.startsWith('#')) owner = (el.tagName || '') + '.' + cls;
        el = el.parentElement;
        depth++;
      }
      byOwner[owner] = (byOwner[owner] || 0) + 1;
    }
    out.animationsByType = byType;
    out.animationsByOwner = byOwner;

    // ── 插件抽屉的可达性（只读探测，不点击）──
    const drawerCandidates = [];
    document.querySelectorAll('#extensions_settings2 .inline-drawer, #extensions_settings .inline-drawer').forEach((d) => {
      const title = (d.querySelector('.inline-drawer-toggle, .inline-drawer-header')?.textContent || '').trim().slice(0, 60);
      const hasPlugin = !!d.querySelector('.st-converter-drawer-app');
      drawerCandidates.push({ title, hasPlugin });
    });
    out.drawerCandidates = drawerCandidates;

    // ── 扩展菜单项（插件入口按钮）──
    const menuItems = [];
    document.querySelectorAll('#extensionsMenu .list-group-item, #extensionsMenu .menu_button').forEach((b) => {
      menuItems.push((b.textContent || '').trim().slice(0, 60));
    });
    out.extensionMenuItems = menuItems;

    return out;
  });

  data.consoleErrors = consoleErrors.slice(0, 30);
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2), 'utf8');

  console.log('\n===== 阶段 A 盘点结果 =====');
  console.log('URL:', data.url, '| title:', data.title);
  console.log('DOM 节点:', data.nodeCount);
  console.log('样式表:', data.stylesheets, '| 总规则:', data.totalCssRules, '| 插件规则:', data.pluginCssRules);
  console.log('插件样式表:', JSON.stringify(data.pluginSheets));
  console.log('插件抽屉节点:', data.pluginDrawerNodes, '| app-container:', data.appContainers, '| 注入标记:', data.injectedMarkers);
  console.log('配额容器:', data.dashboards, '| 徽标:', data.badges, '| 工作台挂载点:', data.workbenchHosts);
  console.log('lukerContext:', data.hasLukerContext, '| SillyTavern:', data.hasSillyTavern);
  console.log('运行中动画:', data.runningAnimations, '| 类型:', JSON.stringify(data.animationsByType));
  console.log('动画归属 Top:', JSON.stringify(Object.entries(data.animationsByOwner).sort((a, b) => b[1] - a[1]).slice(0, 10)));
  console.log('抽屉候选:', JSON.stringify(data.drawerCandidates.slice(0, 12)));
  console.log('扩展菜单项:', JSON.stringify(data.extensionMenuItems.slice(0, 12)));
  console.log('控制台错误数:', data.consoleErrors.length);
  console.log('\n落盘:', OUT);

  await ctx.close();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
