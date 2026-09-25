/**
 * DOM 侵入对照审计（Dev Luker 8003 / Real Luker 8004，只读）
 *
 * 目标（用户 2026-09-25 指派）：**断言「本插件是否会让别的元素变得不一样」**，不留猜测。
 *
 * 方法（两路证据，互补）：
 *
 *   路 1 · 对照 diff（回答「哪些节点不一样」）
 *     · `--mode=off`：`page.route` 拦掉所有 URL 含 `zip-converter` 的资源（JS/CSS 都不加载），
 *       宿主以「无本插件」状态渲染 → 取 DOM 指纹；
 *     · `--mode=on` ：正常加载 → 取同一指纹；
 *     · 指纹 = 对 `document.body` 全树做前序遍历，每节点记 `路径|tag#id.class|style 属性`。
 *       把两份指纹按**路径**对齐：只在一侧出现的 = 新增/消失，两侧都有但签名不同 = 被改动。
 *     · 噪声控制：宿主自身有动态内容（聊天渲染、计时器）。故对「有差异」的路径再做一次
 *       `off/off`（同模式两跑）得到**基线抖动集**，凡落在抖动集内的差异一律不作为证据。
 *
 *   路 2 · CSS 命中域断言（回答「样式是否越界」，确定性、零噪声）
 *     · 浏览器已把 `style.css` 解析好：遍历 `document.styleSheets` 找到插件那张表，
 *       逐条规则的 `selectorText` 做 `querySelectorAll`，统计
 *       「总命中」与「命中在插件容器之外的」→ 后者非 0 即越界，逐条列出。
 *
 *   路 3 · 本插件产物的完整清单（回答「插件到底往宿主里放了什么」）
 *     · 枚举所有 id 以 `st-zip-converter` 开头、class 含 `st-converter`、或带
 *       `data-st-zip-injected` 的节点，连同其父链与在宿主中的位置，全部列出。
 *
 * 只读：不写实例、不改插件文件。`--mode=off` 只影响本次浏览器请求（route abort），
 * 不对实例做任何持久化改动。
 *
 * 用法：
 *   node pw-dom-intrusion-audit.cjs --mode=off     [DEV_URL=...]
 *   node pw-dom-intrusion-audit.cjs --mode=on
 *   node pw-dom-intrusion-audit.cjs --diff         # 对齐两份结果并出结论
 */
const path = require('path');
const fs = require('fs');

function loadPlaywright() {
  try { return require('playwright'); } catch {
    const g = require('child_process').execSync('npm root -g').toString().trim();
    return require(path.join(g, 'playwright'));
  }
}

const { chromium } = loadPlaywright();
const BASE = process.env.DEV_URL || 'https://127.0.0.1:8003';
const PORT_TAG = (BASE.match(/:(\d+)/) || [, 'unknown'])[1];
const PROFILE = path.resolve(__dirname, '../../../../.pw-profile-dev');
const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.split('=')[1] : d; };
const MODE = arg('mode', 'on');

