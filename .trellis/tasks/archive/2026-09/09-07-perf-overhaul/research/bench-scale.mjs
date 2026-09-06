import { zipIo } from '../../../../src/core/zip-io.js';
import * as zip from '../../../../src/vendor/zip.js';

// 更真实的大包基准：大量小文件 + 中等文件（酒馆数据包典型形态）
function makeChatJson(seed) {
  const msgs = [];
  for (let i = 0; i < 200; i++) msgs.push({ name: 'Char', mes: `消息 ${i} ${seed} 的内容文本，包含一定的重复模式和真实长度。`.repeat(6), send_date: '2026-09-07', swipes: ['a'.repeat(200)] });
  return JSON.stringify({ messages: msgs });
}
function makeEntries(count) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push([`chats/${String(i).padStart(5,'0')}.jsonl`, makeChatJson(i)]);
  }
  return entries;
}

// 500 个聊天文件（酒馆重度用户规模），每个 ~60KB
const entries = makeEntries(500);
const totalMB = Math.round(entries.reduce((s, [,d]) => s + d.length, 0) / 1048576);
console.log(`测试数据: ${entries.length} 个文件, 共 ${totalMB} MB 未压缩`);

// 当前管线：串行
{
  const t0 = performance.now();
  const writer = await zipIo.createWriter(new zip.BlobWriter('application/zip'), { level: 5 });
  for (const [name, d] of entries) await writer.add(name, d);
  const blob = await writer.close();
  console.log('当前串行管线:', Math.round(performance.now() - t0), 'ms →', Math.round(blob.size/1048576), 'MB zip');
}

// 理想并发管线（模拟 6 路原生 CompressionStream 预压缩 + Store 打包）
{
  const t0 = performance.now();
  const CONC = 6;
  const results = new Map();
  let idx = 0, active = 0;
  const t0w = performance.now();
  const writer = await zipIo.createWriter(new zip.BlobWriter('application/zip'), { level: 0 }); // Store：假设已预压缩
  await new Promise((resolve) => {
    function pump() {
      while (active < CONC && idx < entries.length) {
        const [name, d] = entries[idx++];
        active++;
        new Response(new Blob([d]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()
          .then((buf) => { results.set(name, buf); })
          .finally(() => { active--; pump(); if (active === 0 && idx >= entries.length) resolve(); });
      }
      if (idx >= entries.length && active === 0) resolve();
    }
    pump();
  });
  const tPre = performance.now();
  console.log('6 路并发预压缩:', Math.round(tPre - t0w), 'ms');
  // Store 写入（跳过再压缩）
  for (const [name] of entries) await writer.add(name, new Uint8Array(0)); // 占位验证 Store 速度
  await writer.close();
  console.log('Store 打包 500 空:', Math.round(performance.now() - tPre), 'ms (仅验证 Store 路径)');
}
