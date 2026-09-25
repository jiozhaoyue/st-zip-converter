/**
 * 阶段 B/C（v2）· 8004 Real Luker 性能对照采样 —— 修正版
 *
 * v1 缺陷修正：
 *   ① v1 的「关闭态」窗口覆盖了页面聊天加载期（DOM 15k→93k，出现 8142ms 长任务），两窗口不可比
 *      → 本版先等页面**真正静止**（连续 3s 无 longtask 且 DOM 规模稳定）再开始
 *   ② v1 展开时抽屉 contentHeight=0（外层 #rm_extensions_block 仍 closedDrawer）
 *      → 本版先展开外层扩展设置抽屉，再展开插件抽屉，并断言高度 > 0
 *
 * 自愈成本实验（C4 正确设计）：
 *   对照组甲：间隔 260ms 触发 10 次 body DOM 变动 → 触发 10 次 watchHostDom 回调
 *   对照组乙：间隔 260ms 触发 10 次 detached 节点变动 → 不触发 observer
 *   净成本 = 甲 − 乙
 *
 * 只读约束：不点任何业务按钮，不调用任何写端点。
 * 用法：node pw-bc2-live.cjs
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
const OUT = path.join(__dirname, 'bc2-live.json');

const METRIC_KEYS = [
  'TaskDuration',
  'ScriptDuration',
  'LayoutDuration',
  'RecalcStyleDuration',
  'LayoutCount',
  'RecalcStyleCount',
  'JSHeapUsedSize',
  'Nodes',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpMetrics(client) {
  const { metrics } = await client.send('Performance.getMetrics');
  const out = {};
  for (const m of metrics) if (METRIC_KEYS.includes(m.name)) out[m.name] = m.value;
  return out;
}

function diffMetrics(a, b) {
  const out = {};
  for (const k of METRIC_KEYS) {
    if (a[k] === undefined || b[k] === undefined) continue;
    out[k] = k === 'JSHeapUsedSize' || k === 'Nodes' ? Math.round(b[k]) : Number((b[k] - a[k]).toFixed(4));
  }
  return out;
}

async function installProbes(page) {
  await page.evaluate(() => {
    window.__diag = { longtasks: [], mutations: 0, batches: 0 };
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__diag.longtasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
        }
      }).observe({ entryTypes: ['longtask'] });
    } catch { /* ignore */ }
    try {
      window.__diagObserver = new MutationObserver((records) => {
        let n = 0;
        for (const r of records) n += r.addedNodes.length + r.removedNodes.length;
        window.__diag.mutations += n;
        window.__diag.batches += 1;
      });
      window.__diagObserver.observe(document.body, { childList: true, subtree: true });
    } catch { /* ignore */ }
  });
}

const resetProbes = (page) =>
  page.evaluate(() => {
    window.__diag.longtasks = [];
    window.__diag.mutations = 0;
    window.__diag.batches = 0;
  });

const readProbes = (page) =>
  page.evaluate(() => {
    const lt = window.__diag.longtasks;
    return {
      longtaskCount: lt.length,
      longtaskTotalMs: Math.round(lt.reduce((a, b) => a + b.dur, 0)),
      longtaskMaxMs: Math.round(lt.reduce((a, b) => Math.max(a, b.dur), 0)),
      longtaskSamples: lt.slice(0, 25),
      domMutations: window.__diag.mutations,
      domBatches: window.__diag.batches,
    };
  });

/** 等页面真正静止：连续 quietMs 无 longtask 且 DOM 规模稳定 */
async function waitStable(page, { quietMs = 3000, maxMs = 120_000, label = '' } = {}) {
  const t0 = Date.now();
  let lastNodes = -1;
  let lastChange = Date.now();
  let lastLtCount = 0;

  while (Date.now() - t0 < maxMs) {
    await sleep(500);
    const snap = await page.evaluate(() => ({
      nodes: document.getElementsByTagName('*').length,
      lt: (window.__diag && window.__diag.longtasks.length) || 0,
    }));
    if (snap.nodes !== lastNodes) {
      lastNodes = snap.nodes;
      lastChange = Date.now();
    }
    if (snap.lt !== lastLtCount) {
      lastLtCount = snap.lt;
      lastChange = Date.now();
    }
    if (Date.now() - lastChange >= quietMs) {
      console.log(`[稳定] ${label} 用 ${Math.round((Date.now() - t0) / 1000)}s 达到静止（DOM ${snap.nodes}）`);
      return { ok: true, waitedMs: Date.now() - t0, nodes: snap.nodes };
    }
  }
  console.log(`[稳定] ${label} 超时 ${maxMs}ms 仍未静止，按现状继续（DOM ${lastNodes}）`);
  return { ok: false, waitedMs: Date.now() - t0, nodes: lastNodes };
}

