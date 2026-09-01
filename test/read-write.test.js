import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { ZipReader } from '../src/core/read.js';
import { ZipWriter } from '../src/core/write.js';

async function tmpDir() {
  return await mkdtemp(path.join(os.tmpdir(), 'tavern-convert-'));
}

describe('ZipWriter / ZipReader 往返', () => {
  it('Buffer 条目往返后条目名与内容一致', async () => {
    const dir = await tmpDir();
    const outPath = path.join(dir, 'roundtrip.zip');
    const writer = await ZipWriter.create(outPath);
    const payload = Buffer.from('hello tavern', 'utf8');
    const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x7f]);
    writer.add('a/text.txt', payload);
    writer.add('b/binary.bin', binary);
    writer.add('nested/deep/c.json', Buffer.from('{"x":1}', 'utf8'));
    await writer.close();

    const reader = await ZipReader.open(outPath);
    expect(reader.entryCount).toBe(3);
    const seen = new Map();
    for await (const entry of reader.entries()) {
      seen.set(entry.fileName, await entry.read());
    }
    await reader.close();

    expect(seen.get('a/text.txt').toString('utf8')).toBe('hello tavern');
    expect(Buffer.compare(seen.get('b/binary.bin'), binary)).toBe(0);
    expect(seen.get('nested/deep/c.json').toString('utf8')).toBe('{"x":1}');
    expect([...seen.keys()].sort()).toEqual(['a/text.txt', 'b/binary.bin', 'nested/deep/c.json'].sort());
  });

  it('流式工厂条目与大一点的伪流往返一致', async () => {
    const dir = await tmpDir();
    const outPath = path.join(dir, 'stream.zip');
    const writer = await ZipWriter.create(outPath);
    const big = Buffer.alloc(1 << 20, 0x61); // 1 MiB
    writer.add('big.bin', () => streamFrom(big));
    writer.add('small.txt', Buffer.from('small', 'utf8'));
    await writer.close();

    const reader = await ZipReader.open(outPath);
    const contents = new Map();
    for await (const entry of reader.entries()) {
      contents.set(entry.fileName, await entry.read());
    }
    await reader.close();

    expect(contents.get('big.bin').byteLength).toBe(big.byteLength);
    expect(Buffer.compare(contents.get('big.bin'), big)).toBe(0);
    expect(contents.get('small.txt').toString('utf8')).toBe('small');
  });

  it('skip() 跳过条目后仍能继续迭代', async () => {
    const dir = await tmpDir();
    const outPath = path.join(dir, 'skip.zip');
    const writer = await ZipWriter.create(outPath);
    for (const name of ['one.txt', 'two.txt', 'three.txt']) {
      writer.add(name, Buffer.from(name, 'utf8'));
    }
    await writer.close();

    const reader = await ZipReader.open(outPath);
    const visited = [];
    for await (const entry of reader.entries()) {
      visited.push(entry.fileName);
      if (entry.fileName === 'two.txt') {
        entry.skip();
      } else {
        await entry.read();
      }
    }
    await reader.close();
    expect(visited).toEqual(['one.txt', 'two.txt', 'three.txt']);
  });

  it('固定 mtime:两次产出的条目时间一致', async () => {
    const dir = await tmpDir();
    for (const name of ['p1.zip', 'p2.zip']) {
      const writer = await ZipWriter.create(path.join(dir, name));
      writer.add('x.txt', Buffer.from('x', 'utf8'));
      await writer.close();
    }
    const [r1, r2] = [await ZipReader.open(path.join(dir, 'p1.zip')), await ZipReader.open(path.join(dir, 'p2.zip'))];
    const t1 = [];
    const t2 = [];
    for await (const e of r1.entries()) t1.push(e.lastModified?.getTime());
    for await (const e of r2.entries()) t2.push(e.lastModified?.getTime());
    await r1.close();
    await r2.close();
    expect(t1).toEqual(t2);
  });
});

function streamFrom(buffer) {
  return Readable.from([buffer]);
}
