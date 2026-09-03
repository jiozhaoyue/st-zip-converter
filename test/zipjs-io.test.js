// T5/AC9: 浏览器适配器(zip.js)与 CLI 适配器(yauzl/yazl)必须产出同构归档:
// 条目集合一致,且每条目的未压缩字节 MD5 一致——比 CRC 更强的"插件与 CLI 同一份规则"自动验证。
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as zip from '@zip.js/zip.js';
import { ZipReader } from '../src/core/read.js';
import { ZipWriter } from '../src/core/write.js';
import { convert, TARGETS } from '../src/core/transform.js';
import { nodeIo } from '../src/io/node-io.js';
import { zipjsIo } from '../src/io/zipjs-io.js';
import { lEntries } from '../fixtures/gen.js';

async function zipFrom(entries) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zipjs-'));
  const outPath = path.join(dir, 'in.zip');
  const writer = await ZipWriter.create(outPath);
  for (const [name, data] of entries) {
    writer.add(name, data);
  }
  await writer.close();
  return outPath;
}

async function nodeFingerprint(zipPath) {
  const reader = await ZipReader.open(zipPath);
  const map = new Map();
  for await (const entry of reader.entries()) {
    const data = await entry.read();
    map.set(entry.fileName, { size: entry.uncompressedSize, md5: createHash('md5').update(data).digest('hex') });
  }
  await reader.close();
  return map;
}

async function zipjsFingerprint(blob) {
  const reader = new zip.ZipReader(new zip.BlobReader(blob));
  const entries = await reader.getEntries();
  const map = new Map();
  for (const entry of entries) {
    if (entry.directory) continue;
    const data = Buffer.from(await entry.arrayBuffer());
    map.set(entry.filename, {
      size: entry.uncompressedSize,
      md5: createHash('md5').update(data).digest('hex'),
    });
  }
  await reader.close();
  return map;
}

describe.each([TARGETS.ST, TARGETS.L, TARGETS.TT, TARGETS.PT])('zip.js 适配器与 CLI 同构(%s)', (target) => {
  it('插件路径(浏览器流)产物与 CLI 产物条目/字节一致', async () => {
    const sourcePath = await zipFrom(lEntries());
    const sourceBuffer = await readFile(sourcePath);

    // CLI 路径:node-io
    const dir = await mkdtemp(path.join(os.tmpdir(), 'zipjs-cli-'));
    const cliOut = path.join(dir, `cli-${target}.zip`);
    await convert(sourcePath, cliOut, { target, io: nodeIo });

    // 插件路径:zipjs-io(Blob 进 BlobWriter 出)
    const sourceBlob = new Blob([sourceBuffer], { type: 'application/zip' });
    const blobWriter = new zip.BlobWriter('application/zip');
    await convert(sourceBlob, blobWriter, { target, io: zipjsIo });
    const pluginBlob = await blobWriter.getData();

    const [cliMap, pluginMap] = await Promise.all([
      nodeFingerprint(cliOut),
      zipjsFingerprint(pluginBlob),
    ]);

    expect([...pluginMap.keys()].sort()).toEqual([...cliMap.keys()].sort());
    for (const [name, meta] of cliMap) {
      const got = pluginMap.get(name);
      expect(got, `条目 ${name} 在插件产物中缺失`).toBeDefined();
      expect(got.size, `${name} 大小不一致`).toBe(meta.size);
      expect(got.md5, `${name} 内容不一致`).toBe(meta.md5);
    }
  });
});
