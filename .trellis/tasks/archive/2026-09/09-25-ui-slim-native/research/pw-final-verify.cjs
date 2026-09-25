/**
 * T2 收尾复验 · 8004 Real Luker 实机（只读）
 *
 * 覆盖三项收尾改动的真实宿主取证（不是 stub）：
 *   1. 宿主原生确认适配器：`SillyTavern.getContext().Popup.show.confirm` 是否真实存在
 *   2. 端到端往返：真实唤起一次原生确认弹窗并取消，验证返回 AFFIRMATIVE 语义
 *   3. 注入按钮工厂 `makeHostButton`：宿主锚点旁注入的按钮结构与幂等标记
 *   4. 插件抽屉态渲染读数（与改造前基线对照）
 *
 * 只读约束：不点击任何执行类按钮（转换/拉取/恢复/导出/删除），不调写端点，
 *           不写实例数据；仅做 UI 视图采样与一次可取消的确认弹窗往返。
 * 用法：node pw-final-verify.cjs
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
const OUT = path.join(__dirname, 'final-verify-8004.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 探测宿主原生确认能力（真机特征检测，对应 confirmDialog 的特性检测分支） */
async function probeAdapter(page) {
  return page.evaluate(() => {
    const hasGetContext = typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function';
    const ctx = hasGetContext ? SillyTavern.getContext() : null;
    return {
      hasGetContext,
      popupShowConfirm: ctx?.Popup?.show?.confirm ? typeof ctx.Popup.show.confirm : 'undefined',
      affirmative: ctx?.POPUP_RESULT?.AFFIRMATIVE,
      negative: ctx?.POPUP_RESULT?.NEGATIVE,
    };
  });
}

/** 真实往返一次：唤起原生确认弹窗 → 点取消 → 校验返回非 AFFIRMATIVE */
async function roundTrip(page) {
  return page.evaluate(async () => {
    const ctx = SillyTavern.getContext();
    const p = ctx.Popup.show.confirm('数据包互转', '实机复验：点击取消');
    await new Promise((r) => setTimeout(r, 600));

    const popup = document.querySelector('.popup');
    const buttonTexts = [];
    let clicked = null;
    if (popup) {
      const btns = Array.from(popup.querySelectorAll('button, .popup-button'));
      for (const b of btns) buttonTexts.push((b.textContent || '').trim().slice(0, 20));
      const cancel = btns.find((b) => /取消|cancel|否|no/i.test(b.textContent || ''));
      if (cancel) {
        cancel.click();
        clicked = (cancel.textContent || '').trim();
      }
    }

    // 有界等待（L1-MR-7）：弹窗未按预期关闭时不无限挂起
    const settled = await Promise.race([
      p.then((r) => ({ settled: true, result: r })),
      new Promise((r) => setTimeout(() => r({ settled: false, result: null }), 4000)),
    ]);

    // 兜底清理：任何残留弹窗就地移除，避免污染后续面板采样
    document.querySelectorAll('.popup').forEach((el) => el.remove());

    return {
      affirmative: ctx.POPUP_RESULT.AFFIRMATIVE,
      negative: ctx.POPUP_RESULT.NEGATIVE ?? null,
      popupFound: !!popup,
      buttonTexts,
      clicked,
      ...settled,
    };
  });
}

/** 注入按钮工厂取证：打开账号弹层后枚举 stZipInjected 节点 */
async function probeInjectedButtons(page) {
  return page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let openedBy = null;
    if (document.querySelectorAll('.userBackupButton').length === 0) {
      for (const sel of ['#user-settings-button', '#sys-settings-button', '#rightNavHolder .drawer-icon']) {
        const el = document.querySelector(sel);
        if (el) {
          el.click();
          openedBy = sel;
          break;
        }
      }
      await wait(1500);
    }
    const nodes = Array.from(document.querySelectorAll('[data-st-zip-injected="1"]'));
    return {
      openedBy,
      anchors: document.querySelectorAll('.userBackupButton').length,
      injectedCount: nodes.length,
      injected: nodes.map((n) => ({
        id: n.id,
        tag: n.tagName,
        cls: n.className,
        title: n.title,
        hasIcon: !!n.querySelector('i.fa-solid'),
        iconCls: n.querySelector('i')?.className || null,
        hasSpan: !!n.querySelector('span'),
        text: (n.textContent || '').trim(),
        // 工厂契约：图标在前、文案在后
        childOrder: Array.from(n.children).map((c) => c.tagName),
      })),
    };
  });
}

