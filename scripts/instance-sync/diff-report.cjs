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
  const out = { pack: '', target: '', unique: '', preManifest: '', out: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--pack') out.pack = argv[++i] || '';
    else if (argv[i] === '--target') out.target = argv[++i] || '';
    else if (argv[i] === '--unique-manifest') out.unique = argv[++i] || '';
    else if (argv[i] === '--pre-manifest') out.preManifest = argv[++i] || '';
    else if (argv[i] === '--out') out.out = argv[++i] || '';
  }
  return out;
}

/** 目标当前的文件清单（只 stat，不读内容） */
async function walkTarget(rootDir) {
  const files = new Set();
  const sizes = new Map();
  async function rec(dir, rel) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const ent of entries) {
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) await rec(abs, relPath);
      else if (ent.isFile()) {
        files.add(normalize(relPath));
        try { sizes.set(normalize(relPath), (await fs.promises.stat(abs)).size); } catch { /* 竞态 */ }
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

  const packSet = new Set(entries);
  const missing = [...packSet].filter((n) => !target.files.has(n));
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
    const keys = pre.files ? Object.keys(pre.files) : [];
    const gone = keys.filter((n) => !target.files.has(normalize(n)));
    preManifestCheck = {
      manifest: args.preManifest,
      takenAt: pre.takenAt || null,
      declared: keys.length,
      stillPresent: keys.length - gone.length,
      deletedCount: gone.length,
      deletedSample: gone.slice(0, 50),
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
