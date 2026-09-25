/**
 * 阶段 H2 · 传输期时间轴归因（只读）
 *
 * H1 发现：传输期出现 dur=4725ms 与 dur=5536ms 两个巨大长任务，且进度停滞在 18%。
 * 聚合 profile 无法定位它们。本脚本保留 CDP profile 的 timeDeltas/samples 重建时间轴，
 * 按 5s 分段输出各段 Top 函数，并采集 LongTask 的 attribution。
 *
 * 受控：采样 45s 后主动中止。
 * 用法：node pw-h2-transfer-timeline.cjs
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
const OUT = path.join(__dirname, 'h2-timeline.json');
const SAMPLE_MS = Number(process.env.TRANSFER_SAMPLE_MS || 45_000);
const US = 1000; // 采样间隔 1ms

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 重建时间轴并按窗口分段聚合 */
function timelineAnalysis(profile, usPerSample, segmentMs = 5000) {
  const byId = new Map();
  for (const n of profile.nodes) byId.set(n.id, n);

  const ts = profile.timeDeltas || [];
  const samples = profile.samples || [];
  const segments = new Map(); // segIndex -> Map(fnKey -> samples)
  let t = 0;
  let totalSamples = 0;

  for (let i = 0; i < samples.length; i++) {
    t += ts[i] || 0;
    const seg = Math.floor(t / (segmentMs * 1000));
    const node = byId.get(samples[i]);
    if (!node) continue;
    const cf = node.callFrame || {};
    const url = cf.url || '';
    let origin = 'native/unknown';
    if (url.includes('st-zip-converter')) origin = 'plugin';
    else if (url.includes('127.0.0.1:8004')) origin = 'host-or-other-ext';
    else if (url.startsWith('http') || url.startsWith('blob:')) origin = 'remote';

    const key = `${cf.functionName || '(anonymous)'}|${url.replace('https://127.0.0.1:8004/', '/')}|${cf.lineNumber}|${origin}`;
    if (!segments.has(seg)) segments.set(seg, new Map());
    const m = segments.get(seg);
    m.set(key, (m.get(key) || 0) + 1);
    totalSamples++;
  }

  const out = [];
  for (const seg of [...segments.keys()].sort((a, b) => a - b)) {
    const m = segments.get(seg);
    const rows = [...m.entries()]
      .map(([k, c]) => {
        const [fn, url, line, origin] = k.split('|');
        return { fn, url, line: Number(line), origin, ms: Number(((c * usPerSample) / 1000).toFixed(2)), samples: c };
      })
      .sort((a, b) => b.ms - a.ms);
    const byOrigin = {};
    for (const r of rows) {
      byOrigin[r.origin] = byOrigin[r.origin] || { ms: 0 };
      byOrigin[r.origin].ms = Number((byOrigin[r.origin].ms + r.ms).toFixed(2));
    }
    const total = Number(Object.values(byOrigin).reduce((a, b) => a + b.ms, 0).toFixed(2));
    out.push({
      segStartMs: seg * segmentMs,
      segEndMs: (seg + 1) * segmentMs,
      totalSampledMs: total,
      byOrigin,
      pluginSharePct: total ? Number((((byOrigin.plugin?.ms || 0) / total) * 100).toFixed(2)) : 0,
      top: rows.filter((r) => r.origin !== 'native/unknown').slice(0, 6),
      topNative: rows.filter((r) => r.origin === 'native/unknown').slice(0, 4),
    });
  }
  return { segments: out, totalSamples, totalMs: Number(((totalSamples * usPerSample) / 1000).toFixed(2)) };
}

async function main() {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 950 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const client = await ctx.newCDPSession(page);

  console.log('[H2] 打开', BASE);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => document.querySelector('#extensions_settings2, #chat'), { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(10_000);

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

  // LongTask 探针（含 attribution）
  await page.evaluate(() => {
    window.__lt = [];
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          window.__lt.push({
            start: Math.round(e.startTime),
            dur: Math.round(e.duration),
            name: e.name,
            attribution: (e.attribution || []).map((a) => ({
              name: a.name,
              entryType: a.entryType,
              containerType: a.containerType,
              containerSrc: a.containerSrc,
              containerId: a.containerId,
              containerName: a.containerName,
            })),
          });
        }
      }).observe({ entryTypes: ['longtask'] });
    } catch { /* ignore */ }
  });

  console.log('[H2] 触发拉取…');
  await page.evaluate(() => {
    const app = document.querySelector('.st-converter-drawer-app');
    app.querySelector('#btn-host-fetch')?.click();
  });
  await sleep(3000);

  await client.send('Profiler.enable');
  await client.send('Profiler.setSamplingInterval', { interval: US });
  await client.send('Profiler.start');

  const t0 = Date.now();
  const timeline = [];
  while (Date.now() - t0 < SAMPLE_MS) {
    await sleep(5000);
    const s = await page.evaluate(() => ({
      status: (document.getElementById('status-label')?.textContent || '').slice(0, 140),
      pct: document.querySelector('#progress-bar-fill')?.style.width || null,
      lt: (window.__lt || []).length,
      ltMs: Math.round((window.__lt || []).reduce((a, b) => a + b.dur, 0)),
    }));
    timeline.push({ at: Date.now() - t0, ...s });
    console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${s.pct} | lt=${s.lt}/${s.ltMs}ms | ${s.status.slice(0, 70)}`);
  }

  const { profile } = await client.send('Profiler.stop');
  const longtasks = await page.evaluate(() => window.__lt || []);

  // 中止
  const aborted = await page.evaluate(() => {
    const btn = document.getElementById('tc-abort');
    if (btn && !document.getElementById('task-controls')?.hidden) {
      btn.click();
      return 'abort-clicked';
    }
    return 'no-abort-available';
  });
  console.log('[H2] 中止:', aborted);
  await sleep(4000);

  const analysis = timelineAnalysis(profile, US, 5000);
  const result = {
    sampledAt: new Date().toISOString(),
    url: BASE,
    sampleMs: SAMPLE_MS,
    timeline,
    longtasks: longtasks.slice(0, 40),
    analysis,
    aborted,
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');

  console.log('\n===== H2 时间轴归因（每 5s 一段）=====');
  for (const s of analysis.segments) {
    console.log(`\n[${s.segStartMs / 1000}–${s.segEndMs / 1000}s] 采样 ${s.totalSampledMs}ms | 插件占比 ${s.pluginSharePct}%`);
    console.log('  按来源:', JSON.stringify(s.byOrigin));
    s.top.forEach((r) => console.log(`    ${String(r.ms).padStart(8)}ms  ${r.origin.padEnd(20)} ${r.fn}  ${r.url}:${r.line}`));
    s.topNative.forEach((r) => console.log(`    ${String(r.ms).padStart(8)}ms  native               ${r.fn}`));
  }

  console.log('\n===== 巨大长任务（>1000ms）=====');
  longtasks
    .filter((l) => l.dur > 1000)
    .forEach((l) => console.log(`  start=${l.start}ms dur=${l.dur}ms name=${l.name} attribution=${JSON.stringify(l.attribution)}`));

  console.log('\n落盘:', OUT);
  await ctx.close();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
