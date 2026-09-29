/**
 * 包↔包**条目级**比对 —— 回答「两个包是不是同一份东西」
 *
 * ## 为什么不用 `lib/t1-coverage.cjs`
 *
 * `t1-coverage` 判的是「**包 → 目标**覆盖率」（源有的条目目标有没有，按路径 + ST 落盘名规则），
 * 它的输入是「包内条目集合」与「目标磁盘文件集合」。而本工具要回答的是
 * 「**插件产出的包** 与 **`build-packs.cjs` 产出的包** 在条目级是否一致」——
 * 两边都是包、都要比**内容**（`crc32`），语义不同，故另起一件（并在 spec 里写明分工）。
 *
 * ## 判据（`design.md` D2）
 *
 * | 口径 | 含义 |
 * | --- | --- |
 * | `onlyInA` / `onlyInB` | 只在一边出现的**路径**（布局/过滤差异的直接证据） |
 * | `changed` | 同路径但 `crc32` 不同（内容差异） |
 * | `same` | 同路径且 `crc32` 相同 |
 *
 * `crc32` 取自 zip **中央目录**（`src/core/zip-io.js:150` 的 `entry.crc32`）⇒ **不需要解压**，
 * 1.6 GB 的包也是秒级。目录条目（名以 `/` 结尾）单独计数，不参与 `crc32` 比对。
 *
 * ## 归因辅助
 *
 * `onlyInA` / `onlyInB` / `changed` 都按**一级目录**聚合 —— 实测差异几乎总是整块出现
 * （例如 `.git/objects/**` 是 `gitMode` 差异、`manifest.json` 是 `extensionMode` 差异），
 * 聚合后一眼可判，不必在几千行里找。
 *
 * 用法：
 *   node scripts/instance-sync/diff-packs.cjs --a <zip> --b <zip> [--out <json>] [--sample 20] [--label X]
 *   node scripts/instance-sync/diff-packs.cjs --a <zip> --b <zip> --self-test   # 拿同一个包自比，验证判定有判别力
 */

const fs = require('fs');
const path = require('path');

const { createNodeIo } = require('./lib/node-zip-io.cjs');

function parseArgs(argv) {
  const out = { a: '', b: '', out: '', sample: 20, label: '', selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const x = argv[i];
    if (x === '--a') out.a = argv[++i] || '';
    else if (x === '--b') out.b = argv[++i] || '';
    else if (x === '--out') out.out = argv[++i] || '';
    else if (x === '--sample') out.sample = Number(argv[++i]) || 20;
    else if (x === '--label') out.label = argv[++i] || '';
    else if (x === '--self-test') out.selfTest = true;
  }
  return out;
}

/** 一级目录键（用于聚合归因）：`a/b/c` → `a/`；根文件 → `(根文件)` */
const topKey = (n) => {
  const i = n.indexOf('/');
  return i === -1 ? '(根文件)' : `${n.slice(0, i)}/`;
};

/**
 * **结构化元数据的字段级判定**（`manifest.json`）—— 为什么不能按文件名整条豁免
 *
 * 2026-09-29 实测（本工具的第一次 OQ-2 比对）：`manifest.json` 在两侧 `crc32` 不同，
 * 于是被**按文件名**豁免成了「请求期元数据」。但人工核验（解包读内容）发现差异**不是时间戳**——
 * 两侧 `createdAt` **都是** `FIXED_TIMESTAMP`（`transform.js:134/986`），真正不同的是
 * **`selection` 字段**：插件侧记录 `globalExtensions:false, vectors:false`（它的**实际**拉取口径），
 * `build-packs` 侧记录 `true`（它不传 selection ⇒ 取 `L_SELECTION` 全 true）。
 *
 * ⇒ **按文件名整条豁免 = 把判定吃光**（本仓 `L1-MR-*` / spec §7.3 的纪律：
 * 「加白名单时**必须同时加负例**，否则白名单会一路长大到把判定吃光」）。
 * 正确的口径是**字段级**：只有当两侧**仅**在 `createdAt` 这类请求期字段上不同时才豁免；
 * 出现别的字段差异（如 `selection`）⇒ 照实计入 `changed`，并报出**具体是哪些字段**。
 */
const STRUCTURED_METADATA = Object.freeze(['manifest.json']);
const REQUEST_TIME_FIELDS = Object.freeze(['createdAt']);
const isStructuredMetadata = (n) => STRUCTURED_METADATA.includes(n);

/**
 * 读一个包的中央目录进索引。
 * @returns {Promise<{entries: Map<string,{crc32:number|null, uncompressedSize:number, compressedSize:number|null}>, dirs:string[], totalEntries:number, fileEntries:number, uncompressedBytes:number}>}
 */
