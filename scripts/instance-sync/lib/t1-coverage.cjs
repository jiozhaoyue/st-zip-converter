/**
 * T1「包 → 目标覆盖率」判定核心 —— 从 `diff-report.cjs` 抽出，**为的是可单测**
 *
 * 为什么值得单独成模块：这条判定是 AC-2 的**唯一证据来源**，而它此前埋在 CLI 脚本里、
 * 一旦写错只能靠"人肉读代码"发现。抽出纯函数后，「按落盘名命中」与「真缺失」两种情形
 * 都有**可重跑的负例与正例**（见 `test/instance-sync-t1-coverage.test.js`）——
 * 本仓纪律：「先证明判定会报差异，再相信它报 100%」。
 *
 * 判定语义（**先路径、后宿主命名规则**）：
 *   1. 目标文件集合里有该**包内路径** ⇒ 命中（多数类目如此）；
 *   2. 否则若该条目是 ST 角色卡、且其**宿主落盘名**在目标上存在 ⇒ 命中，计入 `nameRuleHits`；
 *   3. 仍不中 ⇒ 真缺失。
 *
 * 两类条目**单列、不参与判定**（否则判定恒假，等于没有判定）：
 *   - **合成元数据** `_convert/**`、`manifest.json`：宿主按设计跳过；
 *   - **Luker 私有状态** `characters/<名>.state.<编辑器>.json`：ST 无对应机制。
 *
 * @module scripts/instance-sync/lib/t1-coverage
 */

const { createNodeIo } = require('./node-zip-io.cjs');
const { deriveStCharacterUpload, isCharacterSubpath } = require('./luker-card-adapter.cjs');

/** 合成元数据（`convert()` 为目标合成、宿主按设计不消费） */
const isHostMetadata = (n) => n.startsWith('_convert/') || n === 'manifest.json';

/** Luker 私有状态文件（长得像角色卡，其实不是；ST 无对应机制） */
const isHostPrivate = (n) => /\.state\.[^/]*\.json$/i.test(n);

/**
 * **宿主自身会动的派生缓存** —— 同步前快照里有、同步后不见了，但**不是同步删的**。
 *
 * 判定依据必须落到**宿主源码的删除点**上，否则「零删除」这条就变成了自己给自己开脱：
 *
 * | 路径 | 谁在删 | 证据 |
 * | --- | --- | --- |
 * | `backups/**` | Luker 每次 `restore` 前自动备份 settings 并**轮换**（删最旧一条） | 2026-09-26 实测：两次 restore 各少一条 `backups/settings_<user>_<时间>.json` |
 * | `thumbnails/**` | ST **导入成功即失效**该文件对应的缩略图（派生缓存，下次取图时重建） | `characters.js:1591`（`invalidateThumbnail(..., 'avatar', `${preservedFileName}.png`)`）、`avatars.js:52`（`'persona'`）→ `thumbnails.js:83-92` 的 `fs.unlinkSync` |
 *
 * 两条都与**本次同步有因果**，但**执行者是宿主**、对象是**可重建的缓存**：
 * 与「同步覆盖/删除了用户数据」是两回事，故**单列登记**、不计入「零删除」判定。
 * 2026-09-26 实测相关性：Dev ST 快照里只有两条 `thumbnails/`（`avatar/default_Seraphina.png`、
 * `persona/user-default.png`），而包内恰好有角色 `default_Seraphina` 与 `User Avatars/user-default.png`
 * —— 两条一一对应，正是上面两个调用点的命中。
 */
const HOST_MANAGED_CACHE = Object.freeze([
  { prefix: 'backups/', reason: '宿主 restore 前自动轮换（删最旧一条）' },
  { prefix: 'thumbnails/', reason: '宿主导入成功即失效该缩略图（派生缓存，取图时重建）' },
]);

/**
 * 把「同步前有、同步后没了」的条目分成**真删除**与**宿主自管缓存**。
 *
 * @param {Iterable<string>} gone 归一化路径
 * @returns {{real: string[], hostManaged: {prefix:string, reason:string, entries:string[]}[]}}
 */
function classifyPreManifestDeletions(gone) {
  const list = [...gone];
  const hostManaged = HOST_MANAGED_CACHE.map((r) => ({
    ...r,
    entries: list.filter((n) => n.startsWith(r.prefix)),
  }));
  const excused = new Set(hostManaged.flatMap((r) => r.entries));
  return { real: list.filter((n) => !excused.has(n)), hostManaged };
}

/** 归一化：去掉可能的 `data/default-user/` 前缀与 `./`，统一分隔符（与 `diff-report` 逐字一致） */
function normalize(p) {
  let s = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  if (s.startsWith('data/default-user/')) s = s.slice('data/default-user/'.length);
  return s.replace(/\/+/g, '/').replace(/\/$/, '');
}

/**
 * 目标侧**角色卡落盘名**集合：`characters/**` 的**平铺**基名去掉 `.png`。
 * 子目录（精灵图）不并入 —— 它们按路径比对。
 *
 * @param {Iterable<string>} targetFiles 目标文件的归一化相对路径
 */
function targetCharacterNames(targetFiles) {
  const names = new Set();
  for (const f of targetFiles) {
    if (!f.startsWith('characters/')) continue;
    const seg = f.slice('characters/'.length);
    if (seg.includes('/')) continue;
    names.add(seg.replace(/\.png$/i, ''));
  }
  return names;
}

