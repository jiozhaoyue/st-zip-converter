/**
 * 定点探针（只读）：定位 Luker 上的
 *   (1) 原生弹窗真实 DOM 结构（用于端到端往返点击取消）
 *   (2) 本插件注入锚点 `.userBackupButton` / `.userBackupManager .backupActionRow`
 *       在 Luker 2.7.0 上是否存在，以及导出弹层打开后锚点是否出现
 * 不写实例数据、不调写端点。
 * 用法：node pw-probe-anchors.cjs
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
const OUT = path.join(__dirname, 'probe-anchors.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 950 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => document.querySelector('#extensions_settings2, #chat'), { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(9_000);

  // ── (1) 弹窗结构：唤起原生确认并 dump DOM，然后尽力关闭 ──
  const popupProbe = await page.evaluate(async () => {
    const ctx2 = SillyTavern.getContext();
    const p = ctx2.Popup.show.confirm('数据包互转', '结构探针：即将自动关闭');
    p.catch(() => {});
    await new Promise((r) => setTimeout(r, 700));

    const dump = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('[class*="popup" i]')) {
      const cls = String(el.className || '');
      if (seen.has(cls)) continue;
      seen.add(cls);
      const r = el.getBoundingClientRect();
      dump.push({
        tag: el.tagName,
        cls,
        visible: r.height > 0,
        clickable: el.matches('button, .popup-button, [class*="button" i]'),
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30),
      });
      if (dump.length >= 25) break;
    }

    // 候选关闭手段，按可靠性排序逐个尝试
    const tried = [];
    const byBtn = document.querySelector('.popup-button-cancel');
    if (byBtn) { byBtn.click(); tried.push('popup-button-cancel'); }

    // Esc 兜底
    for (const type of ['keydown', 'keyup']) {
      document.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', keyCode: 27, bubbles: true }));
      document.body.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', keyCode: 27, bubbles: true }));
    }
    tried.push('escape');

    const settled = await Promise.race([
      p.then((r) => ({ settled: true, result: r })),
      new Promise((r) => setTimeout(() => r({ settled: false, result: null }), 3000)),
    ]);

    // 兜底清理：可见的弹窗容器就地移除（仅本会话视图，无数据影响）
    let removed = 0;
    for (const el of document.querySelectorAll('.popup, [class*="popup_body" i], [class*="popup" i]')) {
      if (el.getBoundingClientRect().height > 0 && el.parentElement) {
        el.style.display = 'none';
        removed += 1;
      }
    }

    return { dump, tried, removed, ...settled };
  });
  console.log('[弹窗结构]', JSON.stringify(popupProbe.dump, null, 1));
  console.log('[弹窗关闭]', JSON.stringify({ tried: popupProbe.tried, settled: popupProbe.settled, result: popupProbe.result, hidden: popupProbe.removed }));

  // ── (2) 注入锚点普查（含各弹层打开前后） ──
  const anchorSurvey = async (label) =>
    page.evaluate((lbl) => ({
      label: lbl,
      userBackupButton: document.querySelectorAll('.userBackupButton').length,
      backupManager: document.querySelectorAll('.userBackupManager').length,
      backupActionRow: document.querySelectorAll('.backupActionRow').length,
      injected: document.querySelectorAll('[data-st-zip-injected="1"]').length,
      backupish: Array.from(document.querySelectorAll('[class*="ackup" i]'))
        .slice(0, 12)
        .map((el) => ({ tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 60) })),
    }), label);

  const survey = [await anchorSurvey('初始')];

  // 逐个尝试打开可能承载备份 UI 的宿主面板
  const openers = [
    '#user-settings-button', '#sys-settings-button', '#extensionsMenuButton',
    '#rm_button_settings', '#user-settings-block',
  ];
  for (const sel of openers) {
    const clicked = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return false;
      el.click();
      return true;
    }, sel);
    if (!clicked) continue;
    await sleep(1200);
    survey.push(await anchorSurvey('点击 ' + sel));
  }

  // Luker 原生备份管理器入口（若存在）
  const mgrClicked = await page.evaluate(() => {
    const el = document.querySelector('#user_backup_manager, [data-i18n="Backup & Restore"], #backup_manager_button');
    if (!el) return false;
    el.click();
    return true;
  });
  if (mgrClicked) {
    await sleep(1500);
    survey.push(await anchorSurvey('备份管理器入口'));
  }

  console.log('\n[锚点普查]');
  for (const s of survey) console.log('  ', JSON.stringify({ ...s, backupish: undefined }));
  const hits = survey.filter((s) => s.userBackupButton || s.backupManager || s.backupActionRow || s.injected);
  console.log('  命中采样点:', hits.length ? JSON.stringify(hits) : '(全程未出现锚点)');
  console.log('  backup 类名样本:', JSON.stringify(survey[survey.length - 1].backupish));

  fs.writeFileSync(OUT, JSON.stringify({ sampledAt: new Date().toISOString(), popupProbe, survey }, null, 2), 'utf8');
  console.log('\n落盘:', OUT);
  await ctx.close();
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