async function indexPack(io, packPath) {
  const reader = await io.openReader(packPath);
  const entries = new Map();
  const dirs = [];
  let uncompressedBytes = 0;
  let totalEntries = 0;
  for await (const entry of reader.entries()) {
    totalEntries += 1;
    const n = entry.fileName;
    if (n.endsWith('/')) { dirs.push(n.replace(/\/$/, '')); entry.skip(); continue; }
    const rec = {
      crc32: entry.crc32 ?? null,
      uncompressedSize: entry.uncompressedSize || 0,
      compressedSize: entry.compressedSize ?? null,
    };
    // 结构化元数据要**留下字节**供字段级判定（343 B 级，代价可忽略）
    if (isStructuredMetadata(n)) rec.bytes = Buffer.from(await entry.read());
    else entry.skip();
    entries.set(n, rec);
    uncompressedBytes += rec.uncompressedSize;
  }
  await reader.close();
  return { entries, dirs, totalEntries, fileEntries: entries.size, uncompressedBytes };
}

/** 按一级目录聚合计数 */
function byTop(names) {
  const m = new Map();
  for (const n of names) m.set(topKey(n), (m.get(topKey(n)) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ top: k, count: v }));
}

/**
 * 结构化元数据的**字段级**差异：返回不同的顶层键名数组（解析失败返回 null ⇒ 调用方保守计入 changed）。
 * 目的：把「请求期时间戳」与「实质口径差异（如 `selection`）」区分开 —— 见 STRUCTURED_METADATA 说明。
 */
function structuredDiffKeys(aBuf, bBuf) {
  try {
    const A = JSON.parse(aBuf.toString('utf8'));
    const B = JSON.parse(bBuf.toString('utf8'));
    const keys = new Set([...Object.keys(A), ...Object.keys(B)]);
    const out = [];
    for (const k of keys) if (JSON.stringify(A[k]) !== JSON.stringify(B[k])) out.push(k);
    return out;
  } catch { return null; }
}

/**
 * 比对两个索引。
 * @param {Awaited<ReturnType<typeof indexPack>>} A
 * @param {Awaited<ReturnType<typeof indexPack>>} B
 * @param {number} sample 每类差异最多保留多少条样本
 */
function compareIndexes(A, B, sample) {
  const onlyInA = [];
  const onlyInB = [];
  const changed = [];
  const changedRequestMetadata = [];
  let same = 0;
  for (const [n, a] of A.entries) {
    const b = B.entries.get(n);
    if (!b) { onlyInA.push(n); continue; }
    // crc32 任一侧为 null（无中央目录 CRC）时退化为比未压缩长度，并在读数里标注
    const aC = a.crc32; const bC = b.crc32;
    const differs = (aC !== null && bC !== null)
      ? aC !== bC
      : a.uncompressedSize !== b.uncompressedSize;
    if (differs) {
      const rec = (aC !== null && bC !== null)
        ? { path: n, crcA: aC, crcB: bC, sizeA: a.uncompressedSize, sizeB: b.uncompressedSize }
        : { path: n, crcA: aC, crcB: bC, sizeA: a.uncompressedSize, sizeB: b.uncompressedSize, note: '无 crc32，按未压缩长度判定' };
      // 字段级判定（见 STRUCTURED_METADATA 的说明）：**只有**仅请求期字段不同才豁免
      if (isStructuredMetadata(n) && a.bytes && b.bytes) {
        const keys = structuredDiffKeys(a.bytes, b.bytes);
        rec.differingFields = keys;
        if (keys && keys.length && keys.every((k) => REQUEST_TIME_FIELDS.includes(k))) {
          rec.exemption = `仅请求期字段不同（${keys.join(',')}）⇒ 豁免`;
          changedRequestMetadata.push(rec);
        } else {
          rec.exemption = '结构化元数据，但差异**不止**请求期字段 ⇒ 照实计入 changed';
          changed.push(rec);
        }
      } else if (isStructuredMetadata(n)) {
        rec.exemption = '结构化元数据但读不到字节 ⇒ 保守计入 changed';
        changed.push(rec);
      } else {
        changed.push(rec);
      }
    } else same += 1;
  }
  for (const n of B.entries.keys()) if (!A.entries.has(n)) onlyInB.push(n);

  const dirOnlyA = A.dirs.filter((d) => !B.dirs.includes(d));
  const dirOnlyB = B.dirs.filter((d) => !A.dirs.includes(d));

  const identical = onlyInA.length === 0 && onlyInB.length === 0 && changed.length === 0;
  return {
    counts: {
      aEntries: A.fileEntries, bEntries: B.fileEntries,
      aDirs: A.dirs.length, bDirs: B.dirs.length,
      same, changed: changed.length, onlyInA: onlyInA.length, onlyInB: onlyInB.length,
      changedRequestMetadata: changedRequestMetadata.length,
      dirOnlyInA: dirOnlyA.length, dirOnlyInB: dirOnlyB.length,
    },
    bytes: { aUncompressed: A.uncompressedBytes, bUncompressed: B.uncompressedBytes },
    onlyInAByTop: byTop(onlyInA),
    onlyInBByTop: byTop(onlyInB),
    changedByTop: byTop(changed.map((c) => c.path)),
    changedRequestMetadata,
    samples: {
      onlyInA: onlyInA.slice(0, sample),
      onlyInB: onlyInB.slice(0, sample),
      changed: changed.slice(0, sample),
      dirOnlyInA: dirOnlyA.slice(0, sample),
      dirOnlyInB: dirOnlyB.slice(0, sample),
    },
    // ⚠️ verdict 必须是**裸判定词**：调用方（含 --self-test）按它比对。
    // 2026-09-29 实测踩过：首版把它写成「IDENTICAL（…说明…）」⇒ 自比明明报 IDENTICAL，
    // 字符串却与 'IDENTICAL' 不等 ⇒ --self-test 假红。**说明文字另置 verdictDetail。**
    verdict: identical ? 'IDENTICAL' : 'DIFFERENT',
    verdictDetail: identical
      ? `条目路径集合与逐条 crc32 全等${changedRequestMetadata.length ? `（另有 ${changedRequestMetadata.length} 条请求期元数据按设计不同，已单列）` : ''}`
      : `${onlyInA.length} 条仅 A / ${onlyInB.length} 条仅 B / ${changed.length} 条内容不同（已剔除请求期元数据）`,
  };
}

