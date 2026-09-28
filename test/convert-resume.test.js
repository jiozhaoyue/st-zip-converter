import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { zipIo } from '../src/core/zip-io.js';
import { convert, TARGETS } from '../src/core/transform.js';
import { logger } from '../src/core/logger.js';
import { stEntries } from '../fixtures/gen.js';

const tmpDirs = [];

async function tmpDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tavern-resume-'));
  tmpDirs.push(dir);
  return dir;
}

async function zipFrom(entries) {
  const dir = await tmpDir();
  const outPath = path.join(dir, 'in.zip');
  const writer = await zipIo.createWriter(outPath);
  for (const [name, data] of entries) {
    await writer.add(name, data);
  }
  await writer.close();
  return outPath;
}

async function readZipNames(outPath) {
  const reader = await zipIo.openReader(outPath);
  const names = [];
  const crcs = new Map();
  for await (const entry of reader.entries()) {
    names.push(entry.fileName);
    crcs.set(entry.fileName, entry.crc32);
  }
  await reader.close();
  return { names, crcs };
}

describe('convert 断点续传 (resumeCrcMap + signal + onEntryDone)', () => {
  // ⚠️ 用例名订正（2026-09-27）：原写作 `report.resumedCount > 0`，但 **`resumedCount` 这个字段
  //    全仓从未存在**（零赋值零读取）—— 真正断言的是 `report.totals.resumed`（计数）
  //    与 `report.resumed`（命中条目名单）。用例名说错字段 = 假事实（P-3 同形），已订正。
  //
  // 🔴 判据翻转（2026-09-28，真增量续传）：本用例**原来断言的是缺陷本身** ——
  //    「只给台账、不给半成品」时台账命中的条目被跳过 ⇒ 产物**缺条目**，而旧用例把它当作契约钉住了。
  //    实测后果：1500 条聊天 → 1437 条，用户拿到残缺包却看到「转换成功」。
  //    现在**跳过 = 目标包里真有那条**；只给台账 ⇒ 一条都不跳过 ⇒ 完整重做（正确）。
  it('【AC-1】只给台账、不给半成品 ⇒ 一条都不跳过，产物与全量转换一致（不再静默缺条目）', async () => {
    const entries = stEntries();
    const source = await zipFrom(entries);
    const { crcs: sourceCrcs } = await readZipNames(source);

    // 台账：命中 2 个源条目（characters 卡片与 settings.json）
    const doneEntries = new Map();
    for (const name of ['characters/Fixture Character.png', 'settings.json']) {
      expect(sourceCrcs.get(name)).not.toBeNull();
      doneEntries.set(name, sourceCrcs.get(name));
    }

    const outPath = path.join(await tmpDir(), 'resumed.zip');
    const report = await convert(source, outPath, {
      target: TARGETS.ST,
      io: zipIo,
      resumeCrcMap: doneEntries,
    });
    const json = report.toJSON();

    // 台账不再是跳过的充分条件 ⇒ 跳过 0 条
    expect(json.totals.resumed).toBe(0);
    expect(json.resumed).toEqual([]);

    // 核心：台账命中的条目**必须在产物里**（旧行为下这两条会缺席）
    const { names } = await readZipNames(outPath);
    expect(names).toContain('settings.json');
    expect(names).toContain('characters/Fixture Character.png');

    // 与「不给任何续传参数」的全量转换逐条对照 ⇒ 证明产物完整（而不是"少了几条但看着正常"）
    const baselinePath = path.join(await tmpDir(), 'baseline.zip');
    await convert(source, baselinePath, { target: TARGETS.ST, io: zipIo });
    const baseline = await readZipNames(baselinePath);
    // 前置门：基线必须非空，否则下面两侧同为空的「相等」恒真
    expect(baseline.names.length).toBeGreaterThan(0);
    expect(names.sort()).toEqual(baseline.names.sort());
  });

  it('【AC-10】降级必须可观测：有台账、无半成品 ⇒ 日志明确说「完整重做、不跳过」', async () => {
    const source = await zipFrom(stEntries());
    const { crcs } = await readZipNames(source);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      await convert(source, path.join(await tmpDir(), 'degraded.zip'), {
        target: TARGETS.ST,
        io: zipIo,
        resumeCrcMap: new Map([['settings.json', crcs.get('settings.json')]]),
      });
      expect(warn).toHaveBeenCalled();
      expect(warn.mock.calls.some((c) => String(c[0]).includes('完整重做'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('台账里含源包中不存在的伪名字 ⇒ 不跳过、不报错，产物完整', async () => {
    const source = await zipFrom(stEntries());
    const outPath = path.join(await tmpDir(), 'fake.zip');
    const report = await convert(source, outPath, {
      target: TARGETS.ST,
      io: zipIo,
      resumeCrcMap: new Map([['does/not/exist.json', 0xdeadbeef], ['settings.json', 0xdeadbeef]]),
    });
    expect(report.toJSON().totals.resumed).toBe(0);
    const { names } = await readZipNames(outPath);
    expect(names).toContain('settings.json');
  });

  it('onEntryDone 回调每完成一个源条目触发，携带 crc32', async () => {
    const entries = stEntries();
    const source = await zipFrom(entries);
    const outPath = path.join(await tmpDir(), 'done.zip');
    const done = [];
    await convert(source, outPath, {
      target: TARGETS.ST,
      io: zipIo,
      onEntryDone: (name, crc) => done.push([name, crc]),
    });
    expect(done.length).toBeGreaterThan(0);
    for (const [, crc] of done) {
      expect(typeof crc).toBe('number');
    }
    expect(done.some(([n]) => n === 'settings.json')).toBe(true);
  });

  it('signal 已中止时立即抛 AbortError', async () => {
    const entries = stEntries();
    const source = await zipFrom(entries);
    const controller = new AbortController();
    controller.abort();
    const outPath = path.join(await tmpDir(), 'aborted.zip');
    await expect(convert(source, outPath, {
      target: TARGETS.ST,
      io: zipIo,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('signal 未中止时转换正常完成', async () => {
    const entries = stEntries();
    const source = await zipFrom(entries);
    const controller = new AbortController();
    const outPath = path.join(await tmpDir(), 'normal.zip');
    const report = await convert(source, outPath, {
      target: TARGETS.ST,
      io: zipIo,
      signal: controller.signal,
    });
    expect(report.toJSON().totals.copied).toBeGreaterThan(0);
  });

  it('resumeCrcMap 接受普通对象（worker postMessage 序列化形态）且不抛错', async () => {
    const entries = stEntries();
    const source = await zipFrom(entries);
    const { crcs } = await readZipNames(source);
    const outPath = path.join(await tmpDir(), 'objmap.zip');
    // 归一化（普通对象 → Map）的**真实**守护在 test/convert-append.test.js：
    // 那里有半成品（存在门为真），归一化坏掉会让 `.get` 不可用而抛 TypeError。
    // 此处只锁「形态被接受、产物完整」这一层。
    const report = await convert(source, outPath, {
      target: TARGETS.ST,
      io: zipIo,
      resumeCrcMap: { 'settings.json': crcs.get('settings.json') },
    });
    expect(report.toJSON().totals.resumed).toBe(0);
    const { names } = await readZipNames(outPath);
    expect(names).toContain('settings.json');
  });
});
