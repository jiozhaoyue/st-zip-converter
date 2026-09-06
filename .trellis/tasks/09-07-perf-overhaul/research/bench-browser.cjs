/**
 * 浏览器基准：并发写入管线 vs 旧串行管线（在新管线代码内嵌对比）
 * 在独立 Web 模式页面上下文运行，采集耗时与 Long Task 计数。
 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4519/', { waitUntil: 'load', timeout: 25000 });

  // 注入 LongTask 观察器
  await page.evaluate(() => {
    window.__longTasks = [];
    window.__po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__longTasks.push(e.duration);
    });
    window.__po.observe({ entryTypes: ['longtask'] });
  });

  const bench = await page.evaluate(async (BENCH_SRC) => {
    return await eval(BENCH_SRC);
  }, `
    async (log) => {
      const { zipIo } = await import('./src/core/zip-io.js');
      function makeData(size, seed) {
        const arr = new Uint8Array(size);
        let s = seed;
        for (let i = 0; i < size; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; arr[i] = (i % 32 === 0) ? (s & 0xff) : (i & 0xff); }
        return arr;
      }
      const entries = [];
      for (let i = 0; i < 60; i++) entries.push(['characters/card_' + i + '.png', makeData(2 * 1024 * 1024, i)]);
      for (let i = 0; i < 40; i++) entries.push(['chats/chat_' + i + '.jsonl', makeData(1536 * 1024, i + 100)]);
      for (let i = 0; i < 400; i++) entries.push(['assets/img_' + i + '.webp', makeData(100 * 1024, i + 200)]);
      const totalMB = Math.round(entries.reduce((s, [, d]) => s + d.length, 0) / 1048576);

      // 新管线（并发）
      const t0 = performance.now();
      const writer = await zipIo.createWriter(new (await import('./src/vendor/zip.js')).BlobWriter('application/zip'), { level: 5 });
      await Promise.all(entries.map(([n, d]) => writer.add(n, d)));
      const blob = await writer.close();
      const elapsed = Math.round(performance.now() - t0);

      return { totalMB, entries: entries.length, elapsed, outMB: Math.round(blob.size / 1048576) };
    }
  `);

  const longTasks = await page.evaluate(() => window.__longTasks);
  console.log('浏览器基准（新并发管线，159MB/500条目）:', JSON.stringify(bench));
  console.log('LongTask(>50ms) 计数:', longTasks.length, '总阻塞:', Math.round(longTasks.reduce((a, b) => a + b, 0)), 'ms');
  console.log('LongTask 明细:', longTasks.map((d) => Math.round(d)).join(','));

  await browser.close();
})();
