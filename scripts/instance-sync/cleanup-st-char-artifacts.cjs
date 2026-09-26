/**
 * 清理 ST 目标上的**本任务自身产物**：早前那轮「角色卡命名推导有误」的导入留下的错名/重复卡片
 *
 * ⚠️ **这是删除操作**（PARDON 项）。2026-09-26 经用户明确批准后执行，批准范围**仅限**满足
 * 下面**全部三条**的文件：
 *   1. 位于 `<inst>/data/<handle>/characters/` 的**平铺**层（不含子目录精灵图）；
 *   2. **不在**同步前只读快照 `research/t2-pre-<inst>.json` 里（⇒ 不是用户原有内容）；
 *   3. **不等于**包内角色卡的应有落盘名（`<角色名>.png`，由 `lib/luker-card-adapter.cjs` 推导）。
 *
 * 三条同时成立才删 —— 任一不成立即**跳过并登记**。这是为了防止「清理工具本身变成删用户数据的工具」：
 * 宁可漏删（残留看得见），不可误删（用户内容不可恢复，且 Dev ST / Real ST **没有原生备份**，见 prd 残留 R-7）。
 *
 * 删除前先把**清单 + 大小 + sha256** 落 `research/`：内容不入库、但台账在，事后可复核删了什么。
 *
 * 用法：
 *   node scripts/instance-sync/cleanup-st-char-artifacts.cjs --id dev-st                     # 空转（默认）
 *   node scripts/instance-sync/cleanup-st-char-artifacts.cjs --id dev-st --apply             # 真删
 *   ... --keep <names.json>   指定「应有角色名」清单（默认取 `diag-st-char-map.cjs --dump-names` 的产物）
 *
 * 纪律：只删上面三条同时命中的文件；**不动子目录、不动其它类目、不动 pre-sync 快照内的任何文件**。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { getInstance, userDirOf } = require('../../e2e/lib/instances.cjs');

const TASK_DIR = path.resolve(__dirname, '..', '..', '.trellis', 'tasks', '09-26-all-instance-data-sync-e2e');
const RESEARCH_DIR = path.join(TASK_DIR, 'research');

function parseArgs(argv) {
  const out = { id: '', handle: 'default-user', apply: false, keep: '', pre: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--id') out.id = argv[++i] || '';
    else if (argv[i] === '--handle') out.handle = argv[++i] || '';
    else if (argv[i] === '--apply') out.apply = true;
    else if (argv[i] === '--keep') out.keep = argv[++i] || '';
    else if (argv[i] === '--pre') out.pre = argv[++i] || '';
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const inst = getInstance(args.id);
  if (!inst) throw new Error(`未知实例 id：${args.id}（本工具只服务 ST 目标）`);
  if (inst.host !== 'st') throw new Error(`[${inst.id}] 宿主是 ${inst.host}，本工具只处理 ST 的角色卡命名产物`);
  if (inst.port === 8000) throw new Error('禁止 8000（L0-16）');

  const userDir = userDirOf(inst.id);
  const charDir = path.join(userDir, 'characters');

  const prePath = args.pre || path.join(RESEARCH_DIR, `t2-pre-${inst.id}.json`);
  const keepPath = args.keep || path.join(path.resolve(__dirname, '..', '..'), 'test-results', `${inst.id}-avatars.json`);

  const pre = JSON.parse(fs.readFileSync(prePath, 'utf8'));
  const preChar = new Set(Object.keys(pre.files || {})
    .filter((k) => k.startsWith('characters/'))
    .map((k) => k.slice('characters/'.length)));
  const keep = JSON.parse(fs.readFileSync(keepPath, 'utf8'));
  if (keep.target !== inst.id) throw new Error(`角色名清单属于 ${keep.target}，与 --id ${inst.id} 不符`);
  const expected = new Set(keep.avatars.map((n) => `${n}.png`));

  console.log(`实例：${inst.id}（:${inst.port}）`);
  console.log(`同步前快照：${path.relative(TASK_DIR, prePath)}（characters/ 项 ${preChar.size} 条）`);
  console.log(`应有角色名：${expected.size} 个（来自 ${path.relative(path.resolve(__dirname, '..', '..'), keepPath)}）`);
  console.log(`模式：${args.apply ? '**真删**' : '空转（不改任何文件）'}\n`);

  const targets = [];
  const skipped = { preExisting: [], expected: [], subdir: 0 };
  for (const e of fs.readdirSync(charDir, { withFileTypes: true })) {
    if (e.isDirectory()) { skipped.subdir += 1; continue; }
    if (preChar.has(e.name)) { skipped.preExisting.push(e.name); continue; }
    if (expected.has(e.name)) { skipped.expected.push(e.name); continue; }
    targets.push(e.name);
  }

  console.log(`将删除 ${targets.length} 个（全部满足三条判据）`);
  console.log(` 跳过·同步前就有：${skipped.preExisting.length}`);
  console.log(` 跳过·本次应有的正确名：${skipped.expected.length}`);
  console.log(` 跳过·子目录（精灵图）：${skipped.subdir} 个目录`);
  for (const n of targets.slice(0, 8)) console.log(`  - ${n}`);
  if (targets.length > 8) console.log(`  …（共 ${targets.length} 个，全清单见落盘台账）`);

  // 台账先落盘（删除前）：路径 / 大小 / sha256 —— 内容不入库，但删了什么可复核
  const ledger = {
    instance: inst.id,
    at: new Date().toISOString(),
    apply: args.apply,
    preManifest: path.relative(TASK_DIR, prePath),
    keepList: path.relative(path.resolve(__dirname, '..', '..'), keepPath),
    expectedCount: expected.size,
    entries: targets.map((n) => {
      const abs = path.join(charDir, n);
      const buf = fs.readFileSync(abs);
      return { name: n, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
    }),
  };
  const outPath = path.join(RESEARCH_DIR, `cleanup-st-char-artifacts-${inst.id}-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(ledger, null, 1), 'utf8');
  console.log(`\n台账 → ${outPath}（含每个文件的 sha256，删除前落盘）`);

  if (!args.apply) {
    console.log('\n[空转] 未删除任何文件。确认清单无误后再加 `--apply`。');
    return;
  }

  let removed = 0;
  for (const n of targets) {
    const abs = path.join(charDir, n);
    if (path.dirname(abs) !== charDir) throw new Error(`拒绝删除：${abs} 不在 ${charDir} 的平铺层`);
    fs.unlinkSync(abs);
    removed += 1;
  }
  console.log(`\n已删除 ${removed} 个文件。`);
})().catch((e) => {
  console.error('清理器异常：', e && e.message ? e.message : e);
  process.exit(1);
});
