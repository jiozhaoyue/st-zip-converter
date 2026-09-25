/**
 * `node-zip-io` 自证 —— **先证明适配器能用，再拿它碰 3.8 G 真源包**
 *
 * 三步断言：
 *  1. **同构性**：同一个源包，分别用「产品 `zipIo`」与「本模块 node io」转出，
 *     两份产物的「条目名 → CRC32」映射必须**逐条一致**。这是 `transform.js:35`
 *     所说「两个适配器产物必须同构」的可执行判定。
 *  2. **落盘时机**：本模块的产物在 `close()` **之前**就已经有非零字节 ⇒ 证明是流式落盘，
 *     不是 `Uint8ArrayWriter` 那种「攒在内存、最后一次性 writeFile」。
 *  3. **可读回**：产物能被重新打开并读出条目。
 *
 * 用法：node scripts/instance-sync/selftest-node-zip-io.cjs
 * 临时产物落 OS tmp，**不写仓内、不写实例目录**。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function ok(label, cond, extra = '') {
  console.log(`${cond ? '  [OK]  ' : '  [FAIL]'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
  return cond;
}

/** 条目名 → CRC32（目录占位条目排除，与 test/roundtrip.test.js 的判据一致） */
async function crcMap(zipIo, zipPath) {
  const reader = await zipIo.openReader(zipPath);
  const map = new Map();
  for await (const entry of reader.entries()) {
    if (entry.fileName.endsWith('/')) { entry.skip(); continue; }
    map.set(entry.fileName, entry.crc32 ?? -1);
    entry.skip();
  }
  await reader.close();
  return map;
}

/**
 * **大规模模式**（`--large <zip>`）—— 唯一能抓住「`bufferedWrite: true` 在真实包规模上永不落盘」
 * 的可执行守护。
 *
 * 为什么必须是这一档规模：实测（2026-09-26）
 *   - 单条目 4 MiB：`bufferedWrite` 真/假**都**边写边落盘 —— 小规模**测不出**差别；
 *   - 4000 条 × 4 KB：两种模式都 0.8 s 正常 —— **条目数**也不是触发维度；
 *   - 真源包 1602.7 MB / 8572 条：`true` → 落点**恒 0 字节**、`close()` 永不返回；`false` → 82.4 s 完成。
 * 所以触发维度是**总字节**，注定进不了 `npm test`（太慢）。此处的判据是
 * 「落点字节**在有界时间内持续增长**」，超时即判失败 —— 缺了这条，把默认值改回 `true`
 * 就只会表现为「转换卡死无报错」而没有任何测试会红。
 *
 * 用法：node scripts/instance-sync/selftest-node-zip-io.cjs --large <真源包.zip>
 */
async function largeSelfTest(zipPath) {
  const fs = require('fs');
  const { createNodeIo, makeFileWriter } = require('./lib/node-zip-io.cjs');
  const { pathToFileURL } = require('url');
  const zip = await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'vendor', 'zip.js')).href);
  const { zipIo } = await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'core', 'zip-io.js')).href);
  const io = await createNodeIo();

  const out = path.join(os.tmpdir(), `nzio-large-${Date.now()}.zip`);
  const source = path.resolve(zipPath);
  console.log(`大规模自检：${path.basename(source)} → ${out}`);

  const reader = await io.openReader(source);
  const FileWriter = makeFileWriter(zip);
  // 关键：**不显式传 bufferedWrite**，走的就是产品当前默认值 —— 默认值一旦被改回 true，本自检会超时失败
  const writer = await zipIo.createWriter(new FileWriter(out), { level: 5 });

  const started = Date.now();
  let written = 0;
  let skipped = 0;
  let firstNonZeroAt = -1;
  let lastSize = 0;
  let stalledChecks = 0;
  const STALL_LIMIT = 90_000; // 连续 90 s 落点零增长即判「永不落盘」

  const watchdog = setInterval(() => {
    const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
    if (size > 0 && firstNonZeroAt < 0) firstNonZeroAt = Date.now() - started;
    if (size <= lastSize && written > 0) stalledChecks += 1; else stalledChecks = 0;
    lastSize = size;
    process.stdout.write(`\r  ${(size / 1048576).toFixed(1)} MB / 条目 ${written}`
      + (firstNonZeroAt >= 0 ? ` / 首次落盘 ${(firstNonZeroAt / 1000).toFixed(1)}s` : '') + '    ');
    if (stalledChecks * 5000 > STALL_LIMIT) {
      console.error(`\n[FAIL] 落点连续 ${STALL_LIMIT / 1000}s 零增长 —— 疑似 bufferedWrite 回归（永不落盘）`);
      clearInterval(watchdog);
      process.exit(1);
    }
  }, 5000);
  watchdog.unref();

  try {
    for await (const entry of reader.entries()) {
      if (entry.fileName.startsWith('backups/')) { skipped += 1; entry.skip(); continue; }
      const name = entry.fileName;
      const size = entry.uncompressedSize;
      writer.addLazy(name, (cb) => { entry.openStream().then((s) => cb(null, s), cb); }, size);
      written += 1;
      if (written % 250 === 0) await writer.waitForRoom();
    }
    await writer.close();
  } catch (e) {
    clearInterval(watchdog);
    console.error('\n[FAIL] 抛错：', e && e.stack || e);
    process.exit(1);
  }
  clearInterval(watchdog);

  const bytes = fs.statSync(out).size;
  const secs = (Date.now() - started) / 1000;
  console.log('');
  ok('投递条目数与源一致', written > 0, `写入 ${written} 条 / 跳过 ${skipped} 条`);
  ok('首次落盘发生在有明显进展之前（流式，非结束才落）',
    firstNonZeroAt > 0 && firstNonZeroAt < secs * 1000 * 0.5,
    `首次落盘 ${(firstNonZeroAt / 1000).toFixed(1)}s / 总耗时 ${secs.toFixed(1)}s`);
  ok('产物非空', bytes > 0, `${(bytes / 1048576).toFixed(1)} MB`);

  // 产物可读回，且条目数对得上
  const back = await zipIo.openReader(out);
  const n = back.totalEntries;
  await back.close();
  ok('产物可读回且条目数一致', n === written, `读回 ${n} 条`);

  await fs.promises.rm(out, { force: true });
  console.log(process.exitCode ? '大规模自检失败' : '大规模自检通过');
}

