import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { zipIo } from '../src/core/zip-io.js';

async function tmpDir() {
  return await mkdtemp(path.join(os.tmpdir(), 'tavern-convert-'));
}

describe('zipIo (openReader / createWriter) 往返测试', () => {
  it('Uint8Array / Buffer 条目往返后条目名与内容一致', async () => {
    const dir = await tmpDir();
    const outPath = path.join(dir, 'roundtrip.zip');
    const writer = await zipIo.createWriter(outPath);
    const payload = Buffer.from('hello tavern', 'utf8');
    const binary = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x7f]);
    await writer.add('a/text.txt', payload);
    await writer.add('b/binary.bin', binary);
    await writer.add('nested/deep/c.json', Buffer.from('{"x":1}', 'utf8'));
    await writer.close();

    const reader = await zipIo.openReader(outPath);
    expect(reader.totalEntries).toBe(3);
    const seen = new Map();
    for await (const entry of reader.entries()) {
      seen.set(entry.fileName, await entry.read());
    }
    await reader.close();

    expect(new TextDecoder().decode(seen.get('a/text.txt'))).toBe('hello tavern');
    expect(Buffer.compare(Buffer.from(seen.get('b/binary.bin')), Buffer.from(binary))).toBe(0);
    expect(new TextDecoder().decode(seen.get('nested/deep/c.json'))).toBe('{"x":1}');
    expect([...seen.keys()].sort()).toEqual(['a/text.txt', 'b/binary.bin', 'nested/deep/c.json'].sort());
  });

  it('skip() 跳过条目后仍能继续迭代', async () => {
    const dir = await tmpDir();
    const outPath = path.join(dir, 'skip.zip');
    const writer = await zipIo.createWriter(outPath);
    for (const name of ['one.txt', 'two.txt', 'three.txt']) {
      await writer.add(name, Buffer.from(name, 'utf8'));
    }
    await writer.close();

    const reader = await zipIo.openReader(outPath);
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
});

function streamFrom(buffer) {
  return Readable.from([buffer]);
}
