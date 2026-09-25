/**
 * 阶段 B/C · 8004 Real Luker 性能对照采样（只读）
 *
 * 对照设计：
 *   B 关闭态（插件抽屉未展开）→ 空闲 12s 采样
 *   C 展开态（插件抽屉展开）  → 稳定后 12s 采样
 * 额外：
 *   B3 观测宿主 DOM 变动频次（第三方扩展/宿主自身渲染），用于归因隔离
 *   C4 人为触发 1 次 DOM 变动 → 测插件 watchHostDom 自愈回调的隐藏成本
 *
 * 只读约束：不点击任何业务按钮（转换/恢复/导出/删除），不调用任何写端点。
 *           唯一交互是展开插件自己的设置抽屉（等价于用户点开设置）。
 *
 * 用法：node pw-bc-live.cjs
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
const OUT = path.join(__dirname, 'bc-live.json');

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

async function installProbes(page) {
  await page.evaluate(() => {
    window.__diag = { longtasks: [], mutations: 0, mutationBatches: 0 };

    // LongTask 采样
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__diag.longtasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
        }
      }).observe({ entryTypes: ['longtask'] });
    } catch {
      /* 不支持则留空 */
    }

    // 宿主 DOM 变动频次（childList 变更次数，代表「谁在动 DOM」）
    try {
      window.__diagObserver = new MutationObserver((records) => {
        let n = 0;
        for (const r of records) n += r.addedNodes.length + r.removedNodes.length;
        window.__diag.mutations += n;
        window.__diag.mutationBatches += 1;
      });
      window.__diagObserver.observe(document.body, { childList: true, subtree: true });
    } catch {
      /* ignore */
    }
  });
}

async function resetProbes(page) {
  await page.evaluate(() => {
    window.__diag.longtasks = [];
    window.__diag.mutations = 0;
    window.__diag.mutationBatches = 0;
  });
}

async function readProbes(page) {
  return page.evaluate(() => {
    const lt = window.__diag.longtasks;
    const total = lt.reduce((a, b) => a + b.dur, 0);
    const max = lt.reduce((a, b) => Math.max(a, b.dur), 0);
    return {
      longtaskCount: lt.length,
      longtaskTotalMs: Math.round(total),
      longtaskMaxMs: Math.round(max),
      longtaskSamples: lt.slice(0, 20),
      domMutations: window.__diag.mutations,
      domMutationBatches: window.__diag.mutationBatches,
    };
  });
}

async function cdpMetrics(client) {
  const { metrics } = await client.send('Performance.getMetrics');
  const out = {};
  for (const m of metrics) {
    if (METRIC_KEYS.includes(m.name)) out[m.name] = m.value;
  }
  return out;
}

