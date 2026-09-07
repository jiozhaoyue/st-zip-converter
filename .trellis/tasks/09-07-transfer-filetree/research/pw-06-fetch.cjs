/**
 * 实测 06（决定性）：在插件里真实点「从宿主拉取」，全程 100ms 粒度采样
 * longtask + 进度文本 + 定时器延迟 —— 抓「拉取时整页卡」「打开态持续卡」现行。
 * 拉取 20 秒后主动中止（taskControls 中止按钮），避免拉满 1.4GB。
 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  let page = null;
  for (const p of ctx.pages()) { if (p.url().includes('127.0.0.1:8004')) { page = p; break; } }

  // 展开抽屉
  await page.evaluate(() => {
    const d = document.getElementById('st_zip_converter_settings');
    const c = d && d.querySelector(':scope > .inline-drawer-content');
    if (c) c.style.display = 'block';
  });
  await page.waitForTimeout(800);

  // 注入采样器：longtask + setInterval 漂移（50ms 心跳的滞后 = 主线程排队压力）
  await page.evaluate(() => {
    window.__lt = [];
    window.__po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__lt.push({ t: Math.round(e.startTime), d: Math.round(e.duration) });
    });
    window.__po.observe({ entryTypes: ['longtask'] });
    window.__drift = [];
    window.__hb = performance.now();
    setInterval(() => {
      const now = performance.now();
      window.__drift.push(Math.round(now - window.__hb - 50));
      window.__hb = now;
    }, 50);
  });

  // 点击「从宿主拉取」
  await page.evaluate(() => {
    const btn = document.getElementById('btn-host-fetch');
    if (btn) btn.click();
  });

  // 20 秒采样
  const samples = [];
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    const s = await page.evaluate(() => ({
      status: document.getElementById('status-label')?.textContent?.slice(0, 90) || '',
      pct: document.getElementById('progress-percent')?.textContent || '',
    }));
    samples.push(s);
  }

  // 中止拉取（点中止按钮）
  await page.evaluate(() => {
    const btn = document.getElementById('tc-abort');
    if (btn && btn.offsetParent) btn.click();
  });
  await page.waitForTimeout(1500);

  const r = await page.evaluate(() => {
    window.__po.disconnect();
    const drift = window.__drift;
    const big = drift.filter((d) => d > 100);
    return {
      longTaskCount: window.__lt.length,
      longTaskTotalMs: window.__lt.reduce((s, e) => s + e.d, 0),
      top5: [...window.__lt].sort((a, b) => b.d - a.d).slice(0, 5),
      heartbeatDrift: { samples: drift.length, over100ms: big.length, maxDriftMs: Math.max(...drift) },
    };
  });
  console.log('== 进度采样 ==');
  for (const [i, s] of samples.entries()) if (i % 2 === 0) console.log(`${i}s: ${s.pct} ${s.status}`);
  console.log('== 主线程压力 ==');
  console.log(JSON.stringify(r, null, 2));
})();
