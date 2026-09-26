/**
 * ST 角色卡「包 → 目标」**按宿主命名规则**归因器（只读）
 *
 * 为什么需要它：`diff-report.cjs` 的 T1 是**逐路径**比对，而 ST 的角色卡**不按包内路径落盘** ——
 * 包内是内容寻址名（`characters/<sha256>`，来自 Luker 的存储形态），
 * ST 的 `importFromJson` 一律写成 `characters/<preserved_name>.png`（角色名）。
 * ⇒ 逐路径比对在 ST 上**恒假**（实测 94.75%），差的 377 条里绝大多数其实**内容已在**、只是换了名。
 *
 * 本脚本用**宿主自己的命名规则**建映射（`preserved_name` → `characters/<名>.png`），回答三个问题：
 *   1. 有多少张卡的落盘名**能在目标上找到**（真覆盖）；
 *   2. 找不到的那些，落盘名本身是不是**宿主不可落盘**的（非法字符 / 超长 / 重名）；
 *   3. 落盘名是否**撞车**（两张不同的卡收敛到同一个文件名 ⇒ 后者覆盖前者，属真丢失）。
 *
 * 派生逻辑**复用 `lib/luker-card-adapter.cjs`**（与 `import-st.cjs` 同一实现，避免两处漂移）。
 *
 * 用法：
 *   node scripts/instance-sync/diag-st-char-map.cjs --pack <pack-st.zip> --target dev-st [--list 40]
 *   node scripts/instance-sync/diag-st-char-map.cjs --pack <pack-st.zip> --target dev-st \
 *        --import-log research/import-st-dev-st-*.json      # 可选：与上次导入的失败集对照
 *
 * 纪律：**只读**目标目录，不写 `Instance/**`。
 */

const fs = require('fs');
const path = require('path');

const { createNodeIo } = require('./lib/node-zip-io.cjs');
const { getInstance, userDirOf } = require('../../e2e/lib/instances.cjs');
const { deriveStCharacterUpload, sanitizeHostName, isCharacterSubpath } = require('./lib/luker-card-adapter.cjs');

function parseArgs(argv) {
  const out = { pack: '', target: '', list: 40, importLog: '', versions: '', dumpNames: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--pack') out.pack = argv[++i] || '';
    else if (argv[i] === '--target') out.target = argv[++i] || '';
    else if (argv[i] === '--list') out.list = Number(argv[++i]) || 40;
    else if (argv[i] === '--import-log') out.importLog = argv[++i] || '';
    else if (argv[i] === '--versions') out.versions = argv[++i] || '';
    else if (argv[i] === '--dump-names') out.dumpNames = argv[++i] || '';
  }
  return out;
}

function normalize(p) {
  let s = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  if (s.startsWith('data/default-user/')) s = s.slice('data/default-user/'.length);
  return s.replace(/\/+/g, '/').replace(/\/$/, '');
}