/** 页面侧：DOM 指纹 + CSS 命中域 + 插件产物清单（同一函数，保证两模式口径完全一致） */
function fingerprint() {
  const PLUGIN_SELECTOR = '#app.st-converter-drawer-app, .st-converter-drawer-app, [id^="st-zip-converter"], [data-st-zip-injected="1"], .st-converter-drawer-wrapper';
  const inPlugin = (el) => {
    try { return !!(el.closest && el.closest(PLUGIN_SELECTOR)); } catch { return false; }
  };
  const pathOf = (el) => {
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && parts.length < 20) {
      const parent = cur.parentElement;
      if (!parent) break;
      parts.unshift(`${Array.prototype.indexOf.call(parent.children, cur)}:${cur.tagName.toLowerCase()}`);
      cur = parent;
    }
    return 'body>' + parts.join('>');
  };
  const sigOf = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = el.classList && el.classList.length ? `.${Array.from(el.classList).join('.')}` : '';
    const st = el.getAttribute('style') || '';
    return `${el.tagName.toLowerCase()}${id}${cls}|${st.slice(0, 200)}`;
  };

  // ---- 路 1：DOM 指纹（前序，按路径索引）+ 宿主自有节点的签名集合 ----
  const dom = {};
  const hostSigs = [];   // 只收「不在本插件容器内」的节点签名（多重集）
  let count = 0;
  let pluginOwnedCount = 0;
  const walk = (el) => {
    if (count > 40000) return;
    count += 1;
    const owned = inPlugin(el);
    if (owned) pluginOwnedCount += 1;
    const sig = sigOf(el);
    dom[pathOf(el)] = sig;
    if (!owned) hostSigs.push(sig);
    for (const c of el.children) walk(c);
  };
  for (const c of document.body.children) walk(c);

  // ---- 路 2：插件样式表的命中域 ----
  const css = { stylesheetHrefs: [], violations: [], totalRules: 0, totalMatches: 0 };
  for (const sheet of Array.from(document.styleSheets)) {
    let href = '';
    try { href = sheet.href || ''; } catch { /* 跨源 */ }
    if (href && /zip-converter/i.test(href)) css.stylesheetHrefs.push(href);
    if (!href || !/zip-converter/i.test(href)) continue;
    let rules;
    try { rules = Array.from(sheet.cssRules); } catch { continue; }
    const visit = (list) => {
      for (const r of list) {
        // 注意：现代 Chrome 里普通 CSSStyleRule 也带一个**空但 truthy** 的 `cssRules`
        // （CSS 嵌套支持）。先看 `selectorText`，再看 `cssRules.length`，否则每条规则
        // 都会被当成嵌套组递归进空表 → 统计恒为 0（本次首轮就踩了这个坑）。
        if (r.selectorText) {
          css.totalRules += 1;
          for (const branch of r.selectorText.split(',')) {
            const sel = branch.trim();
            if (!sel) continue;
            let hits;
            try { hits = document.querySelectorAll(sel); } catch { continue; }
            css.totalMatches += hits.length;
            const outside = Array.from(hits).filter((el) => !inPlugin(el));
            if (outside.length) {
              css.violations.push({
                selector: sel.slice(0, 200),
                outsideCount: outside.length,
                totalCount: hits.length,
                sample: outside.slice(0, 3).map((el) => ({ path: pathOf(el), sig: sigOf(el).slice(0, 120) })),
              });
            }
          }
        }
        if (r.cssRules && r.cssRules.length) visit(Array.from(r.cssRules)); // @media / @supports / 嵌套
      }
    };
    visit(rules);
  }

  // ---- 路 3：插件产物清单 ----
  const artifacts = Array.from(document.querySelectorAll('[id^="st-zip-converter"], [data-st-zip-injected="1"], .st-converter-drawer-wrapper, #app.st-converter-drawer-app'))
    .map((el) => ({
      path: pathOf(el),
      sig: sigOf(el).slice(0, 160),
      parentChain: (() => {
        const chain = [];
        let cur = el.parentElement;
        while (cur && cur !== document.body && chain.length < 4) { chain.push(sigOf(cur).slice(0, 80)); cur = cur.parentElement; }
        return chain;
      })(),
      childCount: el.children.length,
    }));

  return {
    dom,
    hostSigs,
    pluginOwnedCount,
    domCount: count,
    css,
    artifacts,
    pluginLoaded: !!document.querySelector(PLUGIN_SELECTOR),
    bodySig: sigOf(document.body),
    htmlSig: sigOf(document.documentElement),
  };
}

