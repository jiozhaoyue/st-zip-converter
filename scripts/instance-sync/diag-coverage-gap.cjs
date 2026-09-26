/**
 * 覆盖率差异定位器 —— 回答「为什么 T1 覆盖率不是 100%」
 *
 * `diff-report.cjs` 的报告只留**前 50 条**缺失样本，不足以看出模式（实测踩过：
 * 样本 50 条全是 `extensions/*\/.agent/**`，而缺失总数 1091，模式其实不在这 50 条里）。
 * 本脚本**算出完整差集并按二级目录聚合**，用于快速判断缺失是真失败还是比对口径问题。
 *
 * 用法：
 *   node scripts/instance-sync/diag-coverage-gap.cjs --pack <pack.zip> --target dev-luker [--list 30]
 *
 * 纪律：只读目标目录（readdir），不写 `Instance/**`。
 */

const fs = require('fs');
const path = require('path');

const { createNodeIo } = require('./lib/node-zip-io.cjs');
const { getInstance, userDirOf } = require('../../e2e/lib/instances.cjs');

function parseArgs(argv) {
  const out = { pack: '', target: '', list: 30 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--pack') out.pack = argv[++i] || '';
    else if (argv[i] === '--target') out.target = argv[++i] || '';
    else if (argv[i] === '--list') out.list = Number(argv[++i]) || 30;
  }
  return out;
}

/** 与 `diff-report.cjs` 的 normalize **保持逐字一致**，否则两边的判定会打架 */
function normalize(p) {
  let s = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  if (s.startsWith('data/default-user/')) s = s.slice('data/default-user/'.length);
  return s.replace(/\/+/g, '/').replace(/\/$/, '');
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pack || !args.target) {
    console.error('用法：node scripts/instance-sync/diag-coverage-gap.cjs --pack <pack.zip> --target <instanceId>');
    process.exit(2);
  }
  const inst = getInstance(args.target);
  const root = userDirOf(args.target);
  if (!root) throw new Error(`[${args.target}] 无磁盘用户目录`);

  const files = new Set();
  const rec = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rp = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) rec(path.join(dir, e.name), rp);
      else files.add(normalize(rp));
    }
  };
  rec(root, '');

  const io = await createNodeIo();
  const reader = await io.openReader(path.resolve(args.pack));
  const missing = [];
  let total = 0;
  for await (const e of reader.entries()) {
    if (e.fileName.endsWith('/')) { e.skip(); continue; }
    total += 1;
    const n = normalize(e.fileName);
    if (!files.has(n)) missing.push(n);
    e.skip();
  }
  await reader.close();

  console.log(`目标 ${args.target}：磁盘文件 ${files.size} 条`);
  console.log(`包 ${path.basename(args.pack)}：条目 ${total} 条`);
  console.log(`缺失 ${missing.length} 条（覆盖率 ${(((total - missing.length) / total) * 100).toFixed(3)}%）\n`);

  const lv2 = new Map();
  for (const x of missing) {
    const k = x.split('/').slice(0, 2).join('/');
    lv2.set(k, (lv2.get(k) || 0) + 1);
  }
  console.log('=== 缺失的二级目录分布（全部）===');
  for (const [k, v] of [...lv2.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(6)}  ${k}`);
  }

  console.log(`\n=== 缺失条目逐条（最多 ${args.list} 条）===`);
  for (const x of missing.slice(0, args.list)) console.log(`  ${x}`);
})().catch((e) => {
  console.error('定位器异常：', e && e.message ? e.message : e);
  process.exit(1);
});
