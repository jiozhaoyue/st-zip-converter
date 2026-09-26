/**
 * PT（PureTavern）界面探查器 —— 摸清「扩展管理」与「M21 导入」的入口在哪
 *
 * 为什么需要探查：PT 是 Vue SPA、界面结构与 ST/Luker 不同，且本插件尚未装到 PT 上。
 * 在写自动化导入之前，先**看清有哪些可点的东西**，避免盲猜选择器（L1-MR-5 精神：
 * 不靠猜。PT 无公开文档，故以**实际 DOM** 为准，并把结果落盘留证）。
 *
 * 用法：
 *   node scripts/instance-sync/diag-pt-ui.cjs                # 打开首页并列出可交互元素
 *   node scripts/instance-sync/diag-pt-ui.cjs --url <path>   # 指定路径
 *
 * 产出：`test-results/pt-ui-<时间戳>.json`（按钮/链接文本清单）+ 截图。
 */

const fs = require('fs');
const path = require('path');

const { loadPlaywright, warnOnVersionDrift } = require('../../e2e/lib/resolve-playwright.cjs');
const { getInstance } = require('../../e2e/lib/instances.cjs');

function parseArgs(argv) {
  const out = { urlPath: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url') out.urlPath = argv[++i] || '';
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const inst = getInstance('pt-web');
  const pw = loadPlaywright();
  warnOnVersionDrift(pw);

  const outDir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const ctx = await pw.chromium.launchPersistentContext(inst.profile, {
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    const target = inst.url + (args.urlPath || '');
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // SPA：等网络安静，否则抓到的还是空壳
    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});

    /**
     * PT 首屏会显示「正在初始化…」，此时 DOM 是个空壳（实测：74 个可交互元素**全部不可见**、
     * body 文本为空）。必须**有界等待**它消失再抓，否则探查结果毫无意义
     * （L1-MR-7：等待一律带超时兜底，不得无界挂起）。
     */
    const initDeadline = Date.now() + 180000;
    let waited = 0;
    while (Date.now() < initDeadline) {
      const busy = await page.evaluate(() => document.body.innerText.includes('正在初始化')).catch(() => false);
      if (!busy) break;
      await page.waitForTimeout(3000);
      waited += 3;
    }
    if (waited) console.log(`[等待] 「正在初始化」持续约 ${waited}s 后结束`);

    const title = await page.title();
    console.log(`URL：${target}`);
    console.log(`标题：${title}\n`);

    // 收集所有可交互元素的可见文本（去重、限长），这是「有哪些入口」的最直接答案
    const items = await page.evaluate(() => {
      const seen = new Set();
      const out = [];
      const sel = 'button, a, [role="button"], [role="menuitem"], [role="tab"], input[type="button"], summary';
      for (const el of document.querySelectorAll(sel)) {
        const t = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ');
        if (!t || t.length > 40) continue;
        const key = `${el.tagName}|${t}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const r = el.getBoundingClientRect();
        out.push({ tag: el.tagName, text: t, id: el.id || '', cls: (el.className || '').toString().slice(0, 60), visible: r.width > 0 && r.height > 0 });
      }
      return out;
    });

    const visible = items.filter((x) => x.visible);
    console.log(`可交互元素：共 ${items.length}，可见 ${visible.length}\n`);
    console.log('=== 可见元素（按文本） ===');
    for (const it of visible.slice(0, 60)) {
      console.log(`  [${it.tag}] ${it.text}${it.id ? ` #${it.id}` : ''}`);
    }

    // 额外：页面上出现过、可能与「扩展 / 导入导出」相关的文本
    const kw = ['扩展', '插件', '导入', '导出', '设置', '备份', 'extension', 'import', 'export', 'backup', 'setting'];
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 20000));
    console.log('\n=== 含关键词的文本片段（前后 60 字符） ===');
    for (const k of kw) {
      const idx = bodyText.toLowerCase().indexOf(k.toLowerCase());
      if (idx >= 0) {
        console.log(`  「${k}」→ …${bodyText.slice(Math.max(0, idx - 30), idx + 60).replace(/\s+/g, ' ')}…`);
      }
    }

    const shot = path.join(outDir, `pt-ui-${stamp}.png`);
    await page.screenshot({ path: shot, fullPage: false });
    const json = path.join(outDir, `pt-ui-${stamp}.json`);
    fs.writeFileSync(json, JSON.stringify({ target, title, items, bodyTextSample: bodyText.slice(0, 5000) }, null, 2), 'utf8');
    console.log(`\n截图 → ${shot}`);
    console.log(`DOM 清单 → ${json}`);
  } finally {
    await ctx.close();
  }
})().catch((e) => {
  console.error('探查失败：', e && e.message ? e.message : e);
  process.exit(1);
});
