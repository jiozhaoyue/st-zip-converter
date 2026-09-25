/**
 * 阶段 D · CPU Profile 精确归因（只读）
 *
 * 目的：把「宿主 DOM 变动触发的主线程脚本开销」精确拆到函数级，回答
 *   「插件（st-zip-converter）占多少 / 宿主与其他扩展占多少」。
 *
 * 设计：
 *   段 A（刺激）：10s，每 240ms 在 body 插入并移除 1 个无害 display:none 节点
 *                 → 等价于宿主重渲染，触发全部 body MutationObserver
 *   段 B（静默）：10s，不制造变动
 *   两段各抓 CDP Profiler，按 callFrame.url 归因，输出 Top 函数
 *
 * 只读约束：仅插入/移除自建的无害节点；不点业务按钮；不调写端点。
 * 用法：node pw-d1-profile.cjs
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
const OUT = path.join(__dirname, 'd1-profile.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把 CDP profile 归因到「函数 + 来源」 */
function analyzeProfile(profile, stimulusMs) {
  const byId = new Map();
  for (const n of profile.nodes) byId.set(n.id, n);

  const selfTime = new Map(); // nodeId -> sample count
  for (const s of profile.samples || []) {
    selfTime.set(s, (selfTime.get(s) || 0) + 1);
  }

  const intervalUs = profile.samples ? (profile.timeDeltas ? null : null) : null;
  void intervalUs;

  // 采样间隔由 start 时的设置决定，统一按 100us 折算（见 Profiler.setSamplingInterval）
  const US_PER_SAMPLE = 100;

  const rows = [];
  for (const [id, count] of selfTime) {
    const node = byId.get(id);
    if (!node) continue;
    const cf = node.callFrame || {};
    const url = cf.url || '';
    let origin = 'native/unknown';
    if (url.includes('st-zip-converter')) origin = 'plugin';
    else if (url.includes('127.0.0.1:8004')) origin = 'host-or-other-ext';
    else if (url.startsWith('http')) origin = 'remote';
    rows.push({
      fn: cf.functionName || '(anonymous)',
      url: url.replace('https://127.0.0.1:8004/', '/'),
      line: cf.lineNumber,
      origin,
      samples: count,
      ms: Number(((count * US_PER_SAMPLE) / 1000).toFixed(2)),
    });
  }
  rows.sort((a, b) => b.ms - a.ms);

  const byOrigin = {};
  for (const r of rows) {
    byOrigin[r.origin] = byOrigin[r.origin] || { ms: 0, samples: 0 };
    byOrigin[r.origin].ms = Number((byOrigin[r.origin].ms + r.ms).toFixed(2));
    byOrigin[r.origin].samples += r.samples;
  }
  const totalMs = Number(Object.values(byOrigin).reduce((a, b) => a + b.ms, 0).toFixed(2));

  return {
    windowMs: stimulusMs,
    totalSampledMs: totalMs,
    byOrigin,
    pluginSharePct: totalMs ? Number((((byOrigin.plugin || { ms: 0 }).ms / totalMs) * 100).toFixed(2)) : 0,
    topFunctions: rows.slice(0, 25),
    pluginFunctions: rows.filter((r) => r.origin === 'plugin').slice(0, 25),
  };
}

async function profileWindow(client, page, { ms, stimulate, gapMs = 240 }) {
  await client.send('Profiler.enable');
  await client.send('Profiler.setSamplingInterval', { interval: 100 });
  await client.send('Profiler.start');

  let stimulator = null;
  if (stimulate) {
    stimulator = setInterval(() => {
      page
        .evaluate(() => {
          const n = document.createElement('span');
          n.id = 'diag-stim';
          n.style.display = 'none';
          document.body.appendChild(n);
          setTimeout(() => n.remove(), 20);
        })
        .catch(() => {});
    }, gapMs);
  }

  await sleep(ms);
  if (stimulator) clearInterval(stimulator);
  await sleep(500);

  const { profile } = await client.send('Profiler.stop');
  return analyzeProfile(profile, ms);
}

async function main() {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 950 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const client = await ctx.newCDPSession(page);

  console.log('[0] 打开', BASE);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(
    () => document.querySelector('#extensions_settings2, #chat'),
    { timeout: 60_000 }
  ).catch(() => {});
  await page.waitForTimeout(6_000);

  // 等静止
  let lastNodes = -1;
  let lastChange = Date.now();
  while (Date.now() - lastChange < 3000) {
    await sleep(500);
    const n = await page.evaluate(() => document.getElementsByTagName('*').length);
    if (n !== lastNodes) {
      lastNodes = n;
      lastChange = Date.now();
    }
  }
  console.log('[0] 页面静止，DOM', lastNodes);

  console.log('[A] 刺激窗口 10s（模拟宿主重渲染）…');
  const stimulus = await profileWindow(client, page, { ms: 10_000, stimulate: true, gapMs: 240 });

  await sleep(1500);
  console.log('[B] 静默窗口 10s…');
  const quiet = await profileWindow(client, page, { ms: 10_000, stimulate: false });

  const result = {
    sampledAt: new Date().toISOString(),
    url: BASE,
    stimulus,
    quiet,
    delta: {
      pluginMs: Number((stimulus.byOrigin.plugin?.ms || 0) - (quiet.byOrigin.plugin?.ms || 0)).toFixed(2),
      hostMs: Number(
        ((stimulus.byOrigin['host-or-other-ext']?.ms || 0) - (quiet.byOrigin['host-or-other-ext']?.ms || 0)).toFixed(2)
      ),
      totalMs: Number((stimulus.totalSampledMs - quiet.totalSampledMs).toFixed(2)),
    },
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');

  console.log('\n===== CPU Profile 归因 =====');
  for (const [label, r] of [['刺激窗口(10s)', stimulus], ['静默窗口(10s)', quiet]]) {
    console.log(`\n[${label}] 采样总量 ${r.totalSampledMs}ms | 插件占比 ${r.pluginSharePct}%`);
    console.log('  按来源:', JSON.stringify(r.byOrigin));
    console.log('  Top 函数:');
    r.topFunctions.slice(0, 12).forEach((f) => {
      console.log(`    ${String(f.ms).padStart(8)}ms  ${f.origin.padEnd(20)} ${f.fn}  ${f.url}:${f.line}`);
    });
  }
  console.log('\n[刺激 − 静默 净值]', JSON.stringify(result.delta));
  console.log('\n=== 插件函数明细（刺激窗口）===');
  stimulus.pluginFunctions.forEach((f) => console.log(`  ${String(f.ms).padStart(8)}ms  ${f.fn}  ${f.url}:${f.line}`));
  console.log('\n落盘:', OUT);

  await ctx.close();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
