import { zipIo } from '../../../../src/core/zip-io.js';
import * as zip from '../../../../src/vendor/zip.js';

// 用真实 fixtures 包做基准（如果存在）
import { existsSync } from 'node:fs';
const fixtures = [
  'tests/real-samples/real-l.zip',
  'tests/real-samples/real-st.zip',
];
let found = null;
for (const f of fixtures) if (existsSync(f)) found = f;
console.log('fixture:', found);

// 大合成包：300MB 级、混合大小文件
function rand(size, seed) {
  const arr = new Uint8Array(size);
  let s = seed;
  for (let i = 0; i < size; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    // 70% 重复模式（可压缩）+ 30% 随机（不可压缩）
    arr[i] = (i % 32 === 0) ? (s & 0xff) : (i & 0xff);
  }
  return arr;
}

const entries = [];
for (let i = 0; i < 60; i++) entries.push([`characters/card_${i}.png`, rand(2 * 1024 * 1024, i)]);      // 120MB
for (let i = 0; i < 40; i++) entries.push([`chats/chat_${i}.jsonl`, rand(1.5 * 1024 * 1024, i + 100)]); // 60MB
for (let i = 0; i < 400; i++) entries.push([`assets/img_${i}.webp`, rand(100 * 1024, i + 200)]);        // 40MB
const totalMB = Math.round(entries.reduce((s, [, d]) => s + d.length, 0) / 1048576);
console.log(`合成大包: ${entries.length} 条目, ${totalMB} MB`);

// 当前串行管线 level 5
{
  const t0 = performance.now();
  const writer = await zipIo.createWriter(new zip.BlobWriter('application/zip'), { level: 5 });
  for (const [name, d] of entries) await writer.add(name, d);
  const blob = await writer.close();
  console.log('串行管线 level5:', Math.round(performance.now() - t0), 'ms →', Math.round(blob.size / 1048576), 'MB');
}

// 并发管线模拟：6 路 CompressionStream 预压缩 → writer Store
async function precompress(entries, conc = 6, onItem) {
  const out = new Map();
  let idx = 0, active = 0;
  await new Promise((resolve) => {
    function pump() {
      if (idx >= entries.length && active === 0) return resolve();
      while (active < conc && idx < entries.length) {
        const [name, d] = entries[idx++];
        active++;
        new Response(new Blob([d]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()
          .then((buf) => { out.set(name, new Uint8Array(buf)); onItem && onItem(name); })
          .catch(() => { out.set(name, d); })
          .finally(() => { active--; pump(); });
      }
    }
    pump();
  });
  return out;
}
{
  const t0 = performance.now();
  const compressed = await precompress(entries, 6);
  const t1 = performance.now();
  const writer = await zipIo.createWriter(new zip.BlobWriter('application/zip'), { level: 0 });
  for (const [name, d] of entries) await writer.add(name, compressed.get(name));
  const blob = await writer.close();
  const t2 = performance.now();
  console.log(`并发管线: 预压缩 ${Math.round(t1-t0)}ms + Store 打包 ${Math.round(t2-t1)}ms = ${Math.round(t2-t0)}ms → ${Math.round(blob.size/1048576)}MB`);
}
