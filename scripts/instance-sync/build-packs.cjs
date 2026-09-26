/**
 * 产包器 —— 从 Real Luker 的原生备份包派生各目标布局的数据包（Node 侧，无浏览器）
 *
 * 为什么用本仓 `convert()`：`design.md` §1 —— 「同源同步本身就在行使被验证的功能」，
 * 这正是用户原话「就是这个插件打包的内容」的字面实现。走 `options.io` 注入接缝
 * 用 `scripts/instance-sync/lib/node-zip-io.cjs`，**大包不进内存**。
 *
 * 用法：
 *   node scripts/instance-sync/build-packs.cjs                  # 自动取 Downloads 里最新的真源包
 *   node scripts/instance-sync/build-packs.cjs --source <zip> --out <dir>
 *   node scripts/instance-sync/build-packs.cjs --dry-only       # 只空转算账，不产包
 *
 * 产出（落 `--out`，默认 Downloads）：
 *   pack-luker-<stamp>.zip   目标 l   （Luker 目标直接用它做原生 restore-backup）
 *   pack-st-<stamp>.zip      目标 st  （ST 目标用；ST 无整包恢复，走浏览器导入）
 *   pack-tt-<stamp>.zip      目标 tt  （PT 用 M21 导入；TT 人工导入）
 *   以及 pack-build-readings.json（各目标的空转与实跑读数）
 *
 * 关键约定：**`includeBackups: false`** —— 用户裁决 U-4「同步时排除 `backups/`」。
 * 该值本就是 `convert()` 的默认值（`transform.js:240`），此处**显式写出**以免将来默认值变动时静默改变语义。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const { createNodeIo } = require('./lib/node-zip-io.cjs');

/**
 * 堆自举 —— **保险**，非常规必需。
 *
 * 历史（2026-09-26）：真源规模（1602.7 MB / 8683 条 → 619 MB / 7748 条）下转换的
 * 内存峰值曾达 **6.2 GB**，默认堆（实测上限 **4288 MB**）直接
 * `FATAL ERROR: Ineffective mark-compacts near heap limit`。
 *
 * **根因已修**（`convert()` 增加投递侧背压，`transform.js` 的 `WRITE_BATCH`）：
 * 「在飞」峰值从 **916 条**降到 **24 条**，heap 峰值 **6262 MB → 123 MB**，
 * 耗时 **182 s → 54.8 s**，**默认堆即可跑通**，产出不变（619.3 MB / 零条目丢失）。
 *
 * 故本自举阈值降到 4096 MB —— **低于默认堆上限，正常调用不会触发**；
 * 仅在调用方**显式**给了更小的堆（如 `--max-old-space-size=2048`）时才介入，
 * 免得直接撞上一堵没有解释的 OOM 墙。
 */
const v8 = require('v8');
const { spawnSync } = require('child_process');
const MIN_HEAP_MB = 4096;
if (!process.env.ST_ZIP_HEAP_BOOTSTRAPPED
    && v8.getHeapStatistics().heap_size_limit < MIN_HEAP_MB * 1048576) {
  const current = Math.round(v8.getHeapStatistics().heap_size_limit / 1048576);
  console.log(`[堆自举] 当前堆上限 ${current} MB < 需要 ${MIN_HEAP_MB} MB —— 以更大的堆重新拉起本脚本`);
  const r = spawnSync(
    process.execPath,
    [`--max-old-space-size=${MIN_HEAP_MB}`, __filename, ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, ST_ZIP_HEAP_BOOTSTRAPPED: '1' } },
  );
  process.exit(r.status === null ? 1 : r.status);
}

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TASK_DIR = path.join(REPO_ROOT, '.trellis', 'tasks', '09-26-all-instance-data-sync-e2e');
const RESEARCH_DIR = path.join(TASK_DIR, 'research');

function parseArgs(argv) {
  const out = { source: '', out: '', dryOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--source') out.source = argv[++i] || '';
    else if (argv[i] === '--out') out.out = argv[++i] || '';
    else if (argv[i] === '--dry-only') out.dryOnly = true;
  }
  return out;
}

/** 取 Downloads 里最新的真源备份包 */
function findLatestSource(downloadsDir) {
  const names = fs.readdirSync(downloadsDir).filter((n) => /^backup-real-luker-.*\.zip$/.test(n));
  if (!names.length) throw new Error(`在 ${downloadsDir} 未找到 backup-real-luker-*.zip`);
  names.sort();
  return path.join(downloadsDir, names[names.length - 1]);
}

