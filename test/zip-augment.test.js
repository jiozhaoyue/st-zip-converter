import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipIo } from '../src/core/zip-io.js';
import { augmentZip } from '../src/core/zip-augment.js';

/**
 * 源包增强单测（对应任务 `09-27-chatfilesys-pure-db-adapter` 的 AC-4）
 *
 * 判据的核心是「**既有条目一个字节都不能变**」——增强是补数据，
 * 不是重写数据；任何对原条目的改写都必须在测试里转红。
 */

async function tmpDir() {
  return await mkdtemp(path.join(os.tmpdir(), 'tavern-augment-'));
}

/** 造一个源包：3 条目（含一条二进制，确保不是只测文本） */
async function makeSourceZip(dir, entries = null) {
  const p = path.join(dir, 'source.zip');
  const writer = await zipIo.createWriter(p);
  const list = entries || [
    ['chats/已有.jsonl', new TextEncoder().encode('{"a":1}\n{"b":2}\n')],
    ['characters/A.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])],
    ['settings.json', new TextEncoder().encode('{"theme":"dark"}')],
  ];
  for (const [name, data] of list) await writer.add(name, data);
  await writer.close();
  return p;
}

/** 把一个 zip 读成 有序的 [名, 字节] 数组（保序是有意为之：中央目录顺序即包内顺序） */
async function readZipOrdered(source) {
  const reader = await zipIo.openReader(source);
  const out = [];
  try {
    for await (const entry of reader.entries()) {
      out.push([entry.fileName, Buffer.from(await entry.read())]);
    }
  } finally {
    await reader.close();
  }
  return out;
}

describe('zip-augment · augmentZip', () => {
  it('原条目逐字保留（名/内容/顺序）且注入条目追加在后', async () => {
    const dir = await tmpDir();
    const src = await makeSourceZip(dir);
    const before = await readZipOrdered(src);

    const out = path.join(dir, 'augmented.zip');
    await augmentZip(src, [
      { name: 'chats/新A.jsonl', data: '{"c":3}\n' },
      { name: 'chats/新B.jsonl', data: new TextEncoder().encode('{"d":4}\n') },
    ], { target: out, compressionLevel: 0 });

    const after = await readZipOrdered(out);
    expect(after).toHaveLength(before.length + 2);
    // 前 3 条与源包**逐字节**相同、顺序也相同
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after[before.length][0]).toBe('chats/新A.jsonl');
    expect(after[before.length][1].toString('utf8')).toBe('{"c":3}\n');
    expect(after[before.length + 1][0]).toBe('chats/新B.jsonl');
  });

  it('注入条目为空 ⇒ **原样返回同一个对象**（不做任何 IO，常态零成本）', async () => {
    const dir = await tmpDir();
    const src = await makeSourceZip(dir);
    const sentinel = { fakeBlob: true };
    expect(await augmentZip(src, [], { target: path.join(dir, 'never.zip') })).toBe(src);
    expect(await augmentZip(sentinel, null, { target: path.join(dir, 'never.zip') })).toBe(sentinel);
    expect(existsSync(path.join(dir, 'never.zip'))).toBe(false);
  });

  it('注入条目与源包同名 ⇒ 源包优先（内容不被改写，也不出现重复条目）', async () => {
    const dir = await tmpDir();
    const src = await makeSourceZip(dir);
    const out = path.join(dir, 'collide.zip');
    await augmentZip(src, [{ name: 'chats/已有.jsonl', data: '覆盖尝试\n' }], {
      target: out, compressionLevel: 0,
    });
    const after = await readZipOrdered(out);
    expect(after).toHaveLength(3);
    const hit = after.find(([n]) => n === 'chats/已有.jsonl');
    expect(hit[1].toString('utf8')).toBe('{"a":1}\n{"b":2}\n');
  });

  it('自定义流目标（OPFS 同形）：写出的是合法 zip，产物由 finalize 交出', async () => {
    const dir = await tmpDir();
    const src = await makeSourceZip(dir);
    const chunks = [];
    const ws = new WritableStream({ write(c) { chunks.push(new Uint8Array(c)); } });
    const result = await augmentZip(src, [{ name: 'chats/流式.jsonl', data: '{"e":5}\n' }], {
      target: {
        writable: ws,
        finalize: async () => new Blob(chunks, { type: 'application/zip' }),
      },
      compressionLevel: 0,
    });
    expect(result).toBeInstanceOf(Blob);
    const after = await readZipOrdered(result);
    expect(after.map(([n]) => n)).toContain('chats/流式.jsonl');
    expect(after).toHaveLength(4);
  });

  it('字符串条目按 UTF-8 编码写入（`new Uint8Array(str)` 会静默产出空条目 —— 已收口）', async () => {
    const dir = await tmpDir();
    const src = path.join(dir, 'str.zip');
    const writer = await zipIo.createWriter(src);
    const payload = '{"x":"中文内容"}\n';
    await writer.add('chats/文本.jsonl', payload);   // 传字符串
    await writer.close();
    const after = await readZipOrdered(src);
    expect(after[0][1].toString('utf8')).toBe(payload);
    expect(after[0][1].length).toBeGreaterThan(0);
    expect(after[0][1].length).toBeGreaterThan(0);
  });

  it('源条目含目录项与深路径时仍原样保留', async () => {
    const dir = await tmpDir();
    const src = path.join(dir, 'deep.zip');
    const writer = await zipIo.createWriter(src);
    await writer.add('chats/角色/深.jsonl', 'deep\n');
    await writer.add('data/default-user/settings.json', '{"x":1}');
    await writer.close();

    const out = path.join(dir, 'deep-out.zip');
    await augmentZip(src, [{ name: 'chats/补.jsonl', data: 'p\n' }], { target: out, compressionLevel: 0 });
    const names = (await readZipOrdered(out)).map(([n]) => n);
    expect(names).toEqual([
      'chats/角色/深.jsonl',
      'data/default-user/settings.json',
      'chats/补.jsonl',
    ]);
  });

  it('中止（signal 已 abort）⇒ 抛 AbortError 且**不留半成品文件**', async () => {
    const dir = await tmpDir();
    const src = await makeSourceZip(dir);
    const out = path.join(dir, 'aborted.zip');
    const controller = new AbortController();
    controller.abort();
    await expect(augmentZip(src, [{ name: 'chats/X.jsonl', data: 'x\n' }], {
      target: out, signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(existsSync(out)).toBe(false);
  });

  it('自定义流目标在失败路径上会被 abort（不留悬挂写入）', async () => {
    const dir = await tmpDir();
    const src = await makeSourceZip(dir);
    let aborted = false;
    const controller = new AbortController();
    controller.abort();
    await expect(augmentZip(src, [{ name: 'chats/X.jsonl', data: 'x\n' }], {
      target: {
        writable: new WritableStream({ write() {} }),
        finalize: async () => 'never',
        abort: async () => { aborted = true; },
      },
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted).toBe(true);
  });
});
