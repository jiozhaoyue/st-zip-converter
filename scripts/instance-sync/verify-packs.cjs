/**
 * 产包校验器 —— `implement.md` 2.4 / AC-4 的核对装置
 *
 * 用途：对 `build-packs.cjs` 产出的三个包做**有判别力**的断言，而不是「体积看着差不多」。
 * 判据全部来自源包实测基线（`research/backup-export-readings.md`）与布局规则
 * （`transform.js:718` `targetEntryPath`、`:103` `TT_USER_PREFIX`）。
 *
 * 用法：
 *   node scripts/instance-sync/verify-packs.cjs [--dir <目录>] [--stamp <yyyymmdd-hhmmss>]
 *
 * 断言（任一失败 ⇒ 退出码 1）：
 *   A1 三个包都存在且 > 100 MB（挡住「半截包被当产物」）
 *   A2 `backups/` **零条目** —— 用户裁决 U-4「同步时排除 `backups/`」
 *   A3 `chats/` = **1029**、`characters/` = **430** —— 与源包一致（AC-3 的包侧代理断言）
 *   A4 布局：`tt` 包 **100%** 条目带 `data/default-user/` 前缀；
 *           `l` / `st` 包**零**条目带该前缀（摊平）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createNodeIo } = require('./lib/node-zip-io.cjs');

const MB = (n) => (n / 1048576).toFixed(1);
/**
 * 布局常量取自产品源码，**不得凭印象写**：
 * - `DATA_PREFIX`（`transform.js:111`）：TT 目标的 data root，**全部**条目应落于其下
 *   （`data/default-user/` 是 user 数据、`data/extensions/third-party/` 是全局扩展、
 *   `data/_tauritavern/` 是扩展来源记录 —— 三者都是合规位置）
 * - `TT_USER_PREFIX`（`transform.js:103`）：统计类目时需剥掉的前缀
 */
const DATA_PREFIX = 'data/';
const TT_USER_PREFIX = 'data/default-user/';

// 源包实测基线（research/backup-export-readings.md）
const EXPECT = { chats: 1029, characters: 430 };
const MIN_BYTES = 100 * 1048576;

function parseArgs(argv) {
  const out = { dir: '', stamp: '', file: '', kind: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') out.dir = argv[++i] || '';
    else if (argv[i] === '--stamp') out.stamp = argv[++i] || '';
    else if (argv[i] === '--file') out.file = argv[++i] || '';
    else if (argv[i] === '--kind') out.kind = argv[++i] || '';
  }
  return out;
}

/** 找 `pack-<kind>-<stamp>.zip`；未指定 stamp 时取最新（按文件名排序） */
function findPacks(dir, stamp) {
  const names = fs.readdirSync(dir).filter((n) => /^pack-(luker|st|tt)-.*\.zip$/.test(n));
  const byKind = {};
  for (const kind of ['luker', 'st', 'tt']) {
    const cands = names.filter((n) => n.startsWith(`pack-${kind}-`))
      .filter((n) => !stamp || n.includes(stamp))
      .sort();
    if (cands.length) byKind[kind] = path.join(dir, cands[cands.length - 1]);
  }
  return byKind;
}

/**
 * 读一个包的中央目录，统计一级目录构成。
 * @param {string} userPrefix 统计类目前要**剥掉**的前缀（TT 传 `TT_USER_PREFIX`，其余传 `''`）
 * @returns {{total:number,totalBytes:number,counts:Map,bytes:Map,dataPrefixed:number}}
 *   `dataPrefixed` 是**带 `DATA_PREFIX` 的条目数** —— 布局判据，与剥前缀无关，故单独统计。
 */
