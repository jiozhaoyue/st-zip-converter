/**
 * 阶段 F · 插件初始化期开销 + 面板打开一次性成本（只读）
 *
 * 目的：
 *   F1 页面从导航到稳定全程 CPU Profile → 插件初始化（模块加载/工作台 DOM 构建/
 *      IndexedDB 打开/配额查询）占启动期主线程的多少
 *   F2 打开扩展设置面板（使插件 1237px UI 参与布局）的一次性 layout/recalcStyle 成本
 *
 * 只读约束：仅导航、读指标、展开面板视图；不点业务按钮；不调写端点。
 * 用法：node pw-f1-startup.cjs
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
const OUT = path.join(__dirname, 'f1-startup.json');

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
  const o = {};
  for (const k of METRIC_KEYS) {
    if (a[k] === undefined || b[k] === undefined) continue;
    o[k] = k === 'JSHeapUsedSize' || k === 'Nodes' ? Math.round(b[k]) : Number((b[k] - a[k]).toFixed(4));
  }
  return o;
}

function analyzeProfile(profile, windowMs, usPerSample) {
  const byId = new Map();
  for (const n of profile.nodes) byId.set(n.id, n);
  const self = new Map();
  for (const s of profile.samples || []) self.set(s, (self.get(s) || 0) + 1);

  const rows = [];
  for (const [id, c] of self) {
    const n = byId.get(id);
    if (!n) continue;
    const cf = n.callFrame || {};
    const url = cf.url || '';
    let origin = 'native/unknown';
    if (url.includes('st-zip-converter')) origin = 'plugin';
    else if (url.includes('127.0.0.1:8004')) origin = 'host-or-other-ext';
    else if (url.startsWith('http') || url.startsWith('blob:')) origin = 'remote';
    rows.push({
      fn: cf.functionName || '(anonymous)',
      url: url.replace('https://127.0.0.1:8004/', '/'),
      line: cf.lineNumber,
      origin,
      ms: Number(((c * usPerSample) / 1000).toFixed(2)),
    });
  }
  rows.sort((a, b) => b.ms - a.ms);
  const byOrigin = {};
  for (const r of rows) {
    byOrigin[r.origin] = byOrigin[r.origin] || { ms: 0 };
    byOrigin[r.origin].ms = Number((byOrigin[r.origin].ms + r.ms).toFixed(2));
  }
  const total = Number(Object.values(byOrigin).reduce((a, b) => a + b.ms, 0).toFixed(2));
  return {
    windowMs,
    totalSampledMs: total,
    byOrigin,
    pluginSharePct: total ? Number((((byOrigin.plugin?.ms || 0) / total) * 100).toFixed(2)) : 0,
    topFunctions: rows.slice(0, 15),
    pluginFunctions: rows.filter((r) => r.origin === 'plugin').slice(0, 20),
  };
}

async function main() {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 950 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const client = await ctx.newCDPSession(page);

  // ── F1：启动期 profile（导航即开始采样） ──
  await client.send('Profiler.enable');
  await client.send('Profiler.setSamplingInterval', { interval: 500 });
  await client.send('Profiler.start');

  const tStart = Date.now();
  console.log('[F1] 导航并采样启动期…');
  await page.goto(BASE + '/', { waitUntil: 'commit', timeout: 60_000 });
  await page.waitForFunction(() => document.querySelector('#extensions_settings2, #chat'), { timeout: 60_000 }).catch(() => {});

  // 等静止
  let lastNodes = -1;
  let lastChange = Date.now();
  while (Date.now() - lastChange < 3000 && Date.now() - tStart < 120_000) {
    await sleep(500);
    const n = await page.evaluate(() => document.getElementsByTagName('*').length).catch(() => lastNodes);
    if (n !== lastNodes) {
      lastNodes = n;
      lastChange = Date.now();
    }
  }
  const startupMs = Date.now() - tStart;
  const { profile } = await client.send('Profiler.stop');
  const startupProfile = analyzeProfile(profile, startupMs, 500);
  console.log(`[F1] 启动期 ${startupMs}ms 采样完成；插件占比 ${startupProfile.pluginSharePct}%`);

  // ── F2：打开面板的一次性布局成本 ──
  const f2 = await (async () => {
    const m0 = await cdpMetrics(client);
    await page.evaluate(() => {
      const block = document.getElementById('rm_extensions_block');
      if (block) {
        block.classList.remove('closedDrawer');
        block.style.display = 'block';
      }
      const content = document.querySelector('#st_zip_converter_settings > .inline-drawer-content');
      if (content) content.style.display = 'block';
    });
    await sleep(2500);
    const m1 = await cdpMetrics(client);
    return diffMetrics(m0, m1);
  })();
  console.log('[F2] 面板打开成本采集完成');

  const size = await page.evaluate(() => {
    const app = document.querySelector('.st-converter-drawer-app');
    return {
      appHeight: app ? Math.round(app.getBoundingClientRect().height) : 0,
      appWidth: app ? Math.round(app.getBoundingClientRect().width) : 0,
      domNodes: document.getElementsByTagName('*').length,
    };
  });

  const result = {
    sampledAt: new Date().toISOString(),
    url: BASE,
    startup: { wallMs: startupMs, profile: startupProfile },
    panelOpenCost: f2,
    size,
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');

  console.log('\n===== F 结果 =====');
  console.log(`[F1 启动期 ${startupMs}ms] 采样总量 ${startupProfile.totalSampledMs}ms | 插件占比 ${startupProfile.pluginSharePct}%`);
  console.log('  按来源:', JSON.stringify(startupProfile.byOrigin));
  console.log('  Top 函数:');
  startupProfile.topFunctions.slice(0, 12).forEach((f) =>
    console.log(`    ${String(f.ms).padStart(8)}ms  ${f.origin.padEnd(20)} ${f.fn}  ${f.url}:${f.line}`)
  );
  console.log('  插件函数:');
  startupProfile.pluginFunctions.forEach((f) => console.log(`    ${String(f.ms).padStart(8)}ms  ${f.fn}  ${f.url}:${f.line}`));
  console.log('\n[F2 面板打开一次性成本]', JSON.stringify(f2));
  console.log('[尺寸]', JSON.stringify(size));
  console.log('\n落盘:', OUT);

  await ctx.close();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