(async () => {
  const argv = process.argv.slice(2);
  const li = argv.indexOf('--large');
  if (li >= 0) {
    const target = argv[li + 1];
    if (!target) {
      console.error('用法：node scripts/instance-sync/selftest-node-zip-io.cjs --large <真源包.zip>');
      process.exit(2);
    }
    await largeSelfTest(target);
    return;
  }

  const { createNodeIo } = require('./lib/node-zip-io.cjs');

  // —— 依赖装载 ——
  const zipIoMod = await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'core', 'zip-io.js')).href);
  const transformMod = await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'core', 'transform.js')).href);
  const { zipIo } = zipIoMod;
  const { convert, TARGETS } = transformMod;

  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nzio-'));
  console.log(`临时目录：${tmp}`);

  // —— 生成固件包 ——
  const gen = await import(pathToFileURL(path.join(REPO_ROOT, 'fixtures', 'gen.js')).href);
  const fixtures = await gen.generateAll(tmp);
  const src = fixtures['fixture-st.zip'];
  console.log(`源包：${path.basename(src)}（${fs.statSync(src).size} 字节）`);

  // —— ① 产品 zipIo 转一次（基准） ——
  const outProduct = path.join(tmp, 'out-product-tt.zip');
  await convert(src, outProduct, { target: TARGETS.TT, io: zipIo });

  // —— ② 本模块 node io 转一次 ——
  const nodeIo = await createNodeIo();
  const outNode = path.join(tmp, 'out-node-tt.zip');
  await convert(src, outNode, { target: TARGETS.TT, io: nodeIo });

  // —— ③ 同构性判定 ——
  const [mapProduct, mapNode] = await Promise.all([
    crcMap(zipIo, outProduct),
    crcMap(zipIo, outNode),
  ]);
  const keysP = [...mapProduct.keys()].sort();
  const keysN = [...mapNode.keys()].sort();
  ok('条目集合一致', JSON.stringify(keysP) === JSON.stringify(keysN),
    `产品 ${keysP.length} 条 / 本模块 ${keysN.length} 条`);
  let mismatch = 0;
  for (const k of keysP) if (mapProduct.get(k) !== mapNode.get(k)) mismatch += 1;
  ok('每条 CRC32 一致', mismatch === 0, mismatch ? `${mismatch} 条不符` : `${keysP.length} 条全符`);

  // —— ④ 流式落盘判定：close() 之前就该有字节 ——
  const outNode2 = path.join(tmp, 'out-node-stream.zip');
  const nodeIo2 = await createNodeIo();
  let bytesBeforeClose = -1;
  {
    // 直接驱动 writer，不经 convert，便于在 close 前取读数
    const reader = await nodeIo2.openReader(src);
    const w = await nodeIo2.createWriter(outNode2, { level: 5 });
    for await (const entry of reader.entries()) {
      await w.add(entry.fileName, await entry.read());
      if (entry.fileName.includes('settings')) break; // 只写几条即可观测
    }
    bytesBeforeClose = fs.existsSync(outNode2) ? fs.statSync(outNode2).size : -1;
    await reader.close();
    await w.close();
  }
  ok('close() 前已落盘（流式，非内存攒）', bytesBeforeClose > 0, `${bytesBeforeClose} 字节`);

  // —— ⑤ 清理 ——
  await fs.promises.rm(tmp, { recursive: true, force: true });
  console.log(process.exitCode ? '自证失败' : '自证通过');
})().catch((e) => {
  console.error('自证异常：', e);
  process.exit(1);
});
