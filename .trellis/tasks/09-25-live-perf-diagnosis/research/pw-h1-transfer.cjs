/**
 * 阶段 H · 传输期实测（用户明确要求「补测传输期」）
 *
 * 受控设计（避免把实例拖垮、避免 GB 级不可控下载）：
 *   · 拉取前**取消勾选「系统设置」** —— 后端 selection.settings 会隐含打包 backups/（实测 2.3GB / 占用户目录 62%），
 *     那部分测的是 Luker 服务端 archiver 的打包耗时，不是插件责任，且会让单次测试不可控。
 *   · 采样 90s 后**主动中止**（点任务控制条的中止），不等待完整落盘。
 *   · 全程不点「恢复/写回宿主」——传输期只走上行 GET /api/users/backup + 下行到浏览器存储。
 *
 * 只读边界说明：本测试会在浏览器侧产生拉取产物（内存/OPFS 半成品），并在中止后走插件的清理路径；
 *   **不向 Instance/** 写入任何文件**，不调用任何宿主写端点。
 *
 * 用法：node pw-h1-transfer.cjs
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
const OUT = path.join(__dirname, 'h1-transfer.json');
const SAMPLE_MS = Number(process.env.TRANSFER_SAMPLE_MS || 90_000);

const METRIC_KEYS = [
  'TaskDuration',
  'ScriptDuration',
  'LayoutDuration',
  'RecalcStyleDuration',
  'RecalcStyleCount',
  'JSHeapUsedSize',
  'Nodes',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpMetrics(client) {
  const { metrics } = await client.send('Performance.getMetrics');
  const o = {};
  for (const m of metrics) if (METRIC_KEYS.includes(m.name)) o[m.name] = m.value;
  return o;
}
function diff(a, b) {
  const o = {};
  for (const k of METRIC_KEYS) {
    if (a[k] === undefined || b[k] === undefined) continue;
    o[k] = k === 'JSHeapUsedSize' || k === 'Nodes' ? Math.round(b[k]) : Number((b[k] - a[k]).toFixed(4));
  }
  return o;
}

function analyzeProfile(profile, usPerSample) {
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
    rows.push({ fn: cf.functionName || '(anonymous)', url: url.replace('https://127.0.0.1:8004/', '/'), line: cf.lineNumber, origin, ms: Number(((c * usPerSample) / 1000).toFixed(2)) });
  }
  rows.sort((a, b) => b.ms - a.ms);
  const byOrigin = {};
  for (const r of rows) {
    byOrigin[r.origin] = byOrigin[r.origin] || { ms: 0 };
    byOrigin[r.origin].ms = Number((byOrigin[r.origin].ms + r.ms).toFixed(2));
  }
  const total = Number(Object.values(byOrigin).reduce((a, b) => a + b.ms, 0).toFixed(2));
  return {
    totalSampledMs: total,
    byOrigin,
    pluginSharePct: total ? Number((((byOrigin.plugin?.ms || 0) / total) * 100).toFixed(2)) : 0,
    topFunctions: rows.slice(0, 18),
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

  // 网络观测：记录 backup 请求与流量
  const netLog = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/users/')) netLog.push({ t: Date.now(), kind: 'req', url: r.url(), method: r.method() });
  });
  page.on('response', async (r) => {
    if (r.url().includes('/api/users/')) {
      const h = r.headers();
      netLog.push({ t: Date.now(), kind: 'resp', url: r.url(), status: r.status(), length: h['content-length'] || null });
    }
  });

  console.log('[H] 打开', BASE);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => document.querySelector('#extensions_settings2, #chat'), { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(10_000);

  // 打开面板
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

  // 读默认勾选状态
  const before = await page.evaluate(() => {
    const app = document.querySelector('.st-converter-drawer-app');
    const boxes = Array.from(app.querySelectorAll('#category-checkboxes input[type=checkbox]'));
    return {
      categoryCount: boxes.length,
      checked: boxes.filter((b) => b.checked).map((b) => b.dataset.category || b.id || b.value || '?'),
      includeBackups: !!app.querySelector('#include-backups-check')?.checked,
      includeCache: !!app.querySelector('#include-cache-check')?.checked,
      includePrivate: !!app.querySelector('#include-private-check')?.checked,
      target: app.querySelector('#target-select')?.value,
      compression: app.querySelector('#compression-select')?.value,
      split: app.querySelector('#split-select')?.value,
      extMode: app.querySelector('input[name=extension-mode]:checked')?.value,
    };
  });
  console.log('[H] 拉取前勾选状态:', JSON.stringify(before));

  // 受控：取消「系统设置」类目（避免隐含打包 2.3GB backups/）
  const adjusted = await page.evaluate(() => {
    const app = document.querySelector('.st-converter-drawer-app');
    const out = { unchecked: [] };
    app.querySelectorAll('#category-checkboxes input[type=checkbox]').forEach((b) => {
      const key = b.dataset.category || b.value || '';
      if (/setting|系统设置/i.test(key) || /setting/i.test(b.id)) {
        if (b.checked) {
          b.checked = false;
          b.dispatchEvent(new Event('change', { bubbles: true }));
          out.unchecked.push(key || b.id);
        }
      }
    });
    // 附带：确保 include-backups 不勾
    const ib = app.querySelector('#include-backups-check');
    if (ib && ib.checked) {
      ib.checked = false;
      ib.dispatchEvent(new Event('change', { bubbles: true }));
      out.unchecked.push('include-backups-check');
    }
    return out;
  });
  console.log('[H] 受控调整（取消勾选）:', JSON.stringify(adjusted));

  // 安装探针
  await page.evaluate(() => {
    window.__t = { longtasks: [] };
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__t.longtasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
      }).observe({ entryTypes: ['longtask'] });
    } catch { /* ignore */ }
  });

  console.log('[H] 触发「从宿主拉取」…');
  const fetchStage = await (async () => {
    const m0 = await cdpMetrics(client);
    await page.evaluate(() => {
      const app = document.querySelector('.st-converter-drawer-app');
      app.querySelector('#btn-host-fetch')?.click();
    });
    // 等文件树确认条出现
    let appeared = false;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      appeared = await page.evaluate(() => {
        const bar = document.querySelector('#host-tree-confirm-bar');
        return !!bar && !bar.hidden;
      });
      if (appeared) break;
    }
    return { m0, treeConfirmAppeared: appeared };
  })();
  console.log('[H] 文件树确认条:', fetchStage.treeConfirmAppeared);

  let progressText = null;
  if (fetchStage.treeConfirmAppeared) {
    await page.evaluate(() => {
      const app = document.querySelector('.st-converter-drawer-app');
      app.querySelector('#btn-host-tree-confirm')?.click();
    });
    console.log('[H] 已点「确认并继续转换」，开始传输');
  } else {
    console.log('[H] 未出现确认条，可能直接进入传输或报错；读取当前状态');
  }

  // ── 采样窗口 ──
  await client.send('Profiler.enable');
  await client.send('Profiler.setSamplingInterval', { interval: 1000 });
  await client.send('Profiler.start');
  const t0 = Date.now();
  const timeline = [];
  while (Date.now() - t0 < SAMPLE_MS) {
    await sleep(3000);
    const snap = await page.evaluate(() => {
      const lt = (window.__t && window.__t.longtasks) || [];
      const bar = document.querySelector('#progress-bar-fill');
      return {
        status: (document.getElementById('status-label')?.textContent || '').slice(0, 120),
        pct: bar ? bar.style.width : null,
        longtasks: lt.length,
        longtaskMs: Math.round(lt.reduce((a, b) => a + b.dur, 0)),
        halted: !!document.querySelector('#tc-abort') && !document.getElementById('task-controls')?.hidden,
      };
    });
    timeline.push({ at: Date.now() - t0, ...snap });
    console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${snap.pct || '-'} | ${snap.status}`);
    if (/失败|错误|error/i.test(snap.status)) break;
  }
  const { profile } = await client.send('Profiler.stop');
  const m1 = await cdpMetrics(client);
  const transferProfile = analyzeProfile(profile, 1000);

  const after = await page.evaluate(() => {
    const lt = (window.__t && window.__t.longtasks) || [];
    return {
      longtaskCount: lt.length,
      longtaskTotalMs: Math.round(lt.reduce((a, b) => a + b.dur, 0)),
      longtaskMaxMs: Math.round(lt.reduce((a, b) => Math.max(a, b.dur), 0)),
      samples: lt.slice(0, 30),
      progressText: (document.getElementById('status-label')?.textContent || '').slice(0, 200),
    };
  });

  // ── 主动中止（不等待完整落盘） ──
  const aborted = await page.evaluate(() => {
    const btn = document.getElementById('tc-abort');
    if (btn && !document.getElementById('task-controls')?.hidden) {
      btn.click();
      return 'abort-clicked';
    }
    return 'no-abort-available';
  });
  console.log('[H] 中止:', aborted);
  await sleep(4000);

  const result = {
    sampledAt: new Date().toISOString(),
    url: BASE,
    sampleMs: SAMPLE_MS,
    before,
    adjusted,
    treeConfirmAppeared: fetchStage.treeConfirmAppeared,
    timeline,
    after,
    transferMetrics: diff(fetchStage.m0, m1),
    transferProfile,
    aborted,
    networkLog: netLog,
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');

  console.log('\n===== H 传输期结果 =====');
  console.log('[采样窗口]', timeline.length, '个快照');
  console.log('[longtask]', after.longtaskCount, '个 / 共', after.longtaskTotalMs, 'ms / 最长', after.longtaskMaxMs, 'ms');
  console.log('[指标增量]', JSON.stringify(result.transferMetrics));
  console.log(`[CPU Profile] 采样总量 ${transferProfile.totalSampledMs}ms | 插件占比 ${transferProfile.pluginSharePct}%`);
  console.log('  按来源:', JSON.stringify(transferProfile.byOrigin));
  console.log('  Top 函数:');
  transferProfile.topFunctions.slice(0, 12).forEach((f) => console.log(`    ${String(f.ms).padStart(8)}ms  ${f.origin.padEnd(20)} ${f.fn}  ${f.url}:${f.line}`));
  console.log('  插件函数:');
  transferProfile.pluginFunctions.forEach((f) => console.log(`    ${String(f.ms).padStart(8)}ms  ${f.fn}  ${f.url}:${f.line}`));
  console.log('\n落盘:', OUT);

  await ctx.close();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