async function run() {
  const ctx = await chromium.launchPersistentContext(PROFILE, { ignoreHTTPSErrors: true, viewport: { width: 1600, height: 950 } });
  const blocked = [];
  const pluginRequests = [];
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    page.on('request', (r) => { if (/zip-converter/i.test(r.url())) pluginRequests.push(r.url().slice(0, 200)); });
    if (MODE === 'off') {
      await page.route('**/*', (route) => {
        const u = route.request().url();
        if (/zip-converter/i.test(u)) { blocked.push(u.slice(0, 200)); return route.abort(); }
        return route.continue();
      });
    }
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(20000);
    const fp = await page.evaluate(fingerprint);
    const out = {
      sampledAt: new Date().toISOString(), url: BASE, mode: MODE,
      blockedCount: blocked.length, blockedSample: blocked.slice(0, 10),
      pluginRequests: Array.from(new Set(pluginRequests)).slice(0, 20),
      fingerprint: fp,
    };
    // `--tag=` 可覆盖落盘后缀：用于同模式第二跑（`--mode=off --tag=off2`）求宿主抖动基线
    const tag = arg('tag', MODE);
    const file = path.join(__dirname, `dom-audit-${PORT_TAG}-${tag}.json`);
    fs.writeFileSync(file, JSON.stringify(out), 'utf8');
    console.log(JSON.stringify({
      file, mode: MODE, blocked: blocked.length,
      pluginLoaded: fp.pluginLoaded, domCount: fp.domCount,
      cssRules: fp.css.totalRules, cssViolations: fp.css.violations.length,
      artifacts: fp.artifacts.length,
      bodySig: fp.bodySig, htmlSig: fp.htmlSig,
    }, null, 1));
  } finally { await ctx.close(); }
}

/**
 * 按 **签名多重集** 比对（而非按位置路径）。
 *
 * 为什么不能按路径：插件往 `#extensions_settings2` 插一个面板，其后所有兄弟节点的
 * **子序号整体后移**，按路径 diff 会把几十个无关节点误报成「被改动」——首轮就是这样
 * （见 `changedBetween` 里 `menu-cleaner-settings` / `timelines_container` 等成对换位）。
 *
 * 签名多重集的口径：把每侧指纹的**值**（`tag#id.class|style`）做成计数表。
 *   · 只在 on 侧多出来的签名 = 新增（期望：恰好是插件自己的产物 + 宿主抖动）
 *   · 只在 off 侧多出来的签名 = 消失／被改（期望：空，或全部落在宿主抖动集内）
 * 若某元素被改了 class/style，它的旧签名会从表里少一次、新签名多一次 → 能抓到。
 *
 * 宿主抖动基线：若存在同模式的第二跑（`-off2`），先算 off↔off2 的差集当噪声，
 * 再从 on↔off 的差集里剔除噪声，剩下的才是**插件造成的差异**。
 */
