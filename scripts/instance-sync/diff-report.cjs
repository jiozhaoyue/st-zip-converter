/**
 * 差异核对器 —— 「覆盖同名、不删独有」的可复核证据（`implement.md` 3.1）
 *
 * 三张表（对应 AC-2 / AC-3）：
 *   T1 **包→目标覆盖率**：目标包的**每一条条目**都必须在目标实例里存在 → 必须 100%
 *   T2 **目标独有存活**：同步前登记的目标独有条目，同步后**仍在** → 零删除
 *   T3 **内容量**：角色卡 / 聊天 / 世界书等类目计数（供 AC-3 对照）
 *
 * 为什么 T1 拿**包**而不是拿原始源目录做基准：
 * `convert()` 会按目标**设计内丢弃**一部分条目（如 L 目标丢弃 `image-metadata.json`、
 * 派生缓存 `thumbnails/`/`backups/`/`vectors/`），所以「源目录 → 目标」本就不该 100%。
 * 真正的不变量是「**产出的包 → 目标**」必须 100% —— 这才是「同步成功」的定义。
 *
 * 用法：
 *   node scripts/instance-sync/diff-report.cjs --pack <pack.zip> --target <instanceId> \
 *        [--unique-manifest <pre-sync-unique.json>] [--out <report.json>]
 *
 * 纪律：**只读**目标目录（stat/readdir），不写 `Instance/**`。
 */

const fs = require('fs');
const path = require('path');

const { createNodeIo } = require('./lib/node-zip-io.cjs');
const { getInstance, userDirOf } = require('../../e2e/lib/instances.cjs');

const TASK_DIR = path.resolve(__dirname, '..', '..', '.trellis', 'tasks', '09-26-all-instance-data-sync-e2e');
const RESEARCH_DIR = path.join(TASK_DIR, 'research');

/** 归一化：去掉可能的 `data/default-user/` 前缀与 `./`，统一分隔符 */
function normalize(p) {
  let s = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  if (s.startsWith('data/default-user/')) s = s.slice('data/default-user/'.length);
  return s.replace(/\/+/g, '/').replace(/\/$/, '');
}

function parseArgs(argv) {
  const out = { pack: '', target: '', unique: '', preManifest: '', out: '', extraRoot: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--pack') out.pack = argv[++i] || '';
    else if (argv[i] === '--target') out.target = argv[++i] || '';
    else if (argv[i] === '--unique-manifest') out.unique = argv[++i] || '';
    else if (argv[i] === '--pre-manifest') out.preManifest = argv[++i] || '';
    else if (argv[i] === '--extra-root') out.extraRoot = argv[++i] || '';
    else if (argv[i] === '--out') out.out = argv[++i] || '';
  }
  return out;
}

/**
 * 解析 `--extra-root`：`<绝对路径>:<条目前缀>`（Windows 盘符里的 `:` 需用最后一个 `:` 切分）。
 *
 * 用途：ST 的 `extensions/` **不落在用户数据目录下** —— 它的原生位置是
 * `<inst>/public/scripts/extensions/third-party/`。若只扫 `userDir`，那 5204 条会被判「缺失」，
 * 覆盖率被误报成 22%（2026-09-26 实测）。加上额外根后按 `extensions/<rel>` 归一，才与实际一致。
 *
 * @returns {{root:string, prefix:string}|null}
 */
function parseExtraRoot(spec) {
  if (!spec) return null;
  const idx = spec.lastIndexOf(':');
  if (idx <= 1) return null; // 无前缀或盘符解析失败
  return { root: spec.slice(0, idx), prefix: spec.slice(idx + 1).replace(/\/+$/, '') };
}

/**
 * 目标当前的文件清单（只 stat，不读内容）。
 *
 * ⚠️ **必须跟随 junction/符号链接**：`readdir(withFileTypes)` 的 `dirent.isDirectory()`
 * 对 Windows junction **返回 false**（它是 reparse point，`isSymbolicLink()` 才为 true），
 * 于是链接目录会被当成**文件**、其子树被整片漏掉。
 *
 * 2026-09-26 实测踩过：目标实例的 `extensions/ST-BgLoader` 是指向
 * `D:\Repo\Tavern-repo\My-repo\ST-BgLoader` 的 **Junction**（开发者把扩展链到源码仓），
 * 该目录下 **1090 条**全部漏统计 ⇒ 覆盖率被误报成 **84.805%**，
 * 而服务端回执是 `failedCount=0`、文件实际都在。**这是测量口径的 bug，不是同步失败。**
 *
 * 用 `realpath` 去重防循环（junction 指回上层会造成无限递归）。
 */
