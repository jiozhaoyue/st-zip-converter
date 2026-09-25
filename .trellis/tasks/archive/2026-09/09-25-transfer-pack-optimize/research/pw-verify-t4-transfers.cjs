/**
 * T4 实机验证 · 上下传链路与打包收敛（Dev 8003，只读）
 *
 * 断言点：
 *   1. 死开关已移除：`#incremental-mode-check` 在 DOM 中不存在；J 区只剩「差量补丁」一个复选框
 *   2. 压缩率档位语义化：option 文本为 存储/快速/标准/最大，value 仍为 0/1/5/9，默认选中 5
 *   3. 分卷默认仍为「空 = 不分卷」
 *   4. 恢复模态的两个选项已改名（合并写入 / 覆盖写入），value 仍为 merge/overwrite
 *   5. 插件零控制台报错；抽屉渲染读数与基线对照
 *
 * 只读约束：不点任何执行类按钮（转换/拉取/恢复/导出/删除）。
 * 用法：node pw-verify-t4-transfers.cjs
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
const OUT = path.join(__dirname, 'verify-t4.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 950 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e).slice(0, 200)));

  console.log('[0] 打开', BASE);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => document.querySelector('#chat, #extensions_settings2'), { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(9_000);

  await page.evaluate(() => {
    const block = document.getElementById('rm_extensions_block');
    if (block) { block.classList.remove('closedDrawer'); block.style.display = 'block'; }
    const content = document.querySelector('#st_zip_converter_settings > .inline-drawer-content');
    if (content) content.style.display = 'block';
  });
  await sleep(2500);

  const facts = await page.evaluate(() => {
    const app = document.querySelector('.st-converter-drawer-app');
    const deltaFold = document.getElementById('fold-incremental');
    const comp = document.getElementById('compression-select');
    const split = document.getElementById('split-input');
    const restoreRadios = Array.from(document.querySelectorAll('input[name="restore-mode"]'));
    return {
      // 1. 死开关
      deadSwitchPresent: !!document.getElementById('incremental-mode-check'),
      jRegionCheckboxes: deltaFold
        ? Array.from(deltaFold.querySelectorAll('input[type=checkbox]')).map((c) => c.id)
        : null,
      // 2. 压缩率
      compressionOptions: comp
        ? Array.from(comp.options).map((o) => ({ value: o.value, text: o.textContent.trim(), selected: o.selected }))
        : null,
      // 3. 分卷默认
      splitValue: split ? split.value : null,
      splitPlaceholder: split ? split.placeholder : null,
      splitMin: split ? split.min : null,
      // 4. 恢复模态改名
      restoreModes: restoreRadios.map((r) => ({
        value: r.value,
        checked: r.checked,
        label: (r.parentElement?.querySelector('.radio-text')?.textContent || '').trim(),
      })),
      // 5. 渲染读数
      nodeCount: app ? app.getElementsByTagName('*').length : 0,
      buttonsTotal: app ? app.querySelectorAll('button').length : 0,
      inlineDrawers: app ? app.querySelectorAll('.inline-drawer').length : 0,
      details: app ? app.querySelectorAll('details').length : 0,
      appHeight: app ? Math.round(app.getBoundingClientRect().height) : 0,
    };
  });

  const result = { sampledAt: new Date().toISOString(), url: BASE, facts, consoleErrors };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');

  console.log('\n===== 结论 =====');
  console.log('1) 死开关 #incremental-mode-check 存在:', facts.deadSwitchPresent, '(期望 false)');
  console.log('   J 区复选框:', JSON.stringify(facts.jRegionCheckboxes), '(期望仅 host-incremental-export)');
  console.log('2) 压缩率档位:', JSON.stringify(facts.compressionOptions));
  console.log('3) 分卷默认:', JSON.stringify({ value: facts.splitValue, placeholder: facts.splitPlaceholder, min: facts.splitMin }));
  console.log('4) 恢复模态:', JSON.stringify(facts.restoreModes));
  console.log('5) 渲染:', JSON.stringify({
    nodeCount: facts.nodeCount, buttonsTotal: facts.buttonsTotal,
    inlineDrawers: facts.inlineDrawers, details: facts.details, appHeight: facts.appHeight,
  }));
  console.log('插件相关控制台错误:', consoleErrors.filter((e) => /st-zip-converter/i.test(e)).length ? JSON.stringify(consoleErrors.filter((e) => /st-zip-converter/i.test(e))) : '0');
  console.log('控制台错误总数（含其他扩展）:', consoleErrors.length);
  console.log('落盘:', OUT);

  await ctx.close();
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
