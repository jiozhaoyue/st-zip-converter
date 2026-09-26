/**
 * 一次性诊断：真源包规模下 `convert()` 的内存去向
 *
 * 目的：缺陷 E（真源包全量转换 OOM）的成因定位。**不改产品代码** ——
 * 只在 `options.io` 接缝外再包一层计数/打点，观察「投递 / 完成 / 在飞」随时间的变化，
 * 以及 RSS / heap / 落点字节的对应关系。
 *
 * 用法：
 *   node scripts/instance-sync/diag-convert-memory.cjs [--source <zip>] [--target l]
 *                                                     [--interval 5000] [--limit N]
 *
 * `--limit N` 只投递前 N 条（用于观察「条目数与内存」的关系，默认全量）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const { createNodeIo } = require('./lib/node-zip-io.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MB = (n) => (n / 1048576).toFixed(1);

function parseArgs(argv) {
  const out = { source: '', target: 'l', interval: 5000, hw: 0, maxSec: 0, out: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--source') out.source = argv[++i] || '';
    else if (argv[i] === '--target') out.target = argv[++i] || 'l';
    else if (argv[i] === '--interval') out.interval = Number(argv[++i]) || 5000;
    else if (argv[i] === '--hw') out.hw = Number(argv[++i]) || 0;
    else if (argv[i] === '--max-sec') out.maxSec = Number(argv[++i]) || 0;
    else if (argv[i] === '--out') out.out = argv[++i] || '';
  }
  return out;
}

/**
 * 伪造 `navigator.hardwareConcurrency`。
 *
 * 产品 `zip-io.js:19/23` 用该值同时决定**并发窗口**（`CONCURRENCY`）与
 * **zip.js worker 池上限**（`maxWorkers = Math.max(4, HW)`）。Node 24 上该值 = 物理核数，
 * 本机为 **20** ⇒ zip.js 会开 20 个 worker。
 *
 * 必须在**导入产品模块之前**设置：产品在模块顶层就 `zip.configure(...)` 并把
 * `CONCURRENCY`/`HW` 算成模块级常量。这是**不改产品代码**做对照实验的抓手。
 */
function fakeHardwareConcurrency(hw) {
  if (!hw) return;
  Object.defineProperty(globalThis.navigator, 'hardwareConcurrency', { value: hw, configurable: true });
}