async function scanPack(io, file, userPrefix) {
  const reader = await io.openReader(file);
  const counts = new Map();
  const bytes = new Map();
  let total = 0;
  let dataPrefixed = 0;
  let totalBytes = 0;
  for await (const entry of reader.entries()) {
    total += 1;
    const raw = entry.fileName;
    const size = entry.uncompressedSize || 0;
    totalBytes += size;
    if (raw.startsWith(DATA_PREFIX)) dataPrefixed += 1;
    const name = (userPrefix && raw.startsWith(userPrefix)) ? raw.slice(userPrefix.length) : raw;
    const segs = name.split('/');
    const key = segs.length > 1 ? `${segs[0]}/` : '(根文件)';
    counts.set(key, (counts.get(key) || 0) + 1);
    bytes.set(key, (bytes.get(key) || 0) + size);
    entry.skip();
  }
  await reader.close();
  return { total, totalBytes, counts, bytes, dataPrefixed };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.dir ? path.resolve(args.dir) : path.join(os.homedir(), 'Downloads');
  const io = await createNodeIo();

  // `--file <zip>` ⇒ 单包模式（按 `--kind` 选布局判据），用于**负例验证**：
  // 先证明「判定能抓到违规」，再相信它对真产物报 0 失败。
  const packs = args.file
    ? { [args.kind || 'luker']: path.resolve(args.file) }
    : findPacks(dir, args.stamp);
  const kinds = args.file ? [args.kind || 'luker'] : ['luker', 'st', 'tt'];
  const failures = [];
  const check = (ok, msg) => { if (!ok) failures.push(msg); };

  console.log(args.file ? `校验单包：${packs[kinds[0]]}` : `校验目录：${dir}`);
  console.log(`断言对象：${kinds.join(' / ')}\n`);

  // —— A1 三个包存在且够大 ——
  for (const kind of kinds) {
    const f = packs[kind];
    if (!f) { failures.push(`A1 缺少 ${kind} 包（pack-${kind}-*.zip）`); continue; }
    const size = fs.statSync(f).size;
    check(size > MIN_BYTES, `A1 ${path.basename(f)} 仅 ${MB(size)} MB（< ${MB(MIN_BYTES)} MB，疑似半截包）`);
  }
  if (failures.length) {
    console.error('❌ 前置失败：');
    for (const m of failures) console.error(`   ${m}`);
    process.exit(1);
  }

  for (const kind of kinds) {
    const f = packs[kind];
    const isTT = kind === 'tt';
    const r = await scanPack(io, f, isTT ? TT_USER_PREFIX : '');
    const g = (k) => r.counts.get(k) || 0;

    console.log(`━━━ ${path.basename(f)}（${MB(fs.statSync(f).size)} MB）━━━`);
    console.log(`条目总数 ${r.total} ｜ 未压缩 ${MB(r.totalBytes)} MB ｜ 落于 ${DATA_PREFIX} 之下 ${r.dataPrefixed} 条`);
    const rows = [...r.counts.entries()].sort((a, b) => (r.bytes.get(b[0]) || 0) - (r.bytes.get(a[0]) || 0));
    for (const [k, v] of rows.slice(0, 10)) {
      console.log(`   ${k.padEnd(24)}${String(v).padStart(7)} 条 ${MB(r.bytes.get(k) || 0).padStart(10)} MB`);
    }

    // A2 backups/ 零条目
    const bk = g('backups/');
    check(bk === 0, `A2 ${kind}: backups/ 有 ${bk} 条（U-4 要求零条目）`);
    console.log(`   A2 backups/ = ${bk} ${bk === 0 ? '✅' : '❌'}`);

    // A3 类目计数
    const c = g('characters/');
    const ch = g('chats/');
    check(c === EXPECT.characters, `A3 ${kind}: characters/ = ${c}（期望 ${EXPECT.characters}）`);
    check(ch === EXPECT.chats, `A3 ${kind}: chats/ = ${ch}（期望 ${EXPECT.chats}）`);
    console.log(`   A3 characters/ = ${c} ${c === EXPECT.characters ? '✅' : '❌'}`
      + ` ｜ chats/ = ${ch} ${ch === EXPECT.chats ? '✅' : '❌'}`);

    // A4 布局：TT 目标的条目**全部**落在 data root（`data/`）之下 —— 但**不都是**
    // `data/default-user/`（`data/extensions/third-party/` 与 `data/_tauritavern/` 同样合规，
    // 见 `transform.js:103-111`）。其余目标必须摊平、不得出现 `data/` 前缀。
    if (isTT) {
      const ok = r.dataPrefixed === r.total;
      check(ok, `A4 tt: 仅 ${r.dataPrefixed}/${r.total} 条落在 ${DATA_PREFIX} 之下（TT 布局要求全部落在 data root 内）`);
      console.log(`   A4 全部落于 ${DATA_PREFIX} 之下 ${r.dataPrefixed}/${r.total} ${ok ? '✅' : '❌'}`);
    } else {
      // 源包本身没有 `data/` 这一层（Luker 备份是摊平的 hubPath），故该前缀出现即为布局错误
      check(r.dataPrefixed === 0, `A4 ${kind}: ${r.dataPrefixed} 条带 ${DATA_PREFIX} 前缀（该目标应摊平）`);
      console.log(`   A4 无 ${DATA_PREFIX} 前缀 ${r.dataPrefixed === 0 ? '✅' : '❌'}`);
    }
    console.log('');
  }

  if (failures.length) {
    console.error('❌ 校验失败：');
    for (const m of failures) console.error(`   ${m}`);
    process.exit(1);
  }
  console.log('✅ 全部断言通过（A1 存在且够大 / A2 backups 零 / A3 类目计数 / A4 布局前缀）');
})().catch((e) => {
  console.error('校验器异常：', e);
  process.exit(1);
});