async function main() {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 950 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e).slice(0, 200)));

  console.log('[0] 打开', BASE);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => document.querySelector('#extensions_settings2, #chat'), { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(9_000);

  const pluginLoaded = await page.evaluate(() => ({
    hasDrawerApp: !!document.querySelector('.st-converter-drawer-app'),
    settingsBlock: !!document.getElementById('st_zip_converter_settings'),
    extensionsBlock: !!document.getElementById('rm_extensions_block'),
  }));
  console.log('[1] 插件装载:', JSON.stringify(pluginLoaded));

  const adapter = await probeAdapter(page);
  console.log('[2] 宿主原生确认能力:', JSON.stringify(adapter));

  const trip = await roundTrip(page);
  console.log('[3] 端到端往返:', JSON.stringify(trip));

  const injected = await probeInjectedButtons(page);
  console.log('[4] 注入按钮:', JSON.stringify({ ...injected, injected: undefined }));
  for (const b of injected.injected) console.log('      ', JSON.stringify(b));

  // ── 抽屉态渲染读数（与改造前基线对照） ──
  const opened = await page.evaluate(() => {
    const block = document.getElementById('rm_extensions_block');
    if (block) {
      block.classList.remove('closedDrawer');
      block.style.display = 'block';
    }
    const content = document.querySelector('#st_zip_converter_settings > .inline-drawer-content');
    if (content) content.style.display = 'block';
    const app = document.querySelector('.st-converter-drawer-app');
    return {
      blockDisplay: block ? getComputedStyle(block).display : null,
      appHeight: app ? Math.round(app.getBoundingClientRect().height) : 0,
      appWidth: app ? Math.round(app.getBoundingClientRect().width) : 0,
    };
  });
  console.log('[5] 打开面板:', JSON.stringify(opened));
  await sleep(2000);

  const uiFacts = await page.evaluate(() => {
    const app = document.querySelector('.st-converter-drawer-app');
    if (!app) return null;
    const btns = Array.from(app.querySelectorAll('button'));
    const visible = btns.filter((b) => b.getBoundingClientRect().height > 0);
    return {
      nodeCount: app.getElementsByTagName('*').length,
      buttonsTotal: btns.length,
      buttonsVisible: visible.length,
      inputs: app.querySelectorAll('input,select,textarea').length,
      checkboxes: app.querySelectorAll('input[type=checkbox]').length,
      radios: app.querySelectorAll('input[type=radio]').length,
      details: app.querySelectorAll('details').length,
      labels: app.querySelectorAll('label').length,
      scrollHeight: app.scrollHeight,
      clientHeight: app.clientHeight,
      inlineDrawers: app.querySelectorAll('.inline-drawer').length,
      buttonLabels: visible.map((b) => (b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24)),
    };
  });
  console.log('[6] UI 事实:', JSON.stringify({ ...uiFacts, buttonLabels: undefined }));
  console.log('[6] 可见按钮:', JSON.stringify(uiFacts && uiFacts.buttonLabels));

  const result = {
    sampledAt: new Date().toISOString(),
    url: BASE,
    pluginLoaded,
    adapter,
    roundTrip: trip,
    injectedButtons: injected,
    opened,
    uiFacts,
    consoleErrors,
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');

  console.log('\n===== 结论 =====');
  console.log('宿主原生 Popup.show.confirm:', adapter.popupShowConfirm, '| AFFIRMATIVE =', adapter.affirmative);
  console.log('端到端往返 settle:', trip.settled, '| 返回', trip.result, '| 点中按钮', trip.clicked);
  console.log('注入按钮:', injected.injectedCount, '枚 →', injected.injected.map((b) => b.id).join(', ') || '(无)');
  console.log('控制台错误:', consoleErrors.length ? JSON.stringify(consoleErrors) : '0');
  console.log('落盘:', OUT);

  await ctx.close();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