async function sample(page, client, ms, label) {
  await resetProbes(page);
  const m0 = await cdpMetrics(client);
  const t0 = Date.now();
  await sleep(ms);
  const m1 = await cdpMetrics(client);
  const probe = await readProbes(page);
  const wall = Date.now() - t0;
  console.log(`[采样] ${label} 完成 ${wall}ms`);
  return { label, wallMs: wall, probe, metrics: diffMetrics(m0, m1) };
}

/** 自愈成本实验：甲=body 变动（触发 observer） 乙=detached 变动（不触发） */
async function selfHealExperiment(page, client, { times = 10, gapMs = 260 } = {}) {
  async function run(kind) {
    const m0 = await cdpMetrics(client);
    await page.evaluate(
      ({ kind, times, gapMs }) => {
        return new Promise((resolve) => {
          const holder = document.createElement('div'); // detached 容器（不进 DOM）
          let i = 0;
          const timer = setInterval(() => {
            const n = document.createElement('span');
            n.textContent = '.';
            if (kind === 'body') {
              n.style.display = 'none';
              document.body.appendChild(n);
              setTimeout(() => n.remove(), 20);
            } else {
              // detached：只动内存树，不进文档 → 不触发 MutationObserver
              holder.appendChild(n);
            }
            i += 1;
            if (i >= times) {
              clearInterval(timer);
              setTimeout(resolve, 600);
            }
          }, gapMs);
        });
      },
      { kind, times, gapMs }
    );
    const m1 = await cdpMetrics(client);
    return diffMetrics(m0, m1);
  }

  const bodySide = await run('body');
  await sleep(800);
  const detachedSide = await run('detached');
  return {
    times,
    gapMs,
    bodyMutations: bodySide,
    detachedMutations: detachedSide,
    netScriptS: Number((bodySide.ScriptDuration - detachedSide.ScriptDuration).toFixed(4)),
    netTaskS: Number((bodySide.TaskDuration - detachedSide.TaskDuration).toFixed(4)),
    netRecalcStyleS: Number((bodySide.RecalcStyleDuration - detachedSide.RecalcStyleDuration).toFixed(4)),
    note: '净值 = body 变动组 − detached 变动组；netScriptS/1000/times ≈ 单次自愈回调脚本成本(ms)',
  };
}

