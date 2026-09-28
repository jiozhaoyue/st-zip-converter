import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { zipIo } from '../src/core/zip-io.js';

/**
 * `zipIo.createWriter` 的真增量续传两个新能力：存在门 `has()` 与半成品搬运 `appendFrom()`。
 *
 * 本文件锁的是**契约与方向**，不是实现细节：
 *   - 搬运必须**字节级保持**（`compressedSize` 相等）⇒ 证明零重压缩（否则「增量」名不副实）；
 *   - 搬运后 `has()` 必须为真 ⇒ 存在门的前提；
 *   - 搬运后 `add` 同名条目必须**静默早返**（`written` 名单互锁）⇒ 这正是「同源校验必须前置」的机理，
 *     没有它，源已变时会静默保留陈旧条目。
 */

const tmpDirs = [];

async function tmpDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tavern-zip-append-'));
  tmpDirs.push(dir);
  return dir;
}

/** 可压缩内容（deflate 命中）与已压缩扩展名（Store level 0，绕过 deflate）各一条 */
function compressible(size) {
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i++) buf[i] = i % 251;
  return buf;
}

async function writeZip(entries) {
  const outPath = path.join(await tmpDir(), 'out.zip');
  const writer = await zipIo.createWriter(outPath, { level: 5 });
  for (const [name, data] of entries) {
    await writer.add(name, data);
  }
  await writer.close();
  return { outPath, writer };
}

async function readEntries(source) {
  const reader = await zipIo.openReader(source);
  const out = [];
  try {
    for await (const entry of reader.entries()) {
      out.push({
        name: entry.fileName,
        crc32: entry.crc32,
        compressedSize: entry.compressedSize,
        compressionMethod: entry.compressionMethod,
        data: entry.read ? await entry.read() : null,
      });
    }
  } finally {
    await reader.close();
  }
  return out;
}

const text = (s) => new TextEncoder().encode(s);

describe('zip-io appendFrom（半成品搬运）与 has（存在门）', () => {
  it('① 搬运后产物含半成品全部条目，且 has() 为真', async () => {
    const half = await writeZip([
      ['a.txt', text('AAAA')],
      ['dir/b.bin', compressible(200000)],
      ['stored.png', text('PNGDATA')],
    ]);

    const target = path.join(await tmpDir(), 'resumed.zip');
    const writer = await zipIo.createWriter(target, { level: 5 });
    const manifest = await writer.appendFrom(half.outPath);

    expect(manifest.map((m) => m.name).sort()).toEqual(['a.txt', 'dir/b.bin', 'stored.png']);
    expect(manifest.every((m) => typeof m.crc32 === 'number' && m.compressedSize > 0)).toBe(true);

    await writer.close();
    const names = (await readEntries(target)).map((e) => e.name);
    expect(names.sort()).toEqual(['a.txt', 'dir/b.bin', 'stored.png']);
  });

  it('② 搬运是字节级保持：同名字条目的 compressedSize / method / crc 与半成品相等（零重压缩）', async () => {
    const half = await writeZip([
      ['a.txt', text('AAAA')],
      ['dir/b.bin', compressible(200000)],
      ['stored.png', text('PNGDATA')],
    ]);
    const before = await readEntries(half.outPath);

    const target = path.join(await tmpDir(), 'resumed.zip');
    const writer = await zipIo.createWriter(target, { level: 5 });
    await writer.appendFrom(half.outPath);
    await writer.close();
    const after = await readEntries(target);

    for (const b of before) {
      const a = after.find((x) => x.name === b.name);
      expect(a, b.name).toBeTruthy();
      expect(a.compressedSize, `${b.name} compressedSize 必须相等（相等即证明未重压缩）`).toBe(b.compressedSize);
      expect(a.compressionMethod, `${b.name} method`).toBe(b.compressionMethod);
      expect(a.crc32, `${b.name} crc32`).toBe(b.crc32);
    }
    // 前置门：两条的 compressedSize 不得同时为 0，否则上面的「相等」恒真
    expect(before.every((b) => b.compressedSize > 0)).toBe(true);
    // 且 deflate 与 Store 两种方法都要出现在样本里，否则「方法保持」是空断言
    expect(new Set(before.map((b) => b.compressionMethod)).size).toBeGreaterThan(1);
  });

  it('③ 搬运后继续 add 新条目：两者都在，且顺序为「搬运在前」', async () => {
    const half = await writeZip([['a.txt', text('AAAA')]]);

    const target = path.join(await tmpDir(), 'resumed.zip');
    const writer = await zipIo.createWriter(target, { level: 5 });
    await writer.appendFrom(half.outPath);
    await writer.add('c.txt', text('CCCC'));
    await writer.close();

    const names = (await readEntries(target)).map((e) => e.name);
    expect(names).toEqual(['a.txt', 'c.txt']);

    const entries = await readEntries(target);
    expect(new TextDecoder().decode(entries.find((e) => e.name === 'c.txt').data)).toBe('CCCC');
  });

  it('④ 负例：坏包 / 空包 ⇒ 抛错（且在写入任何数据之前，由中央目录读取阶段拦下）', async () => {
    const badPath = path.join(await tmpDir(), 'bad.zip');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(badPath, text('this is not a zip at all'));

    const emptyPath = path.join(await tmpDir(), 'empty.zip');
    await writeFile(emptyPath, new Uint8Array(0));

    for (const p of [badPath, emptyPath]) {
      const outPath = path.join(await tmpDir(), 't.zip');
      const writer = await zipIo.createWriter(outPath);
      await expect(writer.appendFrom(p)).rejects.toThrow();
      // 失败**不得**污染名字登记：否则后续同名 add 会静默早返、产出「看着正常」的空包。
      // 坏包/空包在中央目录阶段就抛、尚未写入任何字节 ⇒ 该 writer 仍可正常使用（正面证明无污染）。
      await writer.add('a.txt', text('AFTER-FAILURE'));
      await writer.close();
      const after = await readEntries(outPath);
      expect(after.map((e) => e.name), p).toEqual(['a.txt']);
      expect(new TextDecoder().decode(after[0].data), p).toBe('AFTER-FAILURE');
    }
  });

  it('⑤ 互锁：搬运后 add 同名条目是**静默早返**（产物仍是半成品内容，不是新一轮的）', async () => {
    const half = await writeZip([['a.txt', text('FROM-PARTIAL')]]);

    const target = path.join(await tmpDir(), 'resumed.zip');
    const writer = await zipIo.createWriter(target, { level: 5 });
    const manifest = await writer.appendFrom(half.outPath);
    expect(manifest.map((m) => m.name)).toContain('a.txt');

    await writer.add('a.txt', text('FROM-SOURCE')); // 必须**不生效**
    await writer.close();

    const after = await readEntries(target);
    expect(after.map((e) => e.name)).toEqual(['a.txt']);
    expect(new TextDecoder().decode(after[0].data)).toBe('FROM-PARTIAL');
  });
});