function diffMetrics(before, after) {
  const out = {};
  for (const k of METRIC_KEYS) {
    const a = before[k];
    const b = after[k];
    if (a === undefined || b === undefined) continue;
    out[k] = k === 'JSHeapUsedSize' || k === 'Nodes' ? Math.round(b) : Number((b - a).toFixed(4));
  }
  return out;
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
  await page.waitForTimeout(12_000);

  // ── 阶段 0：inline 样式表身份识别（58 条插件规则来源） ──
  const styleIdentity = await page.evaluate(() => {
    const res = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      if (!rules) continue;
      const mine = [];
      for (const r of Array.from(rules)) {
        const t = r.cssText || '';
        if (t.includes('.st-converter-drawer-app') || t.includes('.app-container')) mine.push(t);
      }
      if (!mine.length) continue;
      res.push({
        href: sheet.href || '(inline)',
        ownerTag: sheet.ownerNode ? sheet.ownerNode.tagName : null,
        ownerId: sheet.ownerNode ? sheet.ownerNode.id : null,
        ownerInPluginDir: sheet.ownerNode && sheet.ownerNode.href
          ? String(sheet.ownerNode.href).includes('st-zip-converter')
          : false,
        totalRules: rules.length,
        pluginRules: mine.length,
        firstRule: mine[0] ? mine[0].slice(0, 160) : null,
        lastRule: mine[mine.length - 1] ? mine[mine.length - 1].slice(0, 160) : null,
      });
    }
    return res;
  });

  // ── 阶段 B：关闭态 ──
  await installProbes(page);
  await resetProbes(page);
  const bMeta0 = await cdpMetrics(client);
  const bT0 = Date.now();
  await page.waitForTimeout(12_000);
  const bMeta1 = await cdpMetrics(client);
  const bProbe = await readProbes(page);
  const bWall = Date.now() - bT0;
  console.log('[B] 关闭态采样完成');

  // 展开前的抽屉状态
  const drawerStateBefore = await page.evaluate(() => {
    const d = document.querySelector('#st_zip_converter_settings');
    const content = d ? d.querySelector('.inline-drawer-content') : null;
    return {
      found: !!d,
      hasToggle: !!(d && d.querySelector('.inline-drawer-toggle')),
      contentDisplay: content ? getComputedStyle(content).display : null,
      contentHeight: content ? content.getBoundingClientRect().height : null,
    };
  });

  // ── 阶段 C：展开插件抽屉（等价用户点开设置，非业务写操作） ──
  const opened = await page.evaluate(() => {
    const d = document.querySelector('#st_zip_converter_settings');
    if (!d) return 'no-drawer';
    const t = d.querySelector('.inline-drawer-toggle');
    if (!t) return 'no-toggle';
    t.click();
    return 'clicked';
  });
  console.log('[C] 展开抽屉:', opened);
  await page.waitForTimeout(4_000);

  const drawerStateAfter = await page.evaluate(() => {
    const d = document.querySelector('#st_zip_converter_settings');
    const content = d ? d.querySelector('.inline-drawer-content') : null;
    const app = document.querySelector('.st-converter-drawer-app');
    return {
      contentDisplay: content ? getComputedStyle(content).display : null,
      contentHeight: content ? Math.round(content.getBoundingClientRect().height) : null,
      appHeight: app ? Math.round(app.getBoundingClientRect().height) : null,
      appNodeCount: app ? app.getElementsByTagName('*').length : 0,
      appHeavyNodes: app
        ? {
            buttons: app.querySelectorAll('button').length,
            inputs: app.querySelectorAll('input,select').length,
            details: app.querySelectorAll('details').length,
            labels: app.querySelectorAll('label').length,
          }
        : null,
    };
  });

  await resetProbes(page);
  const cMeta0 = await cdpMetrics(client);
  const cT0 = Date.now();
  await page.waitForTimeout(12_000);
  const cMeta1 = await cdpMetrics(client);
  const cProbe = await readProbes(page);
  const cWall = Date.now() - cT0;
  console.log('[C] 展开态采样完成');

  // ── 阶段 C4：宿主 DOM 变动 → 插件自愈回调成本 ──
  const injectCost = await (async () => {
    const t0 = await cdpMetrics(client);
    const lt0 = await readProbes(page);
    // 人为插入并移除 1 个无害节点，触发 watchHostDom 的 MutationObserver
    await page.evaluate(() => {
      const s = document.createElement('span');
      s.id = 'diag-probe-node';
      s.textContent = '.';
      s.style.display = 'none';
      document.body.appendChild(s);
      setTimeout(() => s.remove(), 30);
    });
    // 等过去抖 200ms + 自愈执行
    await page.waitForTimeout(1_500);
    const t1 = await cdpMetrics(client);
    const lt1 = await readProbes(page);
    const d = diffMetrics(t0, t1);
    return {
      scriptDurationDelta: d.ScriptDuration,
      taskDurationDelta: d.TaskDuration,
      recalcStyleDelta: d.RecalcStyleDuration,
      layoutDelta: d.LayoutDuration,
      newLongtasks: Math.max(0, lt1.longtaskCount - lt0.longtaskCount),
    };
  })();
  console.log('[C4] 自愈回调成本采样完成');

  // ── 汇总 ──
  const result = {
    sampledAt: new Date().toISOString(),
    url: BASE,
    styleIdentity,
    closedState: {
      wallMs: bWall,
      probe: bProbe,
      metrics: diffMetrics(bMeta0, bMeta1),
      drawer: drawerStateBefore,
    },
    openState: {
      wallMs: cWall,
      probe: cProbe,
      metrics: diffMetrics(cMeta0, cMeta1),
      drawer: drawerStateAfter,
    },
    injectSelfHealCost: injectCost,
  };

  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');

  console.log('\n===== 对照结果 =====');
  console.log('[样式身份]', JSON.stringify(styleIdentity, null, 1));
  for (const [label, s] of [['关闭态', result.closedState], ['展开态', result.openState]]) {
    const m = s.metrics;
    console.log(
      `\n[${label}] ${s.wallMs}ms | longtask ${s.probe.longtaskCount} 个 / 共 ${s.probe.longtaskTotalMs}ms / 最长 ${s.probe.longtaskMaxMs}ms`
    );
    console.log(
      `  CPU: script ${m.ScriptDuration}s | task ${m.TaskDuration}s | recalcStyle ${m.RecalcStyleDuration}s | layout ${m.LayoutDuration}s`
    );
    console.log(
      `  计数: layout ${m.LayoutCount} | recalcStyle ${m.RecalcStyleCount} | 堆 ${Math.round((m.JSHeapUsedSize || 0) / 1048576)}MB | DOM ${Math.round(m.Nodes)}`
    );
    console.log(`  宿主 DOM 变动: ${s.probe.domMutations} 次 / ${s.probe.domMutationBatches} 批`);
    console.log(`  抽屉: ${JSON.stringify(s.drawer)}`);
  }
  console.log('\n[自愈回调成本 单次 DOM 变动]', JSON.stringify(injectCost));
  console.log('\n落盘:', OUT);

  await ctx.close();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
