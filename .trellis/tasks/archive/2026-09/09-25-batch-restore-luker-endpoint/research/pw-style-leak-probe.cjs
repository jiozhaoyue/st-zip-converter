/**
 * 样式污染实测探针（Dev Luker 8003 认证态）
 *
 * 目标：把用户报告的「插件强行改变酒馆原生弹窗/其它样式」从**断言**变成**证据**，并定位来源。
 * 三项检查（全部只读，不点任何执行类按钮）：
 *   ① 插件样式表内是否存在**未带双前缀**的规则（即潜在泄漏规则）；
 *   ② 这些规则是否真的**命中宿主元素**（落在插件容器之外）；
 *   ③ 插件是否把**内联样式写在宿主元素**上——按其调色板特征色（#cdd6f4/#a6e3a1/#f9e2af/#6c7086/#11111b…）
 *      扫描插件容器之外的元素的 style 属性。
 *
 * 用法：node pw-style-leak-probe.cjs
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
const BASE = process.env.DEV_URL || 'https://127.0.0.1:8003';
const PROFILE = path.resolve(__dirname, '../../../../.pw-profile-dev');
const OUT = path.join(__dirname, 'style-leak.json');

const PROBE = () => {
  const PREFIXES = ['.app-container', '.st-converter-drawer-app'];
  const OUR_COLORS = ['cdd6f4', 'a6e3a1', 'f9e2af', '6c7086', '11111b', '7f849c', '89b4fa', 'f38ba8'];
  const APP_ROOTS = ['.app-container', '.st-converter-drawer-app', '#st_zip_converter_settings'];

  const insideOurRoots = (el) => APP_ROOTS.some((sel) => el.closest(sel));

  const out = { ourSheets: [], bareRules: [], bareRulesMatchingHost: [], inlineOnHost: [] };

  // ① 收集样式表：靠 href 与规则内容识别本插件的表
  const sheets = [];
  for (const sheet of Array.from(document.styleSheets)) {
    const owner = sheet.ownerNode;
    const href = owner?.href || '';
    const id = owner?.id || owner?.getAttribute?.('data-id') || '';
    let rules = null;
    try { rules = sheet.cssRules; } catch { /* 跨源表：跳过 */ }
    if (!rules) continue;
    const text = Array.from(rules).slice(0, 4000).map((r) => r.selectorText || r.cssText || '').join('\n');
    const isOurs = /st-zip-converter|st-converter|app-container/.test(href + ' ' + id)
      || PREFIXES.some((p) => text.includes(p));
    sheets.push({ href, id, isOurs, ruleCount: rules.length });
    if (!isOurs) continue;

    const walk = (list) => {
      for (const rule of Array.from(list)) {
        if (rule.cssRules) { walk(rule.cssRules); continue; }
        const sel = rule.selectorText;
        if (!sel) continue;
        const hasPrefix = PREFIXES.some((p) => sel.includes(p));
        if (!hasPrefix) out.bareRules.push(sel);
      }
    };
    walk(rules);
    out.ourSheets.push({ href, id, ruleCount: rules.length });
  }

  // ② 裸规则是否命中宿主元素
  for (const sel of out.bareRules) {
    try {
      const matched = Array.from(document.querySelectorAll(sel));
      const onHost = matched.filter((el) => !insideOurRoots(el));
      if (onHost.length > 0) {
        out.bareRulesMatchingHost.push({
          selector: sel,
          hostMatches: onHost.length,
          sample: onHost.slice(0, 4).map((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''}`),
        });
      }
    } catch { /* 无效选择器（如 :hover 组合）：忽略 */ }
  }

  // ③ 宿主元素上的内联样式（按本插件调色板特征色识别）
  const all = Array.from(document.querySelectorAll('[style]'));
  for (const el of all) {
    if (insideOurRoots(el)) continue;
    const s = el.getAttribute('style') || '';
    const hexes = s.match(/#[0-9a-fA-F]{3,8}/g) || [];
    const rgb = s.match(/rgba?\([^)]+\)/g) || [];
    const hit = OUR_COLORS.some((c) => hexes.some((h) => h.toLowerCase().includes(c)))
      || OUR_COLORS.some((c) => rgb.some((r) => r.includes(String(parseInt(c.slice(0, 2), 16)))));
    if (hit) {
      out.inlineOnHost.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        cls: typeof el.className === 'string' ? el.className.slice(0, 60) : null,
        style: s.slice(0, 200),
      });
    }
  }

  // 附：宿主原生弹窗元素是否在场（用于后续人工核对）
  out.hostPopupsPresent = Array.from(document.querySelectorAll('.popup, .dialogue_popup, dialog'))
    .slice(0, 5)
    .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).slice(0, 3).join('.')}`);

  return out;
};

async function main() {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 950 },
  });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(3500); // 等插件初始化完成（含 MutationObserver 注入）
    const result = await page.evaluate(PROBE);
    fs.writeFileSync(OUT, JSON.stringify({ sampledAt: new Date().toISOString(), base: BASE, result }, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 1).slice(0, 3500));
  } finally {
    await ctx.close();
  }
}

main().catch((e) => { console.error('探针失败:', e); process.exit(1); });
