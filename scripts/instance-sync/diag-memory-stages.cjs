/**
 * 一次性诊断：定位「`openReader` 阶段就吃掉数百 MB」的内存归属
 *
 * 背景：诊断显示真源包刚进转换、落点仅 8.6 MB 时，主线程 `heapUsed` 已 ~735 MB。
 * 本脚本按阶段打点，判断该内存是否来自「源包被整读进内存」。
 *
 * 用法：
 *   node scripts/instance-sync/diag-memory-stages.cjs [--source <zip>] [--legacy]
 *
 * `--legacy`：改走产品 `zipIo.openReader('<path>')` 的**整读**路径（`fs.readFile`）作对照。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const { createNodeIo } = require('./lib/node-zip-io.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MB = (n) => (n / 1048576).toFixed(1);

function parseArgs(argv) {
  const out = { source: '', legacy: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--source') out.source = argv[++i] || '';
    else if (argv[i] === '--legacy') out.legacy = true;
  }
  return out;
}

function findLatestSource(downloadsDir) {
  const names = fs.readdirSync(downloadsDir).filter((n) => /^backup-real-luker-.*\.zip$/.test(n));
  if (!names.length) throw new Error('未找到 backup-real-luker-*.zip');
  names.sort();
  return path.join(downloadsDir, names[names.length - 1]);
}

function snap(tag) {
  const m = process.memoryUsage();
  console.log(`${tag.padEnd(46)} heapUsed=${MB(m.heapUsed).padStart(8)}MB`
    + ` heapTotal=${MB(m.heapTotal).padStart(8)}MB`
    + ` rss=${MB(m.rss).padStart(8)}MB`
    + ` external=${MB(m.external).padStart(7)}MB`
    + ` arrayBuffers=${MB(m.arrayBuffers).padStart(7)}MB`);
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const downloads = path.join(os.homedir(), 'Downloads');
  const source = args.source ? path.resolve(args.source) : findLatestSource(downloads);
  const size = fs.statSync(source).size;
  console.log(`源包：${path.basename(source)}（${MB(size)} MB）｜模式：${args.legacy ? 'legacy 整读' : '惰性 Blob'}\n`);

  snap('0 启动');
  const io = await createNodeIo();
  snap('1 createNodeIo（含 vendor zip.js 载入）');

  let reader;
  if (args.legacy) {
    const zipIoMod = await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'core', 'zip-io.js')).href);
    reader = await zipIoMod.zipIo.openReader(source);
  } else {
    reader = await io.openReader(source);
  }
  snap('2 openReader 返回（中央目录已解析）');

  let n = 0;
  for await (const e of reader.entries()) { n += 1; }
  snap(`3 遍历 ${n} 条 entries（未开任何数据流）`);

  if (n > 0) {
    const reader2 = args.legacy
      ? (await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'core', 'zip-io.js')).href)).zipIo
      : io;
    const r3 = await reader2.openReader(source);
    let i = 0;
    for await (const e of r3.entries()) {
      if (i >= 20) break;
      await e.read(); // 整条读入内存
      i += 1;
    }
    snap(`4 另开 reader 整条读前 ${i} 条`);
    await r3.close();
  }

  await reader.close();
  snap('5 close 后');
})().catch((e) => {
  console.error('诊断失败：', e);
  process.exit(1);
});