/**
 * 判定 T1。
 *
 * @param {object} p
 * @param {Iterable<string>} p.entries        包内条目（归一化路径）
 * @param {Set<string>} p.targetFiles         目标文件（归一化路径）
 * @param {Map<string,string>|null} p.stNameMap `条目 → ST 落盘名`；Luker 目标传 `null`
 * @param {string[]} [p.linkedRoots]          目标侧的**链接目录**（junction / 符号链接）相对路径
 * @returns {{missing:string[], missingLinked:string[], missingHostMetadata:string[],
 *            missingHostPrivate:string[], nameRuleHits:number, denominator:number, total:number}}
 */
function compareCoverage({ entries, targetFiles, stNameMap, linkedRoots = [] }) {
  const all = [...entries];
  const targetNames = stNameMap ? targetCharacterNames(targetFiles) : new Set();
  // 链接目录判定：前缀命中即视为「落在外部工作区内」
  const roots = linkedRoots.map((r) => `${String(r).replace(/\/+$/, '')}/`);
  const underLink = (n) => roots.some((r) => n.startsWith(r));

  const missingAll = [];
  const missingLinked = [];
  let nameRuleHits = 0;
  for (const n of all) {
    if (targetFiles.has(n)) continue;
    const avatar = stNameMap ? stNameMap.get(n) : null;
    if (avatar && targetNames.has(avatar)) { nameRuleHits += 1; continue; }
    /**
     * **链接目录内的缺失单列**：目标侧的 junction / 符号链接把**别人的活工作区**
     * 挂进了实例目录（实测：`Instance/Dev/Luker/data/default-user/extensions/ST-BgLoader`
     * 是指向 `My-repo/ST-BgLoader` 的 junction）。那种子树会被**它自己的仓**随时改动
     * —— 包内快照与它必然漂移，且**与本任务无关**。若把它算作同步失败，
     * 「覆盖率」这条读数就永远无法反映同步本身做没做到。
     *
     * 但**必须原样报出来**（`missingLinked`）：「不判定」不等于「不报告」，
     * 否则就成了把看不顺眼的证据藏起来。
     */
    if (underLink(n)) missingLinked.push(n);
    else missingAll.push(n);
  }

  const missingHostMetadata = missingAll.filter(isHostMetadata);
  const missingHostPrivate = missingAll.filter(isHostPrivate);
  const missing = missingAll.filter((n) => !isHostMetadata(n) && !isHostPrivate(n));
  const linkedMeta = missingLinked.filter((n) => isHostMetadata(n) || isHostPrivate(n));
  const exempt = all.filter((n) => isHostMetadata(n) || isHostPrivate(n)).length;

  return {
    missing,
    missingLinked: missingLinked.filter((n) => !linkedMeta.includes(n)),
    missingHostMetadata,
    missingHostPrivate,
    nameRuleHits,
    // 分母同步剔除两类「本就不该出现」的条目，否则覆盖率被它们拉低（最多到不了 100%）
    denominator: all.length - exempt,
    total: all.length,
  };
}

/**
 * **宿主命名规则**：ST 目标上 `characters/` 的落盘名映射（`条目 → 落盘名`）。
 *
 * 为什么必需：包内角色卡是**内容寻址名**（`characters/<sha256>`，来自 Luker 的版本化 blob 存储），
 * 而 ST **不按包内路径落盘** —— `importFromJson` 一律写成 `characters/<preserved_name>.png`
 * （`characters.js:257`）。⇒ **逐路径比对在 ST 上恒假**：2026-09-26 实测原始口径只报 94.75%，
 * 差的 377 条里绝大多数**内容已在**、只是换了名。
 *
 * 局限（**如实登记**）：只判「名字在不在」，**不判内容是不是最新版本**；
 * 目标侧若只有该角色的旧版本，本表同样算命中。
 *
 * @returns {Promise<{entryToName: Map<string,string>, distinct:number, entries:number,
 *                    spriteCount:number, stateCount:number}>}
 */
async function stCharacterNameMap(packPath) {
  const io = await createNodeIo();
  const reader = await io.openReader(packPath);
  const entryToName = new Map();
  let entries = 0;
  let spriteCount = 0;
  let stateCount = 0;
  for await (const entry of reader.entries()) {
    if (entry.fileName.endsWith('/')) { entry.skip(); continue; }
    const n = normalize(entry.fileName);
    if (!n.startsWith('characters/')) { entry.skip(); continue; }
    if (isCharacterSubpath(n)) { spriteCount += 1; entry.skip(); continue; }
    if (isHostPrivate(n)) { stateCount += 1; entry.skip(); continue; }
    const up = deriveStCharacterUpload(Buffer.from(await entry.read()), n.split('/').pop());
    entryToName.set(n, up.avatar);
    entries += 1;
  }
  await reader.close();
  return {
    entryToName,
    distinct: new Set(entryToName.values()).size,
    entries,
    spriteCount,
    stateCount,
  };
}

module.exports = {
  normalize,
  isHostMetadata,
  isHostPrivate,
  targetCharacterNames,
  compareCoverage,
  stCharacterNameMap,
  classifyPreManifestDeletions,
  HOST_MANAGED_CACHE,
};
