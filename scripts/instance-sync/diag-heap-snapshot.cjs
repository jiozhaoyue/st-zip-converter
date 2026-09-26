/**
 * heap snapshot 聚合分析器 —— 回答「这几 GB 的 JS 堆到底是什么」
 *
 * 背景：真源包规模下 `convert()` 的 `heapUsed` 峰值可达 **6.2 GB**，而同一时刻
 * `external` 仅 76 MB、`arrayBuffers` 仅 57 MB ⇒ 峰值是**纯 JS 堆对象**，
 * 不是数据 buffer。需要按「节点类型 + 构造器名」聚合 `self_size` 才能定位。
 *
 * 用法（**必须给足堆**，快照本身就有 GB 级）：
 *   node --max-old-space-size=8192 scripts/instance-sync/diag-heap-snapshot.cjs <snapshot> [--top 30]
 *
 * 产出：按 self_size 总量排序的 top N 行 —— 每行 `bytes | count | type | 构造器名`。
 * `self_size` 是**浅层**占用（不含其引用对象），足够回答「大头是什么类型」；
 * 若要 retained size 需图形化工具（Chrome DevTools Memory 面板），本脚本刻意不做。
 */

const fs = require('fs');
const path = require('path');

const MB = (n) => (n / 1048576).toFixed(1);

function parseArgs(argv) {
  const out = { file: '', top: 30 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--top') out.top = Number(argv[++i]) || 30;
    else if (!argv[i].startsWith('--')) out.file = argv[i];
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('用法：node --max-old-space-size=8192 scripts/instance-sync/diag-heap-snapshot.cjs <snapshot> [--top N]');
    process.exit(2);
  }
  const file = path.resolve(args.file);
  const stat = fs.statSync(file);
  console.log(`快照：${path.basename(file)}（文件 ${MB(stat.size)} MB）`);
  console.log('正在解析（GB 级 JSON，需数十秒）…');

  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const meta = snap.snapshot.meta;
  const fields = meta.node_fields;
  const F = fields.length;
  const iType = fields.indexOf('type');
  const iName = fields.indexOf('name');
  const iSize = fields.indexOf('self_size');
  const typeNames = meta.node_types[iType];
  const nodes = snap.nodes;
  const strings = snap.strings;
  const total = snap.snapshot.node_count;

  const agg = new Map();
  const byType = new Map();
  let sumSize = 0;

  for (let i = 0; i < total; i += 1) {
    const b = i * F;
    const sz = nodes[b + iSize];
    sumSize += sz;
    const tName = typeNames[nodes[b + iType]];
    const ctor = strings[nodes[b + iName]];

    const bt = byType.get(tName) || { count: 0, bytes: 0 };
    bt.count += 1; bt.bytes += sz;
    byType.set(tName, bt);

    const key = `${tName} | ${ctor}`;
    const e = agg.get(key) || { count: 0, bytes: 0 };
    e.count += 1; e.bytes += sz;
    agg.set(key, e);
  }

  console.log(`\n节点总数 ${total} ｜ self_size 合计 ${MB(sumSize)} MB\n`);

  console.log('=== 按节点类型汇总 ===');
  for (const [t, v] of [...byType.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`  ${String(MB(v.bytes)).padStart(10)} MB  ${String(v.count).padStart(10)} 个  ${t}`);
  }

  console.log(`\n=== self_size 最大的前 ${args.top} 个「类型 | 构造器」 ===`);
  for (const [k, v] of [...agg.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, args.top)) {
    console.log(`  ${String(MB(v.bytes)).padStart(10)} MB  ${String(v.count).padStart(10)} 个  ${k}`);
  }

  console.log(`\n=== 数量最多的前 ${args.top} 个（看「多而小」的对象） ===`);
  for (const [k, v] of [...agg.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, args.top)) {
    console.log(`  ${String(v.count).padStart(10)} 个  ${String(MB(v.bytes)).padStart(10)} MB  ${k}`);
  }
})().catch((e) => {
  console.error('分析失败：', e && e.message ? e.message : e);
  process.exit(1);
});
