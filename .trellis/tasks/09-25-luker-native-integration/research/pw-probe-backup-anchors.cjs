/**
 * 阶段 1 · ② 备份管理器注入锚点真机取证（只读）
 *
 * 背景：T2 两个探针在 8003/8004 上都没观测到 `.userBackupButton` 计数 > 0，
 * 当时点的是 #user-settings-button / #sys-settings-button / #extensionsMenuButton /
 * #user-settings-block —— 均非正确入口，故结论无效。
 *
 * 本轮由宿主源码定位到真实路径（funnycups/Luker user.js）：
 *   :3469  $('#account_button').on('click', () => openUserProfile())
 *   :2350  openUserProfile() → renderTemplateAsync('userProfile')
 *   :2372    template.find('.userBackupButton').on('click', …)
 *   :2378      await openBackupManager(currentUser.handle, () => location.reload())
 *   :1136  openBackupManager() → renderTemplateAsync('userBackupManager')  ← .backupActionRow 在此
 *
 * 本脚本按该路径逐步点击并逐层断言插件注入结果。
 * 只读约束：点 #account_button 与 **原生** .userBackupButton（仅开弹层，不触发下载）；
 *          绝不点插件注入的按钮，也不点弹层内的下载/恢复类按钮。
 * 用法：node pw-probe-backup-anchors.cjs
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
const BASE = process.env.LUKER_URL || 'https://127.0.0.1:8003';
const PROJECT_ROOT = path.resolve(__dirname, '../../../..');
const PROFILE_DIR = path.join(PROJECT_ROOT, '.pw-profile-dev');
const OUT = path.join(__dirname, 'probe-backup-anchors.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 采样当前 DOM 中的锚点与注入节点（含结构契约） */
const SNAPSHOT = () => {
  const injected = Array.from(document.querySelectorAll('[data-st-zip-injected="1"]'));
  return {
    userBackupButton: document.querySelectorAll('.userBackupButton').length,
    backupManager: document.querySelectorAll('.userBackupManager').length,
    backupActionRow: document.querySelectorAll('.backupActionRow').length,
    injectedCount: injected.length,
    injected: injected.map((n) => ({
      id: n.id,
      tag: n.tagName,
      cls: n.className,
      title: n.title,
      text: (n.textContent || '').trim(),
      childOrder: Array.from(n.children).map((c) => c.tagName),
      iconCls: n.querySelector('i')?.className || null,
      // 兄弟位是否为 .userBackupButton（幂等标记的锚点约定）
      prevIsAnchor: !!n.previousElementSibling?.classList?.contains('userBackupButton'),
      nextIsAnchor: !!n.nextElementSibling?.classList?.contains('userBackupButton'),
    })),
    // 顶层候选入口（仅用于确认 id 是否存在，不在此步点击）
    candidateOpeners: ['#account_button', '#admin_button', '#logout_button', '#server_logs_button']
      .map((sel) => ({ sel, present: !!document.querySelector(sel) })),
  };
};

async function main() {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 950 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e).slice(0, 160)));

  console.log('[0] 打开', BASE);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => document.querySelector('#chat, #extensions_settings2'), { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(9_000);

  const steps = [];
  const snap = async (label) => {
    const s = await page.evaluate(SNAPSHOT);
    steps.push({ label, ...s });
    console.log(`[${label}]`, JSON.stringify({
      userBackupButton: s.userBackupButton,
      backupManager: s.backupManager,
      backupActionRow: s.backupActionRow,
      injectedCount: s.injectedCount,
    }));
    return s;
  };

  await snap('初始');

  // ── 步骤 1：点 #account_button 打开账号弹层 ──
  const opened = await page.evaluate(() => {
    const el = document.querySelector('#account_button');
    if (!el) return { clicked: false };
    el.click();
    return { clicked: true, id: el.id, cls: el.className };
  });
  console.log('[1] 点击 #account_button:', JSON.stringify(opened));
  await page.waitForTimeout(2500);
  const afterProfile = await snap('账号弹层已开');

  // ── 步骤 2：点**原生** .userBackupButton 打开备份管理器 ──
  let openedMgr = null;
  if (afterProfile.userBackupButton > 0) {
    openedMgr = await page.evaluate(() => {
      const anchor = document.querySelector('.userBackupButton');
      if (!anchor) return { clicked: false };
      anchor.click();
      return { clicked: true, cls: anchor.className };
    });
    console.log('[2] 点击原生 .userBackupButton:', JSON.stringify(openedMgr));
    await page.waitForTimeout(2500);
  } else {
    console.log('[2] 跳过：账号弹层内未出现 .userBackupButton');
  }
  const afterManager = await snap('备份管理器已开');

  // ── 步骤 3：确认注入落在哪一行（.backupActionRow 实测有多个，而插件取 querySelector 第一个） ──
  const rows = await page.evaluate(() => {
    const list = Array.from(document.querySelectorAll('.userBackupManager .backupActionRow'));
    return list.map((row, i) => ({
      index: i,
      cls: String(row.className).slice(0, 60),
      text: (row.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60),
      // 该行是否含原生 ZIP 下载按钮（注释声称的落点依据）
      hasNativeZipDownload: !!row.querySelector('a[href$=".zip"], a[download], [data-i18n*="Download" i]'),
      injectedHere: !!row.querySelector('[data-st-zip-injected="1"]'),
      childTags: Array.from(row.children).map((c) => c.tagName + (c.id ? '#' + c.id : '')),
    }));
  });
  console.log('[3] 备份管理器动作行:');
  for (const r of rows) console.log('   ', JSON.stringify(r));

  const result = {
    sampledAt: new Date().toISOString(),
    url: BASE,
    sourceDerivedPath: [
      "user.js:3469 $('#account_button').on('click', () => openUserProfile())",
      "user.js:2350 openUserProfile() → renderTemplateAsync('userProfile')",
      "user.js:2372 template.find('.userBackupButton').on('click', …)",
      'user.js:1136 openBackupManager() → renderTemplateAsync(userBackupManager)',
    ],
    opened,
    openedMgr,
    steps,
    backupActionRows: rows,
    consoleErrors,
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');

  console.log('\n===== 结论 =====');
  console.log('源码路径推导:', result.sourceDerivedPath.join(' → '));
  for (const s of steps) {
    console.log(`  ${s.label.padEnd(14)} userBackupButton=${s.userBackupButton} backupManager=${s.backupManager} backupActionRow=${s.backupActionRow} injected=${s.injectedCount}`);
  }
  const last = steps[steps.length - 1];
  if (last.injected.length) {
    console.log('注入节点明细:');
    for (const b of last.injected) console.log('   ', JSON.stringify(b));
  }
  console.log('控制台错误:', consoleErrors.length ? JSON.stringify(consoleErrors.slice(0, 6)) : '0');
  console.log('落盘:', OUT);

  await ctx.close();
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
