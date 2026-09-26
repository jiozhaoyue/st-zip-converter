/**
 * 差异核对器 —— 「覆盖同名、不删独有」的可复核证据（`implement.md` 3.1）
 *
 * 三张表（对应 AC-2 / AC-3）：
 *   T1 **包→目标覆盖率**：目标包的**每一条条目**都必须在目标实例里存在 → 必须 100%
 *      ⚠️ 判定分两步（`lib/t1-coverage.cjs`）：**先路径命中**；ST 目标上再**按宿主落盘名**复核一次
 *      （ST 的角色卡一律落成 `characters/<角色名>.png`，与包内内容寻址名不可能逐字相同 ——
 *      2026-09-26 实测：只用路径口径会把 100% 误报成 94.75%）。
 *      两类条目**单列不判**：合成元数据（`_convert/**`、`manifest.json`）、
 *      Luker 私有状态（`characters/*.state.*.json`）。
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
const {
  normalize,
  isHostMetadata,
  isHostPrivate,
  compareCoverage,
  stCharacterNameMap,
  classifyPreManifestDeletions,
} = require('./lib/t1-coverage.cjs');
const { getInstance, userDirOf } = require('../../e2e/lib/instances.cjs');

const TASK_DIR = path.resolve(__dirname, '..', '..', '.trellis', 'tasks', '09-26-all-instance-data-sync-e2e');
const RESEARCH_DIR = path.join(TASK_DIR, 'research');

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
 *
 * **同时记录链接目录**（`links`）：落在链接子树里的文件其实是**别人的工作区**，
 * 会被对方仓随时改动 ⇒ T1 对这部分只能「报而不断」（见 `lib/t1-coverage.cjs` 的 `linkedRoots`）。
 */
