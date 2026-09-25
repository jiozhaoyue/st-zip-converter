/**
 * T2 阶段 1 验证 · 独立态（index.html 骨架 + getWorkbenchHtml 注入）渲染检查
 *
 * 目标：确认骨架化后独立态由模板函数完整渲染——关键业务节点全部存在、无控制台错误。
 * 用法：node pw-standalone-check.cjs
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
const URL = process.env.STANDALONE_URL || 'http://localhost:5173';
const OUT = path.join(__dirname, 'standalone-check.json');

// 与 scripts/single-template-source.js 的 REQUIRED_TEMPLATE_IDS 同源
const REQUIRED = [
  'btn-cancel-restore', 'btn-confirm-restore', 'btn-convert', 'btn-export-ext-manifest',
  'btn-host-fetch', 'btn-host-tree-cancel', 'btn-host-tree-confirm', 'btn-host-tree-selectall',
  'btn-restore-luker', 'btn-select-base-zip', 'category-panel', 'compression-select',
  'drop-main-text', 'drop-sub-text', 'dropzone', 'env-badge', 'export-queue-panel', 'file-input',
  'filename-preview', 'filename-template-input', 'host-base-archive-select', 'host-base-zip-input',
  'host-base-zip-section', 'host-base-zip-status', 'host-incremental-export', 'host-tree-confirm-bar',
  'host-user-badge', 'include-backups-check', 'include-cache-check', 'include-private-check',
  'incremental-mode-check', 'keep-dev-files-check', 'log-console-mount',
  'prune-builtin-check', 'restore-modal-desc', 'restore-modal-overlay', 'split-input',
  'stash-batch-bar', 'stash-list', 'target-select', 'usage-dashboard',
];

async function main() {
  const ctx = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 240));
  });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 240)));

  console.log('[独立态] 打开', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(4_000);

  const result = await page.evaluate((ids) => {
    const app = document.getElementById('app');
    const missing = ids.filter((id) => !document.getElementById(id));
    return {
      appExists: !!app,
      appClass: app ? app.className : null,
      appChildCount: app ? app.childNodes.length : 0,
      appNodeCount: app ? app.getElementsByTagName('*').length : 0,
      missingIds: missing,
      presentCount: ids.length - missing.length,
      totalIds: ids.length,
      // 关键区块存在性
      sections: {
        header: !!document.querySelector('.app-header'),
        footer: !!document.querySelector('.app-footer'),
        dropzone: !!document.getElementById('dropzone'),
        stashList: !!document.getElementById('stash-list'),
        exportQueue: !!document.getElementById('export-queue-panel'),
        progress: !!document.getElementById('progress-container'),
        taskControls: !!document.getElementById('task-controls'),
        categoryPanel: !!document.getElementById('category-panel'),
        unifiedOptions: !!document.querySelector('.unified-options'),
        logMount: !!document.getElementById('log-console-mount'),
      },
      badgeText: (document.getElementById('env-badge')?.textContent || '').slice(0, 40),
    };
  }, REQUIRED);

  result.consoleErrors = errors.slice(0, 20);
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');

  console.log('\n===== 独立态渲染检查 =====');
  console.log('#app 存在:', result.appExists, '| class:', result.appClass);
  console.log('#app 直接子节点:', result.appChildCount, '| 内部节点总数:', result.appNodeCount);
  console.log(`业务节点: ${result.presentCount}/${result.totalIds} 存在`);
  if (result.missingIds.length) console.log('  缺失:', JSON.stringify(result.missingIds));
  console.log('关键区块:', JSON.stringify(result.sections, null, 1));
  console.log('徽标文本:', result.badgeText);
  console.log('控制台错误:', result.consoleErrors.length);
  result.consoleErrors.slice(0, 8).forEach((e) => console.log('   ', e));
  console.log('\n落盘:', OUT);

  await ctx.close();
  const ok = result.missingIds.length === 0 && result.appNodeCount > 100 && errors.length === 0;
  console.log(ok ? '\n✅ 独立态渲染正常' : '\n❌ 独立态存在问题');
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
