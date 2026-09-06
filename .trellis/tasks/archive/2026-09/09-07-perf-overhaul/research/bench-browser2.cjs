const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4520/', { waitUntil: 'load', timeout: 25000 });

  await page.evaluate(() => {
    window.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__longTasks.push(e.duration);
    }).observe({ entryTypes: ['longtask'] });
  });

  // 在页面内直接跑（通过 addInitTag 不行——用 evaluate 内联完整代码，不跨 eval 传函数体）
  const result = await page.evaluate(async () => {
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

    const t0 = performance.now();
    const zip = await import('./src/vendor/zip.js');
    const writer = await zipIo.createWriter(new zip.BlobWriter('application/zip'), { level: 5 });
    await Promise.all(entries.map(([n, d]) => writer.add(n, d)));
    const blob = await writer.close();
    const elapsed = Math.round(performance.now() - t0);
    const longTasks = window.__longTasks.splice(0);
    return { totalMB, entries: entries.length, elapsed, outMB: Math.round(blob.size / 1048576), longTasks };
  });

  console.log('浏览器基准（新并发管线）:', JSON.stringify({
    数据: result.totalMB + 'MB/' + result.entries + '条目',
    耗时: result.elapsed + 'ms',
    产物: result.outMB + 'MB',
    LongTask计数: result.longTasks.length,
    LongTask总阻塞: Math.round(result.longTasks.reduce((a, b) => a + b, 0)) + 'ms',
  }));
  await browser.close();
})();
