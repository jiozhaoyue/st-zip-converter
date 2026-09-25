/**
 * 阶段 2 · ① 存储配额接入原生 Inspector 实机验证（Dev 8003）
 *
 * 验证契约（R1.1 / R1.2 / R1.3）：
 *   1. 抽屉态下 `#btn-storage-inspector` 由插件探测后**解除 hidden**（宿主能力可用）
 *   2. 点击后**真的唤起 Luker 原生 Storage Inspector**（容器 class
 *      `storageInspectorContainerWrapper`，见宿主 storage-inspector.js 的 openStorageInspector）
 *   3. 原生面板只读（mutator 为 ThrowingMutator）——本脚本只打开与关闭，不做任何写操作
 *
 * 只读约束：不点面板内的任何动作按钮；结束时仅隐藏残留弹窗（本会话视图）。
 * 用法：node pw-verify-storage-inspector.cjs
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
const OUT = path.join(__dirname, 'verify-storage-inspector.json');
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

  // ── 打开扩展设置块与工作台抽屉（该按钮仅抽屉态渲染） ──
  await page.evaluate(() => {
    const block = document.getElementById('rm_extensions_block');
    if (block) { block.classList.remove('closedDrawer'); block.style.display = 'block'; }
    const content = document.querySelector('#st_zip_converter_settings > .inline-drawer-content');
    if (content) content.style.display = 'block';
  });
  await sleep(3000); // 等插件的可用性探测完成

  const before = await page.evaluate(() => {
    const btn = document.getElementById('btn-storage-inspector');
    return {
      exists: !!btn,
      hiddenAttr: btn ? btn.hidden : null,
      display: btn ? getComputedStyle(btn).display : null,
      rectHeight: btn ? Math.round(btn.getBoundingClientRect().height) : 0,
      text: btn ? (btn.textContent || '').trim() : null,
    };
  });
  console.log('[1] 按钮可用性:', JSON.stringify(before));

  if (!before.exists) {
    console.log('!! 抽屉态未渲染 #btn-storage-inspector，无法继续');
    fs.writeFileSync(OUT, JSON.stringify({ sampledAt: new Date().toISOString(), before, error: 'button-missing' }, null, 2), 'utf8');
    await ctx.close();
    return;
  }

  // ── 点击唤起原生 Inspector ──
  await page.evaluate(() => document.getElementById('btn-storage-inspector').click());
  await sleep(4000);

  const after = await page.evaluate(() => {
    const wrapper = document.querySelector('.storageInspectorContainerWrapper');
    return {
      inspectorWrapperFound: !!wrapper,
      wrapperVisible: wrapper ? wrapper.getBoundingClientRect().height > 0 : false,
      // 宿主 Inspector 的内部结构证据
      hasLoading: !!wrapper?.querySelector('.storageInspectorLoading'),
      hasError: !!wrapper?.querySelector('.storageInspectorError'),
      errorVisible: wrapper?.querySelector('.storageInspectorError')?.classList?.contains('displayNone') === false,
      errorMessage: wrapper?.querySelector('.storageInspectorErrorMessage')?.textContent || null,
      // 面板内是否已渲染出存储条目（说明数据真的取到了）
      rowishCount: wrapper ? wrapper.querySelectorAll('tr, li, .storageInspectorRow').length : 0,
      textSample: wrapper ? (wrapper.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200) : null,
      // 是否存在可见弹窗容器
      popupFound: !!document.querySelector('.popup'),
    };
  });
  console.log('[2] 原生面板:', JSON.stringify({ ...after, textSample: undefined }));
  if (after.textSample) console.log('    文本样本:', after.textSample);

  const result = {
    sampledAt: new Date().toISOString(),
    url: BASE,
    before,
    after,
    consoleErrors,
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');

  // ── 收尾：隐藏残留弹窗（仅本会话视图，不写实例数据） ──
  const hidden = await page.evaluate(() => {
    let n = 0;
    for (const el of document.querySelectorAll('[class*="popup" i]')) {
      if (el.getBoundingClientRect().height > 0) { el.style.display = 'none'; n += 1; }
    }
    return n;
  });

  console.log('\n===== 结论 =====');
  console.log('按钮解除 hidden:', before.hiddenAttr === false, `(hidden=${before.hiddenAttr}, display=${before.display}, h=${before.rectHeight}px)`);
  console.log('原生 Inspector 唤起:', after.inspectorWrapperFound, '| 可见:', after.wrapperVisible, '| 报错:', after.errorVisible);
  console.log('面板内条目数:', after.rowishCount);
  console.log('收尾隐藏弹窗:', hidden);
  console.log('控制台错误:', consoleErrors.length ? JSON.stringify(consoleErrors.slice(0, 6)) : '0');
  console.log('落盘:', OUT);

  await ctx.close();
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
