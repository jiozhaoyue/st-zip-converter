import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { zipIo } from '../src/core/zip-io.js';
import { convert, TARGETS } from '../src/core/transform.js';
import { stEntries } from '../fixtures/gen.js';

/**
 * 真增量续传（`appendFrom`）与中止收尾（`finalizeOnAbort`）。
 *
 * 这套用例的意义在于：**旧行为下这些断言全都过不了**（那时产物会缺条目）。
 * 每个「作废半成品」的分支都必须证明**退回完整重做**，而不是静默产出残缺包。
 */

const tmpDirs = [];

async function tmpDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tavern-convert-append-'));
  tmpDirs.push(dir);
  return dir;
}

async function zipFrom(entries) {
  const outPath = path.join(await tmpDir(), 'in.zip');
  const writer = await zipIo.createWriter(outPath);
  for (const [name, data] of entries) await writer.add(name, data);
  await writer.close();
  return outPath;
}

async function readZip(outPath) {
  const reader = await zipIo.openReader(outPath);
  const names = [];
  const meta = new Map();
  try {
    for await (const entry of reader.entries()) {
      names.push(entry.fileName);
      meta.set(entry.fileName, { crc32: entry.crc32, compressedSize: entry.compressedSize });
    }
  } finally {
    await reader.close();
  }
  return { names, meta };
}

/**
 * 用真实路径造一个**半成品**：跑到第 N 个条目边界中止，`finalizeOnAbort` 把已写部分收成合法 zip。
 */
async function makePartial(source, target, stopAfter) {
  const outPath = path.join(await tmpDir(), 'partial.zip');
  const controller = new AbortController();
  let seen = 0;
  await expect(convert(source, outPath, {
    target,
    io: zipIo,
    finalizeOnAbort: true,
    signal: controller.signal,
    onProgress: () => {
      seen += 1;
      if (seen >= stopAfter) controller.abort();
    },
  })).rejects.toMatchObject({ name: 'AbortError' });
  const { names } = await readZip(outPath);
  return { outPath, names };
}