/** 目标角色卡：**所有** `characters/**` 文件的基名去掉 `.png`（ST 的落盘名 = preserved_name） */
function targetCharacterNames(root) {
  const dir = path.join(root, 'characters');
  const names = new Set();
  let count = 0;
  const rec = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) rec(path.join(d, e.name));
      else {
        count += 1;
        names.add(e.name.replace(/\.png$/i, ''));
      }
    }
  };
  if (fs.existsSync(dir)) rec(dir);
  return { names, count };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pack || !args.target) {
    console.error('用法：node scripts/instance-sync/diag-st-char-map.cjs --pack <pack.zip> --target <instanceId>');
    process.exit(2);
  }
  const root = userDirOf(args.target);
  if (!root) throw new Error(`[${args.target}] 无磁盘用户目录`);

  const target = targetCharacterNames(root);
  const io = await createNodeIo();
  const reader = await io.openReader(path.resolve(args.pack));

  /** @type {{n:string, human:string, preserved:string, avatar:string, version:number|null, isPng:boolean, head:string, unsafe:boolean}[]} */
  const cards = [];
  let sprites = 0;
  let stateFiles = 0;
  for await (const e of reader.entries()) {
    if (e.fileName.endsWith('/')) { e.skip(); continue; }
    const n = normalize(e.fileName);
    // 与导入器同口径：`characters/` 下**平铺**的才算卡片；子目录是精灵图、`.state.` 是 Luker 私有状态
    if (!n.startsWith('characters/')) { e.skip(); continue; }
    if (isCharacterSubpath(n)) { sprites += 1; e.skip(); continue; }
    if (/\.state\.[^/]*\.json$/i.test(n)) { stateFiles += 1; e.skip(); continue; }
    const base = n.split('/').pop();
    const data = Buffer.from(await e.read());
    const up = deriveStCharacterUpload(data, base);
    // 「不安全」= 原始人类名与收敛后的落盘名不同（说明原样的名字在宿主上落不了盘）
    cards.push({
      n,
      human: up.human,
      preserved: up.preservedName,
      avatar: up.avatar,
      version: up.version,
      isPng: up.isPng,
      // 头部 160 字节：未解析出名字的条目靠它当场看清外层形态（省一次重跑）
      head: data.subarray(0, 160).toString('utf8').replace(/\s+/g, ' '),
      // 内容指纹：`--versions` 判定「同名的多条到底是**历史版本**还是**同一份重复**」
      size: up.payload.length,
      digest: require('crypto').createHash('sha1').update(up.payload).digest('hex').slice(0, 10),
      unsafe: sanitizeHostName(up.human) !== up.human || up.human === '',
    });
  }
  await reader.close();

  /**
   * **版本归并**：Luker 盘上是「每个角色多份历史版本」（键尾 `-<毫秒>.<微秒>`）。
   * ST 的存储是「一个头像名一份文件」⇒ 只有**最新版本**该被导入，其余是同一角色的历史态。
   */
  const byAvatar = new Map();
  for (const c of cards) {
    if (!byAvatar.has(c.preserved)) byAvatar.set(c.preserved, []);
    byAvatar.get(c.preserved).push(c);
  }
  const withVersion = (arr) => arr.filter((c) => c.version !== null);
  const latestOf = (arr) => (withVersion(arr).length
    ? withVersion(arr).reduce((a, b) => (b.version > a.version ? b : a))
    : arr[arr.length - 1]);

  const distinct = [...byAvatar.entries()];
  const latest = distinct.map(([, arr]) => ({ avatar: arr[0].preserved, entries: arr.length, winner: latestOf(arr) }));
  const found = latest.filter((l) => target.names.has(l.avatar));
  const missing = latest.filter((l) => !target.names.has(l.avatar));

  // 落盘名撞车（修正解析后仍撞车 = 真的不同角色同名）
  const collisions = distinct.filter(([, v]) => v.length > 1)
    .map(([name, v]) => [name, v.map((c) => c.n)]);

  console.log(`目标 ${args.target}：角色卡文件 ${target.count} 个（按 characters/** 全递归计数）`);
  console.log(`包内 characters/ 条目 ${cards.length} 条（PNG ${cards.filter((c) => c.isPng).length}`
    + ` / JSON ${cards.filter((c) => !c.isPng).length}）`
    + `　另有精灵图 ${sprites} 条、Luker 状态文件 ${stateFiles} 条（两者都不是卡片，另走裸落盘/不投递）`);
  console.log(`归并后**不同角色** ${distinct.length} 个`
    + `（平均每角色 ${(cards.length / distinct.length).toFixed(1)} 份历史版本）`);
  console.log(`\n按宿主命名规则比对（只比**最新版本**）：命中 ${found.length} / 缺失 ${missing.length}`
    + `（覆盖率 ${((found.length / distinct.length) * 100).toFixed(3)}%）`);

  const noVersion = cards.filter((c) => c.version === null).length;
  console.log(`无版本戳的条目（无法判新旧，按包内末位取胜）：${noVersion} 条`);

  // 形态分桶：把「哪一类取不到角色名」讲清楚 —— 取不到名字的条目会被写成 `<sha>.png` 这类无名卡片
  const isHexName = (s) => /^[0-9a-f]{32,64}$/i.test(s);
  const buckets = [
    ['PNG·取到卡片名', cards.filter((c) => c.isPng && !isHexName(c.human))],
    ['PNG·无名（chara 块缺失）', cards.filter((c) => c.isPng && isHexName(c.human))],
    ['JSON·KV 外壳解析成功', cards.filter((c) => !c.isPng && !isHexName(c.human))],
    ['JSON·未解析出名字', cards.filter((c) => !c.isPng && isHexName(c.human))],
  ];
  console.log('形态分桶：');
  for (const [label, list] of buckets) console.log(`  ${String(list.length).padStart(5)} 条  ${label}`);
  for (const [label, list] of buckets) {
    if (list.length && label.includes('未解析')) {
      console.log(`  ↳ ${label} 样本：${list.slice(0, 3).map((c) => c.n).join(' | ')}`);
      for (const c of list.slice(0, args.list)) {
        console.log(`      ${c.n.slice(-16)}　头部：${c.head.slice(0, 150)}`);
      }
    }
  }
  const unsafeMissing = missing.filter((l) => l.winner.unsafe);
  console.log(`缺失中「原始名宿主不可落盘」的：${unsafeMissing.length} 条`
    + `（这些正是 sanitize 之后才会出现的差异）`);

  /**
   * ⚠️ **不要**把「同一 `avatar` 有多条条目」叫成撞车 —— 那是 Luker 的**历史版本**，
   * 归并后理应只剩一个落盘名。本脚本第一版就误报过 26 组「撞车」。
   * 真正的风险只在于：**两个不同角色恰好同名**（此时才会互相覆盖），
   * 而仅凭包内数据无法区分这两种情形 ⇒ 只如实报告「同名归并组」的规模，不下判定。
   */
  const merged = distinct.filter(([, v]) => v.length > 1).length;
  console.log(`同名归并组（含历史版本）：${merged} 组，最大一组 ${Math.max(...distinct.map(([, v]) => v.length))} 条`);

  if (args.importLog) {
    const files = fs.existsSync(args.importLog) ? [args.importLog]
      : fs.readdirSync(path.dirname(args.importLog)).map((f) => path.join(path.dirname(args.importLog), f));
    const logFile = files.find((f) => /import-st-.*\.json$/.test(f));
    if (logFile) {
      const log = JSON.parse(fs.readFileSync(logFile, 'utf8'));
      const fails = log.failures || [];
      console.log(`\n=== 与导入日志对照（${path.basename(logFile)}）===`);
      console.log(`日志失败 ${log.categories?.characters?.fail ?? '?'} 条，记录 ${fails.length} 条`);
      const failNames = new Set(fails.map((f) => f.n));
      const missNames = new Set(missing.map((l) => l.winner.n));
      const both = [...missNames].filter((n) => failNames.has(n));
      console.log(`  缺失集 ∩ 失败集 = ${both.length}`
        + `（缺失 ${missNames.size} / 失败 ${failNames.size}）`);
    }
  }

  console.log(`\n=== 缺失角色（最多 ${args.list} 条）===`);
  for (const l of missing.slice(0, args.list)) {
    console.log(`  ${l.winner.unsafe ? '⚠️ ' : '   '}${l.avatar}.png ← ${l.entries} 份版本，取最新 `
      + `${l.winner.n.slice(0, 24)}…（原始名 ${JSON.stringify(l.winner.human)}）`);
  }
  if (collisions.length) {
    console.log(`\n=== 同名归并组中的大组（最多 ${args.list} 组，前 3 条）===`);
    for (const [name, items] of collisions.slice(0, args.list)) {
      console.log(`  ${name}.png ← ${items.length} 条：${items.slice(0, 3).join(' | ')}`);
    }
  }

  if (args.versions) {
    const group = byAvatar.get(args.versions) || [];
    console.log(`\n=== 同角色的 ${group.length} 条条目（--versions ${args.versions}）===`);
    console.log('（版本号 / 载荷字节 / 内容指纹——指纹不同即**内容真的不同**，说明是历史版本而非重复投递）');
    for (const c of group.sort((a, b) => (a.version ?? -1) - (b.version ?? -1))) {
      console.log(`  v=${String(c.version ?? '无').padStart(14)}  ${String(c.size).padStart(8)} B  `
        + `${c.digest}  ${c.isPng ? 'PNG' : 'JSON'}  ${c.n.slice(-16)}`);
    }
    const digests = new Set(group.map((c) => c.digest));
    console.log(`  不同内容指纹 ${digests.size} 个 / 条目 ${group.length} 条`);
  }

  console.log('\n=== 抽样：落盘名映射（前 10 个角色）===');
  for (const l of latest.slice(0, 10)) {
    console.log(`  ${String(l.entries).padStart(4)} 份版本 → ${l.avatar}.png`);
  }

  const pass = missing.length === 0;
  console.log(`\n判定：${pass ? '✅ 按宿主命名规则全覆盖（最新版本）' : '❌ 存在未覆盖角色'}`);
  if (args.dumpNames) {
    // 落盘「包内应有的角色名」清单：供目标侧目录分类（哪些是本次该有的、哪些是历史产物）使用
    fs.writeFileSync(args.dumpNames, JSON.stringify({
      target: args.target,
      pack: path.basename(args.pack),
      avatars: latest.map((l) => l.avatar).sort(),
      missing: missing.map((l) => l.avatar).sort(),
    }, null, 1), 'utf8');
    console.log(`角色名清单 → ${args.dumpNames}`);
  }
  if (!pass) process.exitCode = 1;
})().catch((e) => {
  console.error('归因器异常：', e && e.message ? e.message : e);
  process.exit(1);
});