function multiset(list) {
  const m = new Map();
  for (const s of list) m.set(s, (m.get(s) || 0) + 1);
  return m;
}
function subtract(a, b) {
  const out = new Map(a);
  for (const [k, v] of b) {
    if (!out.has(k)) continue;
    const left = out.get(k) - v;
    if (left > 0) out.set(k, left); else out.delete(k);
  }
  return out;
}
const readFp = (tag) => {
  const p = path.join(__dirname, `dom-audit-${PORT_TAG}-${tag}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).fingerprint : null;
};

/** 对齐两份指纹：按 **宿主自有节点** 的签名多重集给出「新增 / 消失」；噪声基线存在则一并剔除 */
function diff() {
  const off = readFp('off'), on = readFp('on');
  if (!off || !on) throw new Error('缺少 off/on 指纹，先跑 --mode=off 与 --mode=on');

  const onExtra = subtract(multiset(on.hostSigs), multiset(off.hostSigs));   // 插件开着时多的宿主节点
  const offExtra = subtract(multiset(off.hostSigs), multiset(on.hostSigs));  // 插件开着时少的宿主节点

  // 宿主抖动基线（同模式第二跑）：同一份页面跑两遍也会有的差异，不能算插件头上
  const off2 = readFp('off2');
  let noise = null;
  if (off2) {
    noise = {
      extraSet: new Set(subtract(multiset(off2.hostSigs), multiset(off.hostSigs)).keys()),
      missingSet: new Set(subtract(multiset(off.hostSigs), multiset(off2.hostSigs)).keys()),
    };
    noise.extraCount = noise.extraSet.size;
    noise.missingCount = noise.missingSet.size;
  }
  const drop = (map, set) => new Map(Array.from(map).filter(([k]) => !(set && set.has(k))));

  const onExtraClean = drop(onExtra, noise && noise.extraSet);
  const offExtraClean = drop(offExtra, noise && noise.missingSet);

  const result = {
    url: BASE, mode: 'diff',
    // 闸门读数：对照组是否真的没加载插件、实验组是否真的加载了
    gate: {
      pluginLoaded_off: off.pluginLoaded, pluginLoaded_on: on.pluginLoaded,
      cssRules_off: off.css.totalRules, cssRules_on: on.css.totalRules,
      artifacts_off: off.artifacts.length, artifacts_on: on.artifacts.length,
      pluginOwnedNodes_on: on.pluginOwnedCount,
    },
    domCount: { off: off.domCount, on: on.domCount, off2: off2 ? off2.domCount : null },
    hostNodeCount: { off: off.hostSigs.length, on: on.hostSigs.length, off2: off2 ? off2.hostSigs.length : null },
    cssRules: on.css.totalRules,
    cssViolations: on.css.violations,
    artifacts: on.artifacts,
    bodyUnchanged: off.bodySig === on.bodySig,
    bodySig: on.bodySig,
    htmlUnchanged: off.htmlSig === on.htmlSig,
    htmlSig: on.htmlSig.slice(0, 300),
    noiseBaselinePresent: !!noise,
    noiseExtraCount: noise ? noise.extraCount : 0,
    noiseMissingCount: noise ? noise.missingCount : 0,
    rawHostAdded: Array.from(onExtra.entries()).map(([sig, n]) => ({ sig: sig.slice(0, 200), n })).sort((a, b) => b.n - a.n),
    rawHostRemoved: Array.from(offExtra.entries()).map(([sig, n]) => ({ sig: sig.slice(0, 200), n })).sort((a, b) => b.n - a.n),
    // 剔除宿主抖动后仍存在的差异 —— 这些才是「插件让别的元素不一样」的候选
    hostAddedNotNoise: Array.from(onExtraClean.entries()).map(([sig, n]) => ({ sig: sig.slice(0, 200), n })).sort((a, b) => b.n - a.n),
    hostRemovedNotNoise: Array.from(offExtraClean.entries()).map(([sig, n]) => ({ sig: sig.slice(0, 200), n })).sort((a, b) => b.n - a.n),
  };
  const file = path.join(__dirname, `dom-audit-${PORT_TAG}-diff.json`);
  fs.writeFileSync(file, JSON.stringify(result), 'utf8');
  console.log(JSON.stringify({
    file,
    gate: result.gate,
    hostNodeCount: result.hostNodeCount,
    cssRules: result.cssRules, cssViolations: result.cssViolations.length,
    bodyUnchanged: result.bodyUnchanged, htmlUnchanged: result.htmlUnchanged,
    noiseBaseline: result.noiseBaselinePresent, noiseExtra: result.noiseExtraCount, noiseMissing: result.noiseMissingCount,
    rawHostAdded: result.rawHostAdded.length, rawHostRemoved: result.rawHostRemoved.length,
    hostAddedNotNoise: result.hostAddedNotNoise.length,
    hostRemovedNotNoise: result.hostRemovedNotNoise.length,
    hostAddedSample: result.hostAddedNotNoise.slice(0, 15),
    hostRemovedSample: result.hostRemovedNotNoise.slice(0, 15),
    violationSample: result.cssViolations.slice(0, 5),
  }, null, 1));
}

if (process.argv.includes('--diff')) diff(); else run();