async function walkTarget(rootDir) {
  const files = new Set();
  const sizes = new Map();
  const visited = new Set();
  async function rec(dir, rel) {
    let real;
    try { real = await fs.promises.realpath(dir); } catch { return; }
    if (visited.has(real)) return; // 防 junction 环
    visited.add(real);

    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const ent of entries) {
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      const abs = path.join(dir, ent.name);
      let st;
      // stat（而非 lstat）⇒ 跟随链接；断链/无权限项跳过而非中断整次遍历
      try { st = await fs.promises.stat(abs); } catch { continue; }
      if (st.isDirectory()) await rec(abs, relPath);
      else if (st.isFile()) {
        files.add(normalize(relPath));
        sizes.set(normalize(relPath), st.size);
      }
    }
  }
  await rec(rootDir, '');
  return { files, sizes };
}

/** 包内条目名清单（跳过目录占位与合成 manifest） */
async function packEntries(packPath) {
  const io = await createNodeIo();
  const reader = await io.openReader(packPath);
  const names = [];
  for await (const entry of reader.entries()) {
    if (entry.fileName.endsWith('/')) { entry.skip(); continue; }
    names.push(normalize(entry.fileName));
    entry.skip();
  }
  await reader.close();
  return names;
}

/** 按类目计数（粗粒度，供 AC-3 对照） */
function categorize(names) {
  const cat = { characters: 0, chats: 0, worlds: 0, groups: 0, themes: 0, backgrounds: 0, extensions: 0, other: 0 };
  for (const n of names) {
    if (n.startsWith('characters/')) cat.characters += 1;
    else if (n.startsWith('chats/')) cat.chats += 1;
    else if (n.startsWith('worlds/')) cat.worlds += 1;
    else if (n.startsWith('groups/')) cat.groups += 1;
    else if (n.startsWith('themes/')) cat.themes += 1;
    else if (n.startsWith('backgrounds/')) cat.backgrounds += 1;
    else if (n.startsWith('extensions/')) cat.extensions += 1;
    else cat.other += 1;
  }
  return cat;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pack || !args.target) {
    console.error('用法：node scripts/instance-sync/diff-report.cjs --pack <pack.zip> --target <instanceId>');
    process.exit(2);
  }
  const inst = getInstance(args.target);
  if (!inst.userDir) {
    console.error(`[${args.target}] 纯前端 Profile 存储，无磁盘目录可比对 —— 本表不适用`);
    process.exit(2);
  }
  const targetRoot = userDirOf(args.target);

  const [entries, target] = await Promise.all([
    packEntries(path.resolve(args.pack)),
    walkTarget(targetRoot),
  ]);

  // 额外扫描根：把落在**用户数据目录之外**的类目并入目标文件集。
  // ST 的 `extensions/` 就是一例 —— 它的原生位置是
  // `<inst>/public/scripts/extensions/third-party/`，不属于 `userDir`。
  const extra = parseExtraRoot(args.extraRoot);
  if (extra) {
    if (fs.existsSync(extra.root)) {
      const ex = await walkTarget(extra.root);
      for (const f of ex.files) target.files.add(`${extra.prefix}/${f}`);
      console.log(`[额外根] ${extra.root} → 以 ${extra.prefix}/ 前缀并入 ${ex.files.size} 条`);
    } else {
      console.log(`[额外根] 跳过（不存在）：${extra.root}`);
    }
  }

  const packSet = new Set(entries);
  const missingAll = [...packSet].filter((n) => !target.files.has(n));

  /**
   * **合成元数据**：`convert()` 为目标合成、但**宿主按设计不消费**的条目。
   * Luker 的 restore 会以 `path_not_in_selected_categories` 显式跳过它们
   * （2026-09-26 实测回执：`skippedCount=2`，正是 `manifest.json` 与
   * `_convert/extensions-manifest.json`）。
   *
   * 单列出来、**不计入覆盖率判定** —— 否则 T1 永远到不了 100%，
   * 一个恒假的判定等于没有判定。
   */
  const isHostMetadata = (n) => n.startsWith('_convert/') || n === 'manifest.json';
  const missingHostMetadata = missingAll.filter(isHostMetadata);
  const missing = missingAll.filter((n) => !isHostMetadata(n));
  const coverage = packSet.size ? (packSet.size - missing.length) / packSet.size : 1;

  // T2：同步前的目标独有清单，同步后是否仍在
  let uniqueCheck = null;
  if (args.unique && fs.existsSync(args.unique)) {
    const uniq = JSON.parse(fs.readFileSync(args.unique, 'utf8'));
    const list = Array.isArray(uniq) ? uniq : (uniq.unique || []);
    const gone = list.filter((n) => !target.files.has(normalize(n)));
    uniqueCheck = { declared: list.length, stillPresent: list.length - gone.length, deleted: gone.slice(0, 50) };
  }

  // T2b：同步前的**全量**只读清单（`snapshot-manifest.cjs` 的 `{files: {path: [size, mtime]}}` 形态），
  // 同步后必须**一条不少**。merge 语义下任何删除都是违规，故这条比「只看目标独有」更强、
  // 也更省事 —— 无需先算出「独有」子集，直接断言「同步前的文件路径集合 ⊆ 同步后的」。
  let preManifestCheck = null;
  if (args.preManifest && fs.existsSync(args.preManifest)) {
    const pre = JSON.parse(fs.readFileSync(args.preManifest, 'utf8'));
    const keysAll = pre.files ? Object.keys(pre.files) : [];
    /**
     * `backups/` **单列**：用户裁决 U-4 明确「同步时排除 `backups/`」，而宿主 Luker
     * 每次恢复前都会自动备份 settings 并**轮换**（2026-09-26 实测两次 restore 各删掉
     * 一条最旧的 `backups/settings_<user>_<时间>.json`）。把它算进「零删除」判定会让判定恒假，
     * 而它根本不在同步范围内 —— 这是宿主自身的行为，不是同步删的。
     */
    const isBackups = (n) => normalize(n).startsWith('backups/');
    const keys = keysAll.filter((n) => !isBackups(n));
    const goneAll = keysAll.filter((n) => !target.files.has(normalize(n)));
    const gone = goneAll.filter((n) => !isBackups(n));
    preManifestCheck = {
      manifest: args.preManifest,
      takenAt: pre.takenAt || null,
      declared: keys.length,
      stillPresent: keys.length - gone.length,
      deletedCount: gone.length,
      deletedSample: gone.slice(0, 50),
      /** 宿主自行轮换掉的 `backups/` 项（不参与判定，仅登记） */
      hostRotatedBackups: goneAll.filter(isBackups),
    };
  }

  // 同步前目标就有的、包里没有的（这些就是「独有」，必须活下来）
  const targetUnique = [...target.files].filter((n) => !packSet.has(n));

  const report = {
    target: args.target,
    targetRoot,
    pack: path.resolve(args.pack),
    takenAt: new Date().toISOString(),
    T1_packCoverage: {
      packEntries: packSet.size,
      presentInTarget: packSet.size - missing.length,
      missingCount: missing.length,
      coverage: Number(coverage.toFixed(6)),
      pass: missing.length === 0,
      /** 只列前 50 条，避免报告无限膨胀 */
      missingSample: missing.slice(0, 50),
      /** 合成元数据（宿主按设计跳过）：单列，不参与 pass 判定 */
      hostMetadataSkipped: {
        count: missingHostMetadata.length,
        entries: missingHostMetadata,
      },
    },
    T2_targetUnique: {
      count: targetUnique.length,
      sample: targetUnique.slice(0, 50),
      deletionCheck: uniqueCheck,
      preManifestCheck,
    },
    T3_content: {
      pack: categorize(entries),
      target: categorize([...target.files]),
    },
    targetFileCount: target.files.size,
  };

  const outPath = args.out
    ? path.resolve(args.out)
    : path.join(RESEARCH_DIR, `diff-${args.target}-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(`[${args.target}] T1 包→目标覆盖率 ${(coverage * 100).toFixed(3)}%`
    + `（${packSet.size - missing.length}/${packSet.size}，缺 ${missing.length}）`
    + ` ${missing.length === 0 ? '✅' : '❌'}`);
  if (missingHostMetadata.length) {
    console.log(`[${args.target}] T1b 合成元数据 ${missingHostMetadata.length} 条`
      + `（宿主按设计跳过，不计入判定）：${missingHostMetadata.join(', ')}`);
  }
  console.log(`[${args.target}] T2 目标独有 ${targetUnique.length} 条`
    + (uniqueCheck ? `，其中声明独有 ${uniqueCheck.declared} 条 / 被删 ${uniqueCheck.deleted.length} 条`
      + ` ${uniqueCheck.deleted.length === 0 ? '✅' : '❌'}` : '（未提供独有清单）'));
  if (preManifestCheck) {
    console.log(`[${args.target}] T2b 同步前全量清单 ${preManifestCheck.declared} 条`
      + ` → 现存 ${preManifestCheck.stillPresent} 条 / 被删 ${preManifestCheck.deletedCount} 条`
      + ` ${preManifestCheck.deletedCount === 0 ? '✅ 零删除' : '❌'}`);
    if (preManifestCheck.deletedCount) {
      console.log(`       被删样本：${preManifestCheck.deletedSample.slice(0, 5).join(' | ')}`);
    }
    if (preManifestCheck.hostRotatedBackups.length) {
      console.log(`[${args.target}] T2c 宿主自行轮换的 backups/ ${preManifestCheck.hostRotatedBackups.length} 条`
        + `（不在同步范围，不计入判定）：${preManifestCheck.hostRotatedBackups.slice(0, 3).join(', ')}`);
    }
  }
  console.log(`[${args.target}] T3 包内 角色卡 ${report.T3_content.pack.characters}`
    + ` / 聊天 ${report.T3_content.pack.chats} / 世界书 ${report.T3_content.pack.worlds}`
    + `　目标 角色卡 ${report.T3_content.target.characters}`
    + ` / 聊天 ${report.T3_content.target.chats} / 世界书 ${report.T3_content.target.worlds}`);
  console.log(`报告 → ${outPath}`);

  if (missing.length) process.exitCode = 1;
  if (preManifestCheck && preManifestCheck.deletedCount) process.exitCode = 1;
})().catch((e) => {
  console.error('核对失败：', e);
  process.exit(1);
});
