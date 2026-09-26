/**
 * 修复「跨宿主 `settings.json` 合并」造成的膨胀与污染（**只删陌生键，不动共有键**）
 *
 * ## 事故（2026-09-26 实测）
 *
 * `import-st.cjs` 的 settings 分支原语义是 **`{...目标, ...包内}`（并集）**，
 * 结果把**源宿主（Luker）特有的顶层键**整块写进了 ST：
 *
 * | 目标 | 合并前 | 合并后 | 源包内 |
 * | --- | --- | --- | --- |
 * | Dev ST | 44,564 B | **113,680,214 B** | 22,843,284 B |
 * | Real ST | 27,373 B | **113,654,958 B** | 同上 |
 *
 * 其中 `settings`（46 MB）与 `openai_settings`（34.5 MB）是 **Luker 的 schema**（ST 用 `oai_settings`）。
 * 后果不是"文件大一点"：ST 客户端每次都要解析/回存这个 113 MB 对象
 * （`saveSettings` 轮询重试 → `backups/settings_*` 一路涨到 113 MB），
 * **整个前端卡在 settings 未就绪** ⇒ `activateExtensions()` 永不执行 ⇒
 * **所有第三方扩展都不加载**（本插件当然也不加载，E2E 冒烟因此从 53/53 掉到 50/53）。
 *
 * ## 修法
 *
 * **判据**：目标**自己**的 settings（取它自己的 `backups/settings_<user>_*.json` 里
 * **合并前**那一份）就是"ST 认识的键集"。当前文件里**不在该键集内**的顶层键 = 陌生键 ⇒ 删除。
 * 共有键（两个宿主都有的，如 `extension_settings`）**保留** —— 那是用户要求的"覆盖同名"内容，
 * 删它等于擅自回退同步。
 *
 * ⚠️ 与 `import-st.cjs` 的新策略配套：那边已改为**按目标已知键做交集合并**，
 * 从此不会再产生陌生键。本脚本只用于**清理已经在盘上的那一次**。
 *
 * 用法：
 *   node scripts/instance-sync/repair-settings-merge.cjs --id dev-st            # 空转（默认）
 *   node scripts/instance-sync/repair-settings-merge.cjs --id dev-st --apply    # 真写回
 *   ... --schema <目标自己的旧 settings.json>    # 不传则自动挑 backups/ 里最接近合并前的一份
 *
 * 纪律：写回前先把**当前文件**整份复制到 `test-results/`（可回滚），并落一份差异台账。
 */

const fs = require('fs');
const path = require('path');

