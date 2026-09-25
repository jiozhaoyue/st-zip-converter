/**
 * 阶段 E · 插件 UI 可见态与交互态开销（只读）
 *
 * 背景：常规使用中 #rm_extensions_block 是 closedDrawer + display:none，
 *       插件 UI 并不渲染。本脚本诊断性地打开该面板（仅影响本会话视图，
 *       不写实例数据），把插件 UI 真正显示出来，测其静态与交互开销。
 *
 * 只读约束：交互仅限 UI 控件本身（滚动 / 勾选类目复选框 / 切换下拉），
 *           不点击任何执行类按钮（转换/拉取/恢复/导出/删除），不调写端点。
 *
 * 用法：node pw-e1-ui-open.cjs
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
const OUT = path.join(__dirname, 'e1-ui-open.json');

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

function analyzeProfile(profile, windowMs) {
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
      ms: Number(((c * 25) / 1000).toFixed(2)),
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
    topFunctions: rows.slice(0, 20),
    pluginFunctions: rows.filter((r) => r.origin === 'plugin').slice(0, 20),
  };
}

async function profileWhile(client, fn, ms) {
  await client.send('Profiler.enable');
  await client.send('Profiler.setSamplingInterval', { interval: 25 });
  await client.send('Profiler.start');
  await fn();
  await sleep(ms);
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
  await page.waitForFunction(() => document.querySelector('#extensions_settings2, #chat'), { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(8_000);

  // 等静止
  let last = -1;
  let lastChange = Date.now();
  while (Date.now() - lastChange < 3000) {
    await sleep(500);
    const n = await page.evaluate(() => document.getElementsByTagName('*').length);
    if (n !== last) {
      last = n;
      lastChange = Date.now();
    }
  }
  console.log('[0] 静止，DOM', last);

  // ── 诊断性打开面板（仅本会话视图） ──
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
  console.log('[E] 打开面板:', JSON.stringify(opened));
  await sleep(2500);

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
      // 按钮文案清单（冗余度证据）
      buttonLabels: visible.map((b) => (b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24)),
    };
  });
  console.log('[E] UI 事实:', JSON.stringify({ ...uiFacts, buttonLabels: undefined }));
  console.log('[E] 可见按钮:', JSON.stringify(uiFacts && uiFacts.buttonLabels));

  // ── 静态可见态采样 12s ──
  const m0 = await cdpMetrics(client);
  await sleep(12_000);
  const m1 = await cdpMetrics(client);
  const staticMetrics = diffMetrics(m0, m1);
  console.log('[E] 静态可见态采样完成');

  // ── 交互态：滚动 + 勾选类目复选框 + 切换下拉（12s） ──
  const interactProfile = await profileWhile(
    client,
    async () => {
      const t0 = Date.now();
      let i = 0;
      while (Date.now() - t0 < 12_000) {
        await page.evaluate((k) => {
          const app = document.querySelector('.st-converter-drawer-app');
          if (!app) return;
          if (k % 4 === 0) {
            app.scrollTop = (app.scrollTop + 200) % Math.max(1, app.scrollHeight - app.clientHeight || 1);
          } else if (k % 4 === 1) {
            const cbs = app.querySelectorAll('input[type=checkbox]');
            const cb = cbs[k % Math.max(1, cbs.length)];
            if (cb) {
              cb.checked = !cb.checked;
              cb.dispatchEvent(new Event('change', { bubbles: true }));
            }
          } else if (k % 4 === 2) {
            const sel = app.querySelector('select');
            if (sel) {
              sel.selectedIndex = (sel.selectedIndex + 1) % sel.options.length;
              sel.dispatchEvent(new Event('change', { bubbles: true }));
            }
          } else {
            const details = app.querySelectorAll('details');
            const d = details[k % Math.max(1, details.length)];
            if (d) d.open = !d.open;
          }
        }, i);
        i += 1;
        await sleep(220);
      }
    },
    500
  );
  console.log('[E] 交互态 profile 完成');

  const result = {
    sampledAt: new Date().toISOString(),
    url: BASE,
    opened,
    uiFacts,
    staticVisibleState: { metrics: staticMetrics },
    interactionProfile: interactProfile,
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');

  console.log('\n===== E 结果 =====');
  console.log('[静态可见态 12s]', JSON.stringify(staticMetrics));
  console.log(`\n[交互态 profile] 采样总量 ${interactProfile.totalSampledMs}ms | 插件占比 ${interactProfile.pluginSharePct}%`);
  console.log('  按来源:', JSON.stringify(interactProfile.byOrigin));
  console.log('  Top 函数:');
  interactProfile.topFunctions.slice(0, 12).forEach((f) =>
    console.log(`    ${String(f.ms).padStart(8)}ms  ${f.origin.padEnd(20)} ${f.fn}  ${f.url}:${f.line}`)
  );
  console.log('  插件函数:');
  interactProfile.pluginFunctions.forEach((f) => console.log(`    ${String(f.ms).padStart(8)}ms  ${f.fn}  ${f.url}:${f.line}`));
  console.log('\n落盘:', OUT);

  await ctx.close();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
