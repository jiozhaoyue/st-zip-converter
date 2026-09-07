import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { zipIo } from '../src/core/zip-io.js';
import { convert, TARGETS } from '../src/core/transform.js';
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
  it('crc 命中清单的条目跳过且 report.resumedCount > 0；未命中条目正常写出', async () => {
    const entries = stEntries();
    const source = await zipFrom(entries);
    const { crcs: sourceCrcs } = await readZipNames(source);

    // 构造清单：命中 2 个源条目（characters 卡片与 settings.json）
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
    expect(json.totals.resumed).toBe(2);
    expect(json.resumed).toContain('characters/Fixture Character.png');
    expect(json.resumed).toContain('settings.json');

    const { names } = await readZipNames(outPath);
    expect(names).not.toContain('settings.json');
    expect(names).not.toContain('characters/Fixture Character.png');
    // 未命中的条目正常写出
    expect(names).toContain('secrets.json');
  });

  it('crc 值不匹配（源内容已变）不跳过，正常写出', async () => {
    const entries = stEntries();
    const source = await zipFrom(entries);
    const outPath = path.join(await tmpDir(), 'stale.zip');
    const report = await convert(source, outPath, {
      target: TARGETS.ST,
      io: zipIo,
      resumeCrcMap: new Map([['settings.json', 0xdeadbeef]]),
    });
    const json = report.toJSON();
    expect(json.totals.resumed).toBe(0);
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

  it('resumeCrcMap 接受普通对象（worker postMessage 序列化形态）', async () => {
    const entries = stEntries();
    const source = await zipFrom(entries);
    const { crcs } = await readZipNames(source);
    const outPath = path.join(await tmpDir(), 'objmap.zip');
    const report = await convert(source, outPath, {
      target: TARGETS.ST,
      io: zipIo,
      resumeCrcMap: { 'settings.json': crcs.get('settings.json') },
    });
    expect(report.toJSON().totals.resumed).toBe(1);
  });
});