describe('convert 真增量续传（appendFrom + 存在门 + finalizeOnAbort）', () => {
  it('【AC-2】半成品 + 台账 ⇒ 命中条目不重写、产物与全量转换逐条一致，且报告可观测', async () => {
    const source = await zipFrom(stEntries());
    const baselinePath = path.join(await tmpDir(), 'baseline.zip');
    await convert(source, baselinePath, { target: TARGETS.ST, io: zipIo });
    const baseline = await readZip(baselinePath);
    expect(baseline.names.length).toBeGreaterThan(2); // 前置门：否则下面的「一致」无意义

    const { outPath: partialPath, names: partialNames } = await makePartial(source, TARGETS.ST, 4);
    // 前置门：必须真的是**半成品**（有内容、又确实少于全量），否则"续传"是空断言
    expect(partialNames.length).toBeGreaterThan(0);
    expect(partialNames.length).toBeLessThan(baseline.names.length);

    const outPath = path.join(await tmpDir(), 'resumed.zip');
    const report = await convert(source, outPath, {
      target: TARGETS.ST,
      io: zipIo,
      appendFrom: partialPath,
    });

    // 跳过了半成品里已有的那些（>0），产物却仍与全量逐条一致 ⇒ 不丢条目
    expect(report.toJSON().totals.resumed).toBeGreaterThan(0);
    const resumed = await readZip(outPath);
    expect(resumed.names.sort()).toEqual(baseline.names.sort());
  });

  it('【AC-3】字节级免重压缩：半成品里的条目在续传产物中 compressedSize 不变', async () => {
    const source = await zipFrom(stEntries());
    const { outPath: partialPath, names: partialNames } = await makePartial(source, TARGETS.ST, 4);
    expect(partialNames.length).toBeGreaterThan(0);
    const partial = await readZip(partialPath);

    const outPath = path.join(await tmpDir(), 'resumed.zip');
    await convert(source, outPath, { target: TARGETS.ST, io: zipIo, appendFrom: partialPath });
    const resumed = await readZip(outPath);

    for (const name of partial.names) {
      const a = partial.meta.get(name);
      const b = resumed.meta.get(name);
      expect(b, name).toBeTruthy();
      expect(b.compressedSize, `${name} 应原样搬运（compressedSize 相等即证明未重压缩）`).toBe(a.compressedSize);
      expect(b.crc32, `${name} crc32`).toBe(a.crc32);
    }
    // 前置门：样本里必须有非空字节，否则「相等」恒真
    expect(partial.names.every((n) => partial.meta.get(n).compressedSize > 0)).toBe(true);
  });

  it('【AC-2b + 归一化】台账用普通对象（postMessage 形态）时同样成立 ⇒ 归一化不可坏', async () => {
    const source = await zipFrom(stEntries());
    const { outPath: partialPath, names: partialNames } = await makePartial(source, TARGETS.ST, 4);
    const partial = await readZip(partialPath);

    // 普通对象台账（键 = 源条目名，此处 ST→ST 同名）
    const objMap = {};
    for (const n of partial.names) objMap[n] = partial.meta.get(n).crc32;

    const outPath = path.join(await tmpDir(), 'resumed.zip');
    const report = await convert(source, outPath, {
      target: TARGETS.ST,
      io: zipIo,
      appendFrom: partialPath,
      resumeCrcMap: objMap,
    });
    expect(report.toJSON().totals.resumed).toBeGreaterThan(0);
    expect(partialNames.length).toBeGreaterThan(0);
  });

  it('【AC-4a】源已变更（同名条目 crc 不等）⇒ 作废半成品并完整重做', async () => {
    const sourceGen = stEntries();
    const sourceA = await zipFrom(sourceGen);
    const { outPath: partialPath, names: partialNames } = await makePartial(sourceA, TARGETS.ST, 4);
    expect(partialNames.length).toBeGreaterThan(0);

    // ⚠️ 必须改**半成品里真有**的条目，否则 crc 校验根本没机会触发（第一版就踩了这个坑：
    //    stopAfter=4 的半成品里不含 settings.json，改它 ⇒ 判据无感 ⇒ 用例假红）。
    const sourceNames = new Set(sourceGen.map(([n]) => n));
    // 优先挑非 JSON：JSON 会被转换器解析，改坏了会污染其它断言
    const mutated = partialNames.find((n) => sourceNames.has(n) && !n.endsWith('.json'))
      || partialNames.find((n) => sourceNames.has(n));
    expect(mutated, '前置门：必须找到一个源/产物同名的条目，否则本用例无意义').toBeTruthy();

    const sourceB = await zipFrom(sourceGen.map(([n, d]) => (
      n === mutated ? [n, new TextEncoder().encode(`changed-content-for:${n}`)] : [n, d]
    )));

    const baselineB = path.join(await tmpDir(), 'baselineB.zip');
    await convert(sourceB, baselineB, { target: TARGETS.ST, io: zipIo });
    const expectNames = (await readZip(baselineB)).names;

    const outPath = path.join(await tmpDir(), 'resumed.zip');
    let discarded = 0;
    const report = await convert(sourceB, outPath, {
      target: TARGETS.ST,
      io: zipIo,
      appendFrom: partialPath,
      onDiscardPartial: () => { discarded += 1; },
    });

    expect(discarded).toBe(1);
    expect(report.toJSON().totals.resumed).toBe(0);
    // 退回完整重做 ⇒ 产物与 B 的全量转换一致
    expect((await readZip(outPath)).names.sort()).toEqual(expectNames.sort());

    // 直接验**内容**：产物里该条目必须是源 B 的字节，而不是源 A 的陈旧字节。
    // 这才是本判据真正要防的危害——只验名字集合的话，「混入陈旧条目」会整批漏过去。
    const crcA = (await readZip(sourceA)).meta.get(mutated).crc32;
    const crcB = (await readZip(sourceB)).meta.get(mutated).crc32;
    const crcProduct = (await readZip(outPath)).meta.get(mutated).crc32;
    expect(crcB, '前置门：源的改动必须真的改变了 crc').not.toBe(crcA);
    expect(crcProduct, '产物必须是当前源的内容（陈旧则说明半成品没被作废）').toBe(crcB);
  });

  it('【AC-4b】半成品含源中不存在的条目（源换了）⇒ 作废并完整重做', async () => {
    const sourceGen = stEntries();
    const sourceA = await zipFrom(sourceGen);
    const { outPath: partialPath } = await makePartial(sourceA, TARGETS.ST, 4);

    // 源 B 少了若干条目 ⇒ 半成品里那些名字成为「孤儿」
    const sourceB = await zipFrom(sourceGen.filter(([n]) => !n.includes('characters/')));
    const baselineB = path.join(await tmpDir(), 'baselineB.zip');
    await convert(sourceB, baselineB, { target: TARGETS.ST, io: zipIo });
    const expectNames = (await readZip(baselineB)).names;

    const outPath = path.join(await tmpDir(), 'resumed.zip');
    let discarded = 0;
    const report = await convert(sourceB, outPath, {
      target: TARGETS.ST,
      io: zipIo,
      appendFrom: partialPath,
      onDiscardPartial: () => { discarded += 1; },
    });
    expect(discarded).toBe(1);
    expect(report.toJSON().totals.resumed).toBe(0);
    expect((await readZip(outPath)).names.sort()).toEqual(expectNames.sort());
  });

  it('【AC-4c】布局不同**不必然**不可续传：判据是「名字 + 内容能对上」，不是台账里的 target 标签', async () => {
    // ⚠️ 本用例的期望值经证据修正（2026-09-28）：第一版写的是「目标布局不同 ⇒ 必然作废」，
    //    实测 ST→L 时半成品的名字仍逐条落在 L 的产物路径上、crc 也对得上 ⇒ **允许续传才是正确的**
    //    （搬进去的字节与「全量转 L」逐条一致）。判据锚在名字与内容，比锚在台账的 target 标签更强：
    //    「不兼容」真的会错位时自然被「孤儿」判据拦下（见下一条 TT 用例）。
    const source = await zipFrom(stEntries());
    const { outPath: partialPath, names: partialNames } = await makePartial(source, TARGETS.ST, 4);
    expect(partialNames.length).toBeGreaterThan(0);

    const baselineL = path.join(await tmpDir(), 'baselineL.zip');
    await convert(source, baselineL, { target: TARGETS.L, io: zipIo });
    const expectNames = (await readZip(baselineL)).names;

    const outPath = path.join(await tmpDir(), 'resumed.zip');
    let discarded = 0;
    const report = await convert(source, outPath, {
      target: TARGETS.L,
      io: zipIo,
      appendFrom: partialPath,
      onDiscardPartial: () => { discarded += 1; },
    });
    // 产物无论走哪条路都必须与全量转 L 一致（这才是真正的验收面）
    expect((await readZip(outPath)).names.sort()).toEqual(expectNames.sort());
    // 且名字能与 L 对上时应当**真的续传**（而不是无脑作废）
    if (discarded === 0) expect(report.toJSON().totals.resumed).toBeGreaterThan(0);
    else expect(report.toJSON().totals.resumed).toBe(0);
  });

  it('【AC-4d】真正错位的布局（ST 半成品 → TT 目标）⇒ 整批成为孤儿 ⇒ 作废并完整重做', async () => {
    const source = await zipFrom(stEntries());
    const { outPath: partialPath } = await makePartial(source, TARGETS.ST, 4);

    const baselineTT = path.join(await tmpDir(), 'baselineTT.zip');
    await convert(source, baselineTT, { target: TARGETS.TT, io: zipIo });
    const expectNames = (await readZip(baselineTT)).names;
    expect(expectNames.length).toBeGreaterThan(0); // 前置门

    const outPath = path.join(await tmpDir(), 'resumed.zip');
    let discarded = 0;
    const report = await convert(source, outPath, {
      target: TARGETS.TT,
      io: zipIo,
      appendFrom: partialPath,
      onDiscardPartial: () => { discarded += 1; },
    });
    expect(discarded).toBe(1);
    expect(report.toJSON().totals.resumed).toBe(0);
    expect((await readZip(outPath)).names.sort()).toEqual(expectNames.sort());
  });

  it('【AC-5】半成品损坏（非 zip / 截断）⇒ 捕获后作废并完整重做，且不抛到调用方', async () => {
    const source = await zipFrom(stEntries());
    const baselinePath = path.join(await tmpDir(), 'baseline.zip');
    await convert(source, baselinePath, { target: TARGETS.ST, io: zipIo });
    const expectNames = (await readZip(baselinePath)).names;

    const junk = path.join(await tmpDir(), 'junk.zip');
    await writeFile(junk, new TextEncoder().encode('not a zip at all, just junk bytes'));

    const truncated = path.join(await tmpDir(), 'truncated.zip');
    const { outPath: goodPartial } = await makePartial(source, TARGETS.ST, 4);
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(goodPartial);
    await writeFile(truncated, buf.subarray(0, Math.max(1, Math.floor(buf.length / 3))));

    for (const bad of [junk, truncated]) {
      const outPath = path.join(await tmpDir(), 'resumed.zip');
      let discarded = 0;
      const report = await convert(source, outPath, {
        target: TARGETS.ST,
        io: zipIo,
        appendFrom: bad,
        onDiscardPartial: () => { discarded += 1; },
      });
      expect(discarded, bad).toBe(1);
      expect(report.toJSON().totals.resumed, bad).toBe(0);
      expect((await readZip(outPath)).names.sort(), bad).toEqual(expectNames.sort());
    }
  });

  it('【AC-6】中止 ⇒ 收尾成合法 zip；真失败 ⇒ 仍 abort，绝不伪装成「看着完整」的产物', async () => {
    /**
     * 假 writer 必须**忠实于真 writer 的失败时序**：真 writer 的条目写入是投递式的
     * （`add`/`addLazy` 同步返回、失败在 `close()` 处汇合），所以**不能**让它们同步抛——
     * 那样每个条目都会变成一个未处理拒绝（首版就踩了：全量跑时报 21 errors）。
     * 这里用 `getStoreStats()` 作**同步注入点**：它在 `try` 块内、`close()` 之前被调用一次，
     * 抛出即沿正常错误路径冒出。中止则走真实的 `signal` 路径。
     */
    const mkFakeWriter = (throwOnStats) => {
      const calls = { close: 0, abort: 0 };
      return {
        calls,
        async add() {},
        async addLazy() {},
        async waitForRoom() {},
        getStoreStats() { if (throwOnStats) throw throwOnStats; return { count: 0, bytes: 0 }; },
        async close() { calls.close += 1; return null; },
        async abort() { calls.abort += 1; },
      };
    };
    const source = await zipFrom(stEntries());
    const fakeIo = (fake) => ({ openReader: zipIo.openReader.bind(zipIo), createWriter: async () => fake });

    // ① 中止（真实 signal 路径）+ finalizeOnAbort ⇒ 必须 close（产出半成品），且**不** abort
    {
      const fake = mkFakeWriter(null);
      const controller = new AbortController();
      controller.abort();
      await expect(convert(source, path.join(await tmpDir(), 'a.zip'), {
        target: TARGETS.ST, io: fakeIo(fake), signal: controller.signal, finalizeOnAbort: true,
      })).rejects.toMatchObject({ name: 'AbortError' });
      // 中止 ⇒ 走收尾（close 一次），绝不走 abort
      expect(fake.calls.close).toBe(1);
      expect(fake.calls.abort).toBe(0);
    }

    // ② 真失败 + finalizeOnAbort ⇒ 仍 abort（**不得** close：否则失败被伪装成暂停产物）
    {
      const fake = mkFakeWriter(new Error('boom'));
      await expect(convert(source, path.join(await tmpDir(), 'b.zip'), {
        target: TARGETS.ST, io: fakeIo(fake), finalizeOnAbort: true,
      })).rejects.toThrow('boom');
      expect(fake.calls.abort).toBe(1);
      expect(fake.calls.close).toBe(0);
    }

    // ③ 真失败 + 未开 finalizeOnAbort ⇒ 同样 abort（默认行为零变化）
    {
      const fake = mkFakeWriter(new Error('boom'));
      await expect(convert(source, path.join(await tmpDir(), 'c.zip'), {
        target: TARGETS.ST, io: fakeIo(fake),
      })).rejects.toThrow('boom');
      expect(fake.calls.abort).toBe(1);
      expect(fake.calls.close).toBe(0);
    }
  });

  it('【AC-6b】真实路径：不开 finalizeOnAbort 的中止不落盘（旧语义零变化）', async () => {
    const source = await zipFrom(stEntries());
    const outPath = path.join(await tmpDir(), 'aborted.zip');
    const controller = new AbortController();
    let seen = 0;
    await expect(convert(source, outPath, {
      target: TARGETS.ST,
      io: zipIo,
      signal: controller.signal,
      onProgress: () => { seen += 1; if (seen >= 4) controller.abort(); },
    })).rejects.toMatchObject({ name: 'AbortError' });
    // 中止即丢弃：产物文件**不存在**（不是「存在但残缺」——那才是缺陷形态）
    await expect(access(outPath)).rejects.toThrow();
  });
});