function findLatestSource(downloadsDir) {
  const names = fs.readdirSync(downloadsDir).filter((n) => /^backup-real-luker-.*\.zip$/.test(n));
  if (!names.length) throw new Error(`在 ${downloadsDir} 未找到 backup-real-luker-*.zip`);
  names.sort();
  return path.join(downloadsDir, names[names.length - 1]);
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const downloads = path.join(os.homedir(), 'Downloads');
  const source = args.source ? path.resolve(args.source) : findLatestSource(downloads);
  const outDir = args.out ? path.resolve(args.out) : downloads;

  // ⚠️ 必须在导入产品模块**之前**：产品在顶层读该值并 configure zip.js
  fakeHardwareConcurrency(args.hw);
  console.log(`[配置] hardwareConcurrency=${args.hw || '(真实值)'}`
    + `  ⇒ 产品 CONCURRENCY=${Math.max(2, Math.min(8, args.hw || 6))}`
    + ` / zip maxWorkers=${Math.max(4, args.hw || 4)}`
    + (args.maxSec ? ` ｜ 最长观察 ${args.maxSec}s` : ''));

  const transformMod = await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'core', 'transform.js')).href);
  const { convert, TARGETS } = transformMod;
  const baseIo = await createNodeIo();

  const stats = {
    addCalls: 0, addBytes: 0,
    lazyCalls: 0, lazyBytes: 0,
    addSettled: 0, lazySettled: 0,
    addInflight: 0, lazyInflight: 0,
    addMaxInflight: 0, lazyMaxInflight: 0,
    lastLazyName: '',
  };

  /** 包装 handle：计数 + 追踪在飞（不改语义，返回值原样透传） */
  function wrapHandle(handle, partialPath) {
    const origAdd = handle.add.bind(handle);
    const origLazy = handle.addLazy.bind(handle);

    handle.add = async (name, data) => {
      stats.addCalls += 1;
      stats.addBytes += (data && (data.byteLength ?? data.length)) || 0;
      stats.addInflight += 1;
      if (stats.addInflight > stats.addMaxInflight) stats.addMaxInflight = stats.addInflight;
      try {
        return await origAdd(name, data);
      } finally {
        stats.addInflight -= 1;
        stats.addSettled += 1;
      }
    };

    handle.addLazy = (name, openFn, byteSize = 0) => {
      stats.lazyCalls += 1;
      stats.lazyBytes += byteSize || 0;
      stats.lastLazyName = name;
      stats.lazyInflight += 1;
      if (stats.lazyInflight > stats.lazyMaxInflight) stats.lazyMaxInflight = stats.lazyInflight;
      const p = origLazy(name, openFn, byteSize);
      // addLazy 返回 promise：settle 即在飞减一
      return Promise.resolve(p).finally(() => {
        stats.lazyInflight -= 1;
        stats.lazySettled += 1;
      });
    };

    handle._partialPath = partialPath;
    return handle;
  }

  const io = {
    async openReader(s) { return baseIo.openReader(s); },
    async createWriter(dest, options = {}) {
      const handle = await baseIo.createWriter(dest, options);
      return wrapHandle(handle, typeof dest === 'string' ? dest : '(blob)');
    },
  };

  const partialPath = path.join(outDir, `diag-partial-${args.target}.zip.partial`);
  const finalPath = path.join(outDir, `diag-partial-${args.target}.zip`);

  const targetMap = { l: TARGETS.L, st: TARGETS.ST, tt: TARGETS.TT, pt: TARGETS.PT };
  const target = targetMap[args.target] || TARGETS.L;

  let done = false;
  const t0 = Date.now();
  let lastLazySettled = 0;
  let stalledSince = null;

  const timer = setInterval(() => {
    const el = ((Date.now() - t0) / 1000).toFixed(0);
    const mu = process.memoryUsage();
    let bytes = 0;
    try { bytes = fs.statSync(partialPath).size; } catch { /* 未创建 */ }
    const rate = (stats.lazySettled - lastLazySettled) / (args.interval / 1000);
    lastLazySettled = stats.lazySettled;
    if (rate === 0) { if (!stalledSince) stalledSince = Date.now(); } else { stalledSince = null; }
    const stallTag = stalledSince ? ` ⛔停滞${((Date.now() - stalledSince) / 1000).toFixed(0)}s` : '';
    console.log(
      `[T+${el}s] 落点=${MB(bytes)}MB | heap=${MB(mu.heapUsed)}/${MB(mu.heapTotal)}MB rss=${MB(mu.rss)}MB`
      + ` | lazy 投递=${stats.lazyCalls} 完成=${stats.lazySettled} 在飞=${stats.lazyInflight}`
      + ` 峰值=${stats.lazyMaxInflight} | add 投递=${stats.addCalls} 完成=${stats.addSettled}`
      + ` | ${rate.toFixed(1)}条/s${stallTag}`,
    );
  }, args.interval);
  timer.unref?.();

  // 有界观察：到点打印可对比的关键指标后强制退出（诊断用，产物残缺、另行清理）
  if (args.maxSec) {
    setTimeout(() => {
      const mu = process.memoryUsage();
      let bytes = 0;
      try { bytes = fs.statSync(partialPath).size; } catch { /* ignore */ }
      const secs = (Date.now() - t0) / 1000;
      console.log(`\n===== 截断读数（T+${secs.toFixed(0)}s，上限 ${args.maxSec}s）=====`);
      console.log(`hw=${args.hw || 'real'} 落点=${MB(bytes)}MB 吞吐=${(bytes / 1048576 / secs).toFixed(2)}MB/s`);
      console.log(`lazy 投递=${stats.lazyCalls} 完成=${stats.lazySettled} 在飞=${stats.lazyInflight} 峰值=${stats.lazyMaxInflight}`);
      console.log(`rss=${MB(mu.rss)}MB heapUsed=${MB(mu.heapUsed)}MB`);
      console.log('（进程强制退出，剩余转换未完成）');
      process.exit(0);
    }, args.maxSec * 1000);
  }

  const t1 = Date.now();
  try {
    const rep = await convert(source, partialPath, {
      target,
      includeBackups: false,
      io,
    });
    done = true;
    const secs = (Date.now() - t1) / 1000;
    let bytes = 0;
    try { bytes = fs.statSync(partialPath).size; } catch { /* ignore */ }
    console.log(`\n✅ 转换完成：${secs.toFixed(1)}s / 落点 ${MB(bytes)} MB / copied=${rep.toJSON().totals.copied}`);
    fs.renameSync(partialPath, finalPath);
  } catch (e) {
    console.error(`\n❌ 转换失败（${((Date.now() - t1) / 1000).toFixed(1)}s）：`, e && e.message ? e.message : e);
  } finally {
    clearInterval(timer);
    const mu = process.memoryUsage();
    console.log('\n=== 汇总结算 ===');
    console.log(`投递：add ${stats.addCalls} 条 / ${MB(stats.addBytes)} MB ；addLazy ${stats.lazyCalls} 条 / ${MB(stats.lazyBytes)} MB`);
    console.log(`完成：add ${stats.addSettled} ；addLazy ${stats.lazySettled}`
      + `  ⇒ 未完成 ${stats.lazyCalls - stats.lazySettled}`);
    console.log(`在飞峰值：add ${stats.addMaxInflight} ；addLazy ${stats.lazyMaxInflight}`);
    console.log(`最终 rss=${MB(mu.rss)}MB heapUsed=${MB(mu.heapUsed)}MB`);
    console.log(`最后投递条目：${stats.lastLazyName}`);
    console.log(done ? '（进程将正常退出）' : '（转换未完成 —— 进程可能因事件循环空转而静默退出）');
  }
})().catch((e) => {
  console.error('诊断脚本失败：', e);
  process.exit(1);
});