const MB = (n) => (n / 1048576).toFixed(1);

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.a || !args.b) {
    console.error('用法：node scripts/instance-sync/diff-packs.cjs --a <zip> --b <zip> [--out <json>] [--sample N] [--label X] [--self-test]');
    process.exit(2);
  }
  const aPath = path.resolve(args.a);
  const bPath = path.resolve(args.b);
  for (const p of [aPath, bPath]) {
    if (!fs.existsSync(p)) { console.error(`✗ 不存在：${p}`); process.exit(2); }
  }
  // --self-test：同一个包自比 ⇒ 判定**必须**报 IDENTICAL。
  // 这是「先证明判定有判别力」的负例侧的对照：若自比都报 DIFFERENT，说明比对器本身坏了。
  const bEff = args.selfTest ? aPath : bPath;

  const io = await createNodeIo();
  const A = await indexPack(io, aPath);
  const B = await indexPack(io, bEff);
  const result = compareIndexes(A, B, args.sample);

  const out = {
    tool: 'diff-packs.cjs',
    label: args.label || null,
    a: { file: path.basename(aPath), bytes: fs.statSync(aPath).size, ...result.counts, dirs: A.dirs.length },
    b: { file: path.basename(bEff), bytes: fs.statSync(bEff).size },
    selfTest: args.selfTest || null,
    ...result,
    comparedAt: new Date().toISOString(),
  };

  console.log(`A = ${path.basename(aPath)}  (${MB(fs.statSync(aPath).size)} MB / ${A.fileEntries} 文件条目 / ${A.dirs.length} 目录条目)`);
  console.log(`B = ${path.basename(bEff)}  (${MB(fs.statSync(bEff).size)} MB / ${B.fileEntries} 文件条目 / ${B.dirs.length} 目录条目)`);
  console.log(`\n判定：${result.verdict} —— ${result.verdictDetail}`);
  console.log(`  同路径同 crc32 ${result.counts.same} ｜ 同路径异 crc32 ${result.counts.changed}`
    + ` ｜ 仅 A ${result.counts.onlyInA} ｜ 仅 B ${result.counts.onlyInB}`);
  if (result.counts.changedRequestMetadata) {
    console.log(`  请求期元数据（带生成时刻，按设计不同，不计入判定）${result.counts.changedRequestMetadata} 条：`
      + JSON.stringify(result.changedRequestMetadata.map((r) => r.path)));
  }
  console.log(`  目录条目：仅 A ${result.counts.dirOnlyInA} ｜ 仅 B ${result.counts.dirOnlyInB}`);
  console.log(`  未压缩总计：A ${MB(result.bytes.aUncompressed)} MB ｜ B ${MB(result.bytes.bUncompressed)} MB`);
  const dump = (title, rows) => {
    if (!rows.length) return;
    console.log(`\n  ${title}（按一级目录聚合）：`);
    for (const r of rows.slice(0, 15)) console.log(`    ${String(r.count).padStart(6)}  ${r.top}`);
  };
  dump('仅 A 有', result.onlyInAByTop);
  dump('仅 B 有', result.onlyInBByTop);
  dump('同路径但内容不同', result.changedByTop);
  if (result.samples.onlyInA.length) console.log(`\n  仅 A 样本：${JSON.stringify(result.samples.onlyInA.slice(0, 8))}`);
  if (result.samples.onlyInB.length) console.log(`  仅 B 样本：${JSON.stringify(result.samples.onlyInB.slice(0, 8))}`);
  if (result.samples.changed.length) console.log(`  内容不同样本：${JSON.stringify(result.samples.changed.slice(0, 4))}`);

  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(path.resolve(args.out), JSON.stringify(out, null, 2), 'utf8');
    console.log(`\n读数 → ${path.resolve(args.out)}`);
  }

  // 有判别力的退出码：自比必须 IDENTICAL；否则 DIFFERENT → 1（供脚本串接与 E2E 使用）
  if (args.selfTest && result.verdict !== 'IDENTICAL') {
    console.error('✗ --self-test 失败：同一个包自比报了 DIFFERENT ⇒ 比对器本身有缺陷');
    process.exit(1);
  }
  process.exit(result.verdict === 'IDENTICAL' ? 0 : 1);
})().catch((e) => {
  console.error('比对失败：', e);
  process.exit(1);
});
