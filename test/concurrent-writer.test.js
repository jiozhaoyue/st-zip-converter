import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { zipIo } from '../src/core/zip-io.js';

const tmpDirs = [];

async function tmpDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tavern-concurrent-'));
  tmpDirs.push(dir);
  return dir;
}

describe('zipIo 并发写入管线', () => {
  it('并发 add 100 条目：名称与内容字节级一致', async () => {
    const entries = [];
    for (let i = 0; i < 100; i++) {
      const size = 512 + i * 97;
      const d = new Uint8Array(size);
      for (let j = 0; j < size; j++) d[j] = (i * 31 + j) & 0xff;
      entries.push([`dir${i % 7}/f${i}.bin`, d]);
    }

    const writer = await zipIo.createWriter(await path.join(await tmpDir(), 'out.zip'));
    await Promise.all(entries.map(([n, d]) => writer.add(n, d)));
    await writer.close();

    const reader = await zipIo.openReader(path.join(tmpDirs[tmpDirs.length - 1], 'out.zip'));
    const seen = new Map();
    for await (const e of reader.entries()) seen.set(e.fileName, await e.read());
    await reader.close();

    expect(seen.size).toBe(entries.length);
    for (const [n, d] of entries) {
      const got = seen.get(n);
      expect(got?.length).toBe(d.length);
      expect(got.every((v, k) => v === d[k])).toBe(true);
    }
  });

  it('重复条目名去重：后写不覆盖先写也不报错', async () => {
    const dir = await tmpDir();
    const out = path.join(dir, 'dedup.zip');
    const writer = await zipIo.createWriter(out);
    const p1 = writer.add('dup.txt', new TextEncoder().encode('first'));
    const p2 = writer.add('dup.txt', new TextEncoder().encode('second'));
    await Promise.all([p1, p2]);
    await writer.close();

    const reader = await zipIo.openReader(out);
    const seen = new Map();
    for await (const e of reader.entries()) seen.set(e.fileName, await e.read());
    await reader.close();
    expect(seen.size).toBe(1);
    expect(new TextDecoder().decode(seen.get('dup.txt'))).toBe('first');
  });

  it('waitForRoom 背压后 close：全部条目完整', async () => {
    const dir = await tmpDir();
    const out = path.join(dir, 'backpressure.zip');
    const writer = await zipIo.createWriter(out);
    const adds = [];
    for (let i = 0; i < 40; i++) {
      adds.push(writer.add(`bp/f${i}.bin`, new Uint8Array(2048).fill(i & 0xff)));
      if (i % 10 === 9) await writer.waitForRoom();
    }
    await Promise.all(adds);
    await writer.close();

    const reader = await zipIo.openReader(out);
    let count = 0;
    for await (const e of reader.entries()) {
      const d = await e.read();
      expect(d.length).toBe(2048);
      count++;
    }
    await reader.close();
    expect(count).toBe(40);
  });

  it('addLazy 与 add 混合并发：流式与内存条目全部完整', async () => {
    const dir = await tmpDir();
    const out = path.join(dir, 'mixed.zip');
    const bigData = new Uint8Array(3 * 1024 * 1024);
    for (let j = 0; j < bigData.length; j++) bigData[j] = j & 0xff;

    const writer = await zipIo.createWriter(out);
    const tasks = [];
    tasks.push(writer.add('manifest.json', new TextEncoder().encode('{"schemaVersion":1}')));
    tasks.push(writer.addLazy('big/stream.bin', (cb) => {
      cb(null, new Blob([bigData]).stream());
    }));
    for (let i = 0; i < 12; i++) {
      tasks.push(writer.add(`small/f${i}.json`, new TextEncoder().encode(JSON.stringify({ i, pad: 'x'.repeat(500) }))));
    }
    await Promise.all(tasks);
    await writer.close();

    const reader = await zipIo.openReader(out);
    const seen = new Map();
    const names = [];
    for await (const e of reader.entries()) {
      names.push(e.fileName);
      seen.set(e.fileName, await e.read());
    }
    await reader.close();

    expect(names[0]).toBe('manifest.json');
    expect(new TextDecoder().decode(seen.get('manifest.json'))).toBe('{"schemaVersion":1}');
    const big = seen.get('big/stream.bin');
    expect(big.length).toBe(bigData.length);
    expect(big.every((v, k) => v === bigData[k])).toBe(true);
    expect(seen.size).toBe(14);
  });

  it('并发管线产物可被 vendor ZipReader 独立读取（同构性）', async () => {
    const dir = await tmpDir();
    const out = path.join(dir, 'interop.zip');
    const writer = await zipIo.createWriter(out, { level: 0 });
    await writer.add('store-mode.bin', new Uint8Array(1024).fill(7));
    await writer.close();

    const reader = await zipIo.openReader(out);
    for await (const e of reader.entries()) {
      expect(e.fileName).toBe('store-mode.bin');
      const d = await e.read();
      expect(d.length).toBe(1024);
      expect(d[0]).toBe(7);
      expect(e.compressionMethod).toBe(0);
    }
    await reader.close();
  });
});