const MB = (n) => (n / 1048576).toFixed(1);

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const downloads = path.join(os.homedir(), 'Downloads');
  const source = args.source ? path.resolve(args.source) : findLatestSource(downloads);
  const outDir = args.out ? path.resolve(args.out) : downloads;
  if (!fs.existsSync(source)) throw new Error(`源包不存在：${source}`);
  fs.mkdirSync(outDir, { recursive: true });

  const transformMod = await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'core', 'transform.js')).href);
  const { convert, TARGETS } = transformMod;
  const io = await createNodeIo();

  const sourceBytes = fs.statSync(source).size;
  console.log(`源包：${path.basename(source)}（${MB(sourceBytes)} MB）`);
  console.log(`输出：${outDir}`);

  const stamp = (path.basename(source).match(/(\d{8}-\d{6})/) || [, 'nodate'])[1];
  const plan = [
    { target: TARGETS.L, name: `pack-luker-${stamp}.zip`, purpose: 'Luker 目标（原生 restore-backup）' },
    { target: TARGETS.ST, name: `pack-st-${stamp}.zip`, purpose: 'ST 目标（浏览器逐类目导入）' },
    { target: TARGETS.TT, name: `pack-tt-${stamp}.zip`, purpose: 'PT M21 导入 / TT 人工导入' },
  ];

  const readings = { source, sourceBytes, stamp, startedAt: new Date().toISOString(), targets: {} };

  for (const item of plan) {
    // —— 空转算账 ——
    const t0 = Date.now();
    const dry = await convert(source, path.join(outDir, item.name), {
      target: item.target,
      dryRun: true,
      includeBackups: false,
      io,
    });
    const dryJson = dry.toJSON();
    const drySecs = (Date.now() - t0) / 1000;
    console.log(`\n[${item.target}] 空转：copied=${dryJson.totals.copied} `
      + `dropped=${dryJson.totals.dropped} filtered=${dryJson.totals.filtered} `
      + `synthesized=${dryJson.totals.synthesized} warnings=${dryJson.totals.warnings}`
      + `（${drySecs.toFixed(1)}s）`);

    readings.targets[item.target] = {
      name: item.name,
      purpose: item.purpose,
      dryRun: {
        elapsedSeconds: Number(drySecs.toFixed(1)),
        totals: dryJson.totals,
        modules: dryJson.modules,
        warnings: dryJson.warnings.slice(0, 20),
        dropped: dryJson.dropped.slice(0, 20),
      },
    };

    if (args.dryOnly) continue;

    // —— 实跑产包 ——
    // 先写 `.partial`，成功后再改名：中断/失败不会在 Downloads 里留下
    // 「看着像真包、其实是半截/空条目」的文件（首轮实跑就踩过：8.6 MB 的坏包被误当产物）。
    const outPath = path.join(outDir, item.name);
    const partialPath = `${outPath}.partial`;
    const t1 = Date.now();
    const rep = await convert(source, partialPath, {
      target: item.target,
      includeBackups: false,
      io,
    });
    const secs = (Date.now() - t1) / 1000;
    fs.renameSync(partialPath, outPath);
    const bytes = fs.statSync(outPath).size;
    const repJson = rep.toJSON();
    console.log(`[${item.target}] 产包 ${item.name}：${MB(bytes)} MB / `
      + `copied=${repJson.totals.copied} / 耗时 ${secs.toFixed(1)}s`);

    readings.targets[item.target].output = {
      file: item.name,
      bytes,
      entryCountCopied: repJson.totals.copied,
      dropped: repJson.totals.dropped,
      warnings: repJson.totals.warnings,
      elapsedSeconds: Number(secs.toFixed(1)),
      totals: repJson.totals,
    };
  }

  readings.finishedAt = new Date().toISOString();
  fs.mkdirSync(RESEARCH_DIR, { recursive: true });
  const readingsPath = path.join(RESEARCH_DIR, 'pack-build-readings.json');
  fs.writeFileSync(readingsPath, JSON.stringify(readings, null, 2), 'utf8');
  console.log(`\n读数 → ${readingsPath}`);
})().catch((e) => {
  console.error('产包失败：', e);
  process.exit(1);
});