const { getInstance, userDirOf } = require('../../e2e/lib/instances.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TASK_DIR = path.join(REPO_ROOT, '.trellis', 'tasks', '09-26-all-instance-data-sync-e2e');
const RESEARCH_DIR = path.join(TASK_DIR, 'research');
const BACKUP_DIR = path.join(REPO_ROOT, 'test-results', 'settings-repair-backups');

function parseArgs(argv) {
  const out = { id: '', handle: 'default-user', apply: false, schema: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--id') out.id = argv[++i] || '';
    else if (argv[i] === '--handle') out.handle = argv[++i] || '';
    else if (argv[i] === '--apply') out.apply = true;
    else if (argv[i] === '--schema') out.schema = argv[++i] || '';
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const inst = getInstance(args.id);
  if (!inst) throw new Error(`未知实例 id：${args.id}`);
  if (inst.host !== 'st') throw new Error(`[${inst.id}] 本修复只针对 ST 目标（本次事故的宿主）`);

  const userDir = userDirOf(inst.id);
  const curPath = path.join(userDir, 'settings.json');
  const curSize = fs.statSync(curPath).size;

  /** 挑「目标自己的旧 settings」当 schema（可逗号分隔多个，取**键的并集**）。
   *
   * 为什么是并集而不是"最小的那一份"：膨胀是单调的，但**旧版本的 settings 可能少几个键**
   * （实测：Dev ST 今天的备份有 22 键、Real ST 一个月前的只有 19 键，差的
   * `accountStorage`/`background`/`proxies` 都是 ST 今天确实会写、也确实认识的键）。
   * 取并集 ⇒ 判据**只会更保守**（少删键），不会把宿主认识的键误当陌生键删掉。
   */
  const schemaPaths = (args.schema ? args.schema.split(',') : []).map((s) => s.trim()).filter(Boolean);
  if (!schemaPaths.length) {
    const dir = path.join(userDir, 'backups');
    const cands = fs.readdirSync(dir)
      .filter((n) => /^settings_.*\.json$/.test(n))
      .map((n) => path.join(dir, n))
      // 合并前的证据特征：体积是**正常量级**（< 1 MB）；被污染的那几份都在 20 MB 以上
      .filter((p) => fs.statSync(p).size < 1_048_576);
    if (!cands.length) throw new Error('backups/ 里没有"合并前"量级的 settings_*.json，无法确定目标键集');
    schemaPaths.push(...cands);
  }

  const cur = JSON.parse(fs.readFileSync(curPath, 'utf8'));
  const known = new Set();
  for (const p of schemaPaths) {
    for (const k of Object.keys(JSON.parse(fs.readFileSync(p, 'utf8')))) known.add(k);
  }
  const foreign = Object.keys(cur).filter((k) => !known.has(k));

  console.log(`实例：${inst.id}（:${inst.port}）`);
  console.log(`当前 settings.json：${curSize.toLocaleString()} B，顶层键 ${Object.keys(cur).length} 个`);
  console.log(`键集基准（${schemaPaths.length} 份，取并集共 ${known.size} 键）：`);
  for (const p of schemaPaths) {
    console.log(`  - ${path.relative(REPO_ROOT, p)}（${fs.statSync(p).size.toLocaleString()} B）`);
  }
  console.log(`\n判为**陌生键**（不在目标的键集内）：${foreign.length} 个`);
  for (const k of foreign) {
    console.log(`  - ${k}（${Buffer.byteLength(JSON.stringify(cur[k]), 'utf8').toLocaleString()} B）`);
  }
  const keep = Object.keys(cur).filter((k) => known.has(k));
  console.log(`保留的共有键：${keep.length} 个（含 extension_settings 等，属用户要求的覆盖同名内容）`);

  const stripped = {};
  for (const k of keep) stripped[k] = cur[k];
  const outText = JSON.stringify(stripped);
  console.log(`\n预期结果：${curSize.toLocaleString()} B → ${Buffer.byteLength(outText, 'utf8').toLocaleString()} B`);

  const ledger = {
    instance: inst.id,
    at: new Date().toISOString(),
    apply: args.apply,
    schemaSources: schemaPaths.map((x) => path.relative(REPO_ROOT, x)),
    beforeBytes: curSize,
    afterBytes: Buffer.byteLength(outText, 'utf8'),
    foreignKeys: foreign,
    keptKeys: keep,
  };
  fs.mkdirSync(RESEARCH_DIR, { recursive: true });
  const ledgerPath = path.join(RESEARCH_DIR, `repair-settings-merge-${inst.id}-${Date.now()}.json`);
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 1), 'utf8');
  console.log(`台账 → ${ledgerPath}`);

  if (!args.apply) {
    console.log('\n[空转] 未写入。确认清单无误后再加 `--apply`。');
    return;
  }

  // 先整份留底（可回滚），再写回
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const keepCopy = path.join(BACKUP_DIR, `${inst.id}-settings-before-repair-${Date.now()}.json`);
  fs.copyFileSync(curPath, keepCopy);
  console.log(`当前文件已留底 → ${keepCopy}`);

  fs.writeFileSync(curPath, outText, 'utf8');
  console.log(`已写回 ${inst.id}/settings.json（${fs.statSync(curPath).size.toLocaleString()} B）`);
})().catch((e) => {
  console.error('修复器异常：', e && e.message ? e.message : e);
  process.exit(1);
});
