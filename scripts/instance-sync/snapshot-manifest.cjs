/**
 * 目标实例的**只读清单快照** —— 同步前的「改动前状态」取证
 *
 * 背景（`prd.md` R1.4 / AC-1b，`design.md` §6）：
 * 备份**只对 Real Luker 做了**（用户裁决 U-9），Dev Luker / Dev ST / Real ST **没有原生备份、
 * 没有回滚能力**。因此这三处必须至少留下**可复核的改动前状态**，好让同步之后能**精确报出**
 * 「哪些文件被覆盖了」——这是取证，不是回滚，但对「知道发生了什么」是必需的。
 *
 * 用法：
 *   node scripts/instance-sync/snapshot-manifest.cjs                     # 全部目标
 *   node scripts/instance-sync/snapshot-manifest.cjs --id dev-luker
 *
 * 产出：`<task>/research/pre-sync-manifest-<id>.json`
 *   { instance, userDir, takenAt, fileCount, totalBytes, files: { relPath: [size, mtimeMs] } }
 *
 * 纪律：
 *  - **纯只读**：只用 `readdir` + `stat`，不读内容、不写实例目录（I-1 / I-5）。
 *  - 该 JSON 落 `research/`，已被仓 `.gitignore` 的 `.trellis/tasks/**!/research/*.json` 规则排除
 *    （含真实目录名与用户数据特征，属 L1-MR-14 红线，**不得入库**）。
 */

const fs = require('fs');
const path = require('path');

const { INSTANCES, getInstance, userDirOf } = require('../../e2e/lib/instances.cjs');

const TASK_DIR = path.resolve(__dirname, '..', '..', '.trellis', 'tasks', '09-26-all-instance-data-sync-e2e');
const OUT_DIR = path.join(TASK_DIR, 'research');

/** 刻意跳过的目录：与「同源同步会覆盖什么」无关的巨量缓存/日志 */
const SKIP_DIRS = new Set(['_cache', '_webpack', '_errors', 'node_modules', '.git']);

function parseArgs(argv) {
  const out = { ids: [], out: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--id') out.ids.push(argv[++i] || '');
    else if (argv[i] === '--out') out.out = argv[++i] || '';
  }
  return out;
}

/** 递归遍历，返回 { relPath: [size, mtimeMs] }。只 stat、不读内容。 */
async function walk(rootDir) {
  const files = {};
  let fileCount = 0;
  let totalBytes = 0;

  const visited = new Set();
  async function rec(dir, rel) {
    let real;
    try { real = await fs.promises.realpath(dir); } catch { return; }
    if (visited.has(real)) return; // 防 junction 环（链接指回上层会造成无限递归）
    visited.add(real);

    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      // 用 **stat**（而非 lstat）以**跟随 junction / 符号链接**。踩坑记录：
      // `readdir(withFileTypes)` 的 `dirent.isDirectory()` 对 Windows junction 返回 **false**
      // （它只设 `isSymbolicLink()`），于是链接目录被当文件、其子树整片漏掉。
      // 2026-09-26 实测：目标实例 `extensions/ST-BgLoader` 是指向源码仓的 Junction，
      // 其下 **1090 条**因此漏进快照 —— 会让「零删除」判定出现看不见的盲区。
      // 详见 `diff-report.cjs` 的 `walkTarget` 注释。
      let st;
      try { st = await fs.promises.stat(abs); } catch { continue; }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        await rec(abs, relPath);
      } else if (st.isFile()) {
        files[relPath] = [st.size, Math.round(st.mtimeMs)];
        fileCount += 1;
        totalBytes += st.size;
      }
    }
  }

  await rec(rootDir, '');
  return { files, fileCount, totalBytes };
}

(async () => {
  const { ids, out: outFile } = parseArgs(process.argv.slice(2));
  const targets = ids.length ? ids : Object.keys(INSTANCES);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const id of targets) {
    const inst = getInstance(id);
    if (!inst.userDir) {
      console.log(`[${id}] 跳过：纯前端 Profile 存储，**没有磁盘用户数据目录**（无可快照对象）`);
      continue;
    }
    const dir = userDirOf(id);
    if (!fs.existsSync(dir)) {
      console.log(`[${id}] 跳过：${dir} 不存在`);
      continue;
    }
    const t0 = Date.now();
    const { files, fileCount, totalBytes } = await walk(dir);
    const payload = {
      instance: id,
      side: inst.side,
      host: inst.host,
      port: inst.port,
      userDir: dir,
      takenAt: new Date().toISOString(),
      fileCount,
      totalBytes,
      files,
    };
    // `--out` 仅对单个 id 有意义：用于**临拍一次**（如同步前/同步后各拍一份）而不覆盖既有基线。
    const outPath = (outFile && targets.length === 1)
      ? path.resolve(outFile)
      : path.join(OUT_DIR, `pre-sync-manifest-${id}.json`);
    fs.writeFileSync(outPath, JSON.stringify(payload), 'utf8');
    console.log(`[${id}] ${fileCount} 个文件 / ${(totalBytes / 1048576).toFixed(1)} MB`
      + ` / ${((Date.now() - t0) / 1000).toFixed(1)}s → ${path.basename(outPath)}`);
  }
})().catch((e) => {
  console.error('快照失败：', e);
  process.exit(1);
});