async function main() {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 950 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const client = await ctx.newCDPSession(page);
  await client.send('Performance.enable');

  console.log('[0] 打开', BASE);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(
    () => document.querySelector('#extensions_settings2, #extensions_settings, #send_form'),
    { timeout: 60_000 }
  ).catch(() => console.log('[0] 宿主锚点未出现，继续'));
  await page.waitForTimeout(6_000);
  await installProbes(page);

  // 等真正静止
  const stable = await waitStable(page, { label: '首屏', quietMs: 3000, maxMs: 120_000 });

  const pageFacts = await page.evaluate(() => {
    const app = document.querySelector('.st-converter-drawer-app');
    return {
      domNodes: document.getElementsByTagName('*').length,
      chatMessages: document.querySelectorAll('#chat .mes').length,
      pluginNodes: app ? app.getElementsByTagName('*').length : 0,
      pluginButtons: app ? app.querySelectorAll('button').length : 0,
      pluginInputs: app ? app.querySelectorAll('input,select,textarea').length : 0,
      pluginDetails: app ? app.querySelectorAll('details').length : 0,
      pluginLabels: app ? app.querySelectorAll('label').length : 0,
      outerDrawerOpen: (() => {
        const el = document.getElementById('rm_extensions_block');
        return el ? !el.classList.contains('closedDrawer') : null;
      })(),
    };
  });

  // ── 阶段 B：关闭态（插件 UI 未显示） ──
  const b0 = await page.evaluate(() => {
    const c = document.querySelector('#st_zip_converter_settings > .inline-drawer-content');
    return c ? getComputedStyle(c).display : null;
  });
  console.log('[B] 插件抽屉当前 display =', b0);
  const closedState = await sample(page, client, 12_000, '关闭态 12s');

  // ── 打开外层扩展设置抽屉，再展开插件抽屉 ──
  const outerOpen = await page.evaluate(() => {
    const btn = document.getElementById('extensions-settings-button');
    const block = document.getElementById('rm_extensions_block');
    if (block && block.classList.contains('closedDrawer')) {
      if (btn) {
        btn.click();
        return 'clicked-ext-button';
      }
      block.classList.remove('closedDrawer');
      return 'removed-closedDrawer';
    }
    return 'already-open';
  });
  console.log('[C] 外层扩展抽屉:', outerOpen);
  await sleep(1200);

  const pluginOpen = await page.evaluate(() => {
    const d = document.getElementById('st_zip_converter_settings');
    if (!d) return 'no-drawer';
    const content = d.querySelector(':scope > .inline-drawer-content');
    if (content && getComputedStyle(content).display === 'none') {
      const t = d.querySelector(':scope > .inline-drawer-toggle');
      if (t) {
        t.click();
        content.style.display = 'block';
        return 'clicked-toggle';
      }
    }
    return content ? 'already-' + getComputedStyle(content).display : 'unknown';
  });
  console.log('[C] 插件抽屉:', pluginOpen);
  await sleep(2500);

  const openFacts = await page.evaluate(() => {
    const app = document.querySelector('.st-converter-drawer-app');
    const content = document.querySelector('#st_zip_converter_settings > .inline-drawer-content');
    return {
      contentDisplay: content ? getComputedStyle(content).display : null,
      contentHeight: content ? Math.round(content.getBoundingClientRect().height) : null,
      appHeight: app ? Math.round(app.getBoundingClientRect().height) : null,
      appWidth: app ? Math.round(app.getBoundingClientRect().width) : null,
      visibleButtons: app
        ? Array.from(app.querySelectorAll('button')).filter((b) => b.getBoundingClientRect().height > 0).length
        : 0,
    };
  });
  console.log('[C] 展开后尺寸:', JSON.stringify(openFacts));

  const openState = await sample(page, client, 12_000, '展开态 12s');

  // ── 阶段 C4：自愈成本 ──
  console.log('[C4] 自愈成本实验…');
  const selfHeal = await selfHealExperiment(page, client, { times: 10, gapMs: 260 });
  console.log('[C4] 完成');

  const result = {
    sampledAt: new Date().toISOString(),
    url: BASE,
    stable,
    pageFacts,
    openFacts,
    closedState,
    openState,
    selfHeal,
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');

  console.log('\n===== v2 对照结果 =====');
  console.log('[页面事实]', JSON.stringify(pageFacts));
  console.log('[展开后]', JSON.stringify(openFacts));
  for (const s of [closedState, openState]) {
    const m = s.metrics;
    console.log(
      `\n[${s.label}] ${s.wallMs}ms | longtask ${s.probe.longtaskCount} 个 / 共 ${s.probe.longtaskTotalMs}ms / 最长 ${s.probe.longtaskMaxMs}ms`
    );
    console.log(`  script ${m.ScriptDuration}s | task ${m.TaskDuration}s | recalcStyle ${m.RecalcStyleDuration}s | layout ${m.LayoutDuration}s`);
    console.log(`  recalcStyleCount ${m.RecalcStyleCount} | layoutCount ${m.LayoutCount} | 堆 ${Math.round((m.JSHeapUsedSize || 0) / 1048576)}MB`);
    console.log(`  宿主 DOM 变动 ${s.probe.domMutations} 次 / ${s.probe.domBatches} 批 → 自愈回调最多触发 ${s.probe.domBatches} 次`);
  }
  const perCall = selfHeal.netScriptS > 0 ? ((selfHeal.netScriptS * 1000) / selfHeal.times).toFixed(2) : 'n/a';
  console.log(`\n[自愈成本] body组 script ${selfHeal.bodyMutations.ScriptDuration}s vs detached组 ${selfHeal.detachedMutations.ScriptDuration}s`);
  console.log(`  净值 script ${selfHeal.netScriptS}s / ${selfHeal.times} 次 ≈ ${perCall} ms/次；task 净值 ${selfHeal.netTaskS}s`);
  console.log('\n落盘:', OUT);

  await ctx.close();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
