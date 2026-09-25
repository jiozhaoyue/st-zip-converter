/**
 * 包体检器 —— 列出数据包的一级目录构成与类目计数
 *
 * 用途：确认「导出/产出的包里到底装了什么」，尤其是**派生素材是否被排除**
 * （`backups/` 2.5 G 历史备份、`thumbnails/`、`vectors/` 等）。
 * 不信任「体积应该差不多」这类直觉 —— 直接读中央目录算账。
 *
 * 用法：node scripts/instance-sync/inspect-pack.cjs <pack.zip> [--top 20]
 */

const path = require('path');
const { createNodeIo } = require('./lib/node-zip-io.cjs');

function parseArgs(argv) {
  const out = { pack: '', top: 20 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--top') out.top = Number(argv[++i]) || 20;
    else if (!argv[i].startsWith('--')) out.pack = argv[i];
  }
  return out;
}

(async () => {
  const { pack, top } = parseArgs(process.argv.slice(2));
  if (!pack) {
    console.error('用法：node scripts/instance-sync/inspect-pack.cjs <pack.zip>');
    process.exit(2);
  }
  const io = await createNodeIo();
  const reader = await io.openReader(path.resolve(pack));

  const counts = new Map();
  const bytesMap = new Map();
  let total = 0;
  let totalBytes = 0;

  for await (const entry of reader.entries()) {
    total += 1;
    totalBytes += entry.uncompressedSize || 0;
    const segs = entry.fileName.split('/');
    const key = segs.length > 1 ? `${segs[0]}/` : '(根文件)';
    counts.set(key, (counts.get(key) || 0) + 1);
    bytesMap.set(key, (bytesMap.get(key) || 0) + (entry.uncompressedSize || 0));
    entry.skip();
  }
  await reader.close();

  console.log(`包：${path.basename(pack)}`);
  console.log(`条目总数 ${total} ｜ 未压缩总计 ${(totalBytes / 1048576).toFixed(1)} MB\n`);
  console.log('一级条目'.padEnd(38) + '条目数'.padStart(8) + '未压缩'.padStart(14));
  const rows = [...counts.entries()].sort((a, b) => (bytesMap.get(b[0]) || 0) - (bytesMap.get(a[0]) || 0));
  for (const [k, v] of rows.slice(0, top)) {
    console.log(k.padEnd(38) + String(v).padStart(8) + ((bytesMap.get(k) || 0) / 1048576).toFixed(1).padStart(11) + ' MB');
  }
  if (rows.length > top) console.log(`… 另有 ${rows.length - top} 个一级条目未列出`);
})().catch((e) => {
  console.error('体检失败：', e);
  process.exit(1);
});