async function walkTarget(rootDir) {
  const files = new Set();
  const sizes = new Map();
  const links = [];
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
      if (st.isDirectory()) {
        // junction / 符号链接指向目录：登记为链接根（Windows junction 的 `isDirectory()` 为 false，
        // 但**跟随之后**的 stat 会给出目录 —— 故判据放在 stat 之后）
        if (ent.isSymbolicLink()) links.push(normalize(relPath));
        await rec(abs, relPath);
      } else if (st.isFile()) {
        files.add(normalize(relPath));
        sizes.set(normalize(relPath), st.size);
      }
    }
  }
  await rec(rootDir, '');
  return { files, sizes, links };
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

  const packPath = path.resolve(args.pack);
  const [entries, target, stMap] = await Promise.all([
    packEntries(packPath),
    walkTarget(targetRoot),
    /**
     * ST 目标才需要**宿主命名规则**（角色卡落盘名与包内路径不同）。
     * Luker 目标按路径即可 —— 它的原生存储就是包内那套内容寻址 blob。
     */
    inst.host === 'st' ? stCharacterNameMap(packPath) : Promise.resolve(null),
  ]);

  // 额外扫描根：把落在**用户数据目录之外**的类目并入目标文件集。
  // ST 的 `extensions/` 就是一例 —— 它的原生位置是
  // `<inst>/public/scripts/extensions/third-party/`，不属于 `userDir`。
  const linkedRoots = [...target.links];
  const extra = parseExtraRoot(args.extraRoot);
  if (extra) {
    if (fs.existsSync(extra.root)) {
      const ex = await walkTarget(extra.root);
      for (const f of ex.files) target.files.add(`${extra.prefix}/${f}`);
      for (const l of ex.links) linkedRoots.push(`${extra.prefix}/${l}`);
      console.log(`[额外根] ${extra.root} → 以 ${extra.prefix}/ 前缀并入 ${ex.files.size} 条`);
    } else {
      console.log(`[额外根] 跳过（不存在）：${extra.root}`);
    }
  }
  if (linkedRoots.length) {
    console.log(`[链接目录] ${linkedRoots.length} 个（其内容属外部工作区，随之漂移，只报不判）：`
      + linkedRoots.slice(0, 5).join(', '));
  }

  const packSet = new Set(entries);

  /**
   * T1 判定 —— **核心逻辑在 `lib/t1-coverage.cjs`**（先路径、后宿主命名规则；
   * 合成元数据、Luker 私有状态、链接目录三类单列）。抽出去是为了**可单测**：
   * 这条判定是 AC-2 的唯一证据来源，埋在 CLI 里只能靠人肉读代码发现错误
   * （本仓纪律：「先证明判定会报差异，再相信它报 100%」）。
   */
  const t1 = compareCoverage({
    entries: packSet,
    targetFiles: target.files,
    stNameMap: stMap ? stMap.entryToName : null,
    linkedRoots,
  });
  const {
    missing, missingLinked, missingHostMetadata, missingHostPrivate, nameRuleHits, denominator,
  } = t1;
  const coverage = denominator ? (denominator - missing.length) / denominator : 1;

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
    const goneAll = keysAll.filter((n) => !target.files.has(normalize(n)));

    /**
     * **宿主自管缓存单列**（判定见 `lib/t1-coverage.cjs` 的 `HOST_MANAGED_CACHE`）：
     * `backups/`（Luker restore 前轮换）与 `thumbnails/`（ST 导入成功即失效，可重建）。
     * 两者都**不参与「零删除」判定**，但都**原样登记** ——
     * 不判定 ≠ 不报告：读数里必须看得见它们，否则「零删除」就成了自己给自己开脱。
     */
    const { real: gone, hostManaged } = classifyPreManifestDeletions(goneAll.map(normalize));
    const excused = new Set(hostManaged.flatMap((r) => r.entries));
    const keys = keysAll.filter((n) => !excused.has(normalize(n)));

    preManifestCheck = {
      manifest: args.preManifest,
      takenAt: pre.takenAt || null,
      declared: keys.length,
      stillPresent: keys.length - gone.length,
      deletedCount: gone.length,
      deletedSample: gone.slice(0, 50),
      /** 宿主自管缓存（不参与判定，仅登记）：前缀 / 原因 / 条目 */
      hostManagedCache: hostManaged.filter((r) => r.entries.length),
      /** 兼容旧字段：宿主轮换掉的 `backups/` 项 */
      hostRotatedBackups: (hostManaged.find((r) => r.prefix === 'backups/') || { entries: [] }).entries,
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
      rule: stMap ? 'path+st-character-name' : 'path',
      /** 按宿主命名规则（而非包内路径）命中的条目数 —— 见 `stCharacterNameMap` */
      nameRuleHits,
      packEntries: packSet.size,
      denominator,
      presentInTarget: denominator - missing.length,
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
      /** Luker 私有状态（ST 无对应机制）：单列，不参与 pass 判定 */
      hostPrivateSkipped: {
        count: missingHostPrivate.length,
        entries: missingHostPrivate.slice(0, 20),
      },
      /**
       * **链接目录内的缺失**：目标侧 junction / 符号链接把别人的活工作区挂进了实例目录，
       * 那部分随对方仓漂移、与同步无关 ⇒ 单列（只报不判）。`linkedRoots` 一并记下，
       * 便于事后复核「到底是哪棵树在漂」。
       */
      linkedExternalDrift: {
        count: missingLinked.length,
        roots: linkedRoots,
        entries: missingLinked.slice(0, 20),
      },
      /** ST 命名规则的覆盖规模（供复核：26 个角色 / 401 条版本化条目 ⇒ 归并后 26 个落盘名） */
      stCharacterMap: stMap ? {
        cardEntries: stMap.entries,
        distinctNames: stMap.distinct,
        sprites: stMap.spriteCount,
        stateFiles: stMap.stateCount,
      } : null,
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
    + `（${denominator - missing.length}/${denominator}，缺 ${missing.length}）`
    + ` ${missing.length === 0 ? '✅' : '❌'}`);
  if (stMap) {
    console.log(`[${args.target}] T1 规则：路径 + ST 角色卡落盘名`
      + `（其中按**落盘名**命中 ${nameRuleHits} 条；包内 ${stMap.entries} 条卡片条目 → ${stMap.distinct} 个落盘名）`);
  }
  if (missingHostMetadata.length) {
    console.log(`[${args.target}] T1b 合成元数据 ${missingHostMetadata.length} 条`
      + `（宿主按设计跳过，不计入判定）：${missingHostMetadata.join(', ')}`);
  }
  if (missingHostPrivate.length) {
    console.log(`[${args.target}] T1c Luker 私有状态 ${missingHostPrivate.length} 条`
      + `（ST 无对应机制，不计入判定）：${missingHostPrivate.slice(0, 5).join(', ')}`);
  }
  if (missingLinked.length) {
    console.log(`[${args.target}] T1d 链接目录内缺失 ${missingLinked.length} 条`
      + `（外部工作区漂移，不计入判定）：${missingLinked.slice(0, 3).join(', ')}`);
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
    for (const r of preManifestCheck.hostManagedCache) {
      console.log(`[${args.target}] T2c 宿主自管缓存 ${r.prefix} ${r.entries.length} 条`
        + `（${r.reason}，不在同步判定内）：${r.entries.slice(0, 3).join(', ')}`);
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
