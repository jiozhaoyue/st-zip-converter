// T2: 真实包往返完整性 —— 经中间布局转一圈,除设计内丢弃/重生成条目外,
// 全部条目名字与 CRC32 保持一致(中央目录比对,不读数据流)。
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { zipIo } from '../src/core/zip-io.js';
import { convert, TARGETS } from '../src/core/transform.js';

const L_SOURCE = 'default-user-2026-08-25-172056.zip';
const TT_SOURCE = 'tauritavern-data-20260825-100035.zip';

const DERIVED = ['thumbnails/', 'backups/', 'vectors/'];
const ENGINE_DUMP = ['_engine_dump.bin', '_engine_meta.json'];

async function crcMap(zipPath) {
  const reader = await zipIo.openReader(zipPath);
  const map = new Map();
  for await (const entry of reader.entries()) {
    // 目录占位条目(零字节、以 / 结尾)由文件条目隐含,转换器按设计不搬运,比对时排除
    if (entry.fileName.endsWith('/')) {
      entry.skip();
      continue;
    }
    map.set(entry.fileName, entry.crc32 ?? -1);
    entry.skip();
  }
  await reader.close();
  return map;
}

describe.skipIf(!existsSync(L_SOURCE))('真实往返 l→st→l', () => {
  it('除 manifest(重生成)与派生缓存(设计内丢弃)外,条目 CRC32 一致', { timeout: 600_000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rt-l-'));
    const hub = path.join(dir, 'hub-st.zip');
    const back = path.join(dir, 'back-l.zip');
    await convert(L_SOURCE, hub, { target: TARGETS.ST, io: zipIo });
    await convert(hub, back, { target: TARGETS.L, io: zipIo });

    const [source, result] = await Promise.all([crcMap(L_SOURCE), crcMap(back)]);
    const problems = [];
    for (const [name, crc] of source) {
      if (name === 'manifest.json') continue; // 目标侧按 L 格式重新合成
      if (ENGINE_DUMP.includes(name)) continue;
      if (DERIVED.some((d) => name.startsWith(d))) continue; // 设计内丢弃
      if (!result.has(name)) {
        problems.push(`丢失: ${name}`);
        continue;
      }
      if (result.get(name) !== crc) {
        problems.push(`CRC 不一致: ${name}`);
      }
    }
    // 目标侧不应有源里没有的条目(除合成 manifest / _convert)
    for (const name of result.keys()) {
      if (name === 'manifest.json' || name.startsWith('_convert/')) continue;
      if (!source.has(name)) problems.push(`多出: ${name}`);
    }
    expect(problems.slice(0, 10), `${problems.length} 个往返问题`).toEqual([]);
  });
});

describe.skipIf(!existsSync(TT_SOURCE))('真实往返 tt→pt→tt', () => {
  it('除 TT 私有/派生(设计内丢弃)外,条目 CRC32 一致', { timeout: 600_000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rt-tt-'));
    const pt = path.join(dir, 'mid-pt.zip');
    const back = path.join(dir, 'back-tt.zip');
    await convert(TT_SOURCE, pt, { target: TARGETS.PT, io: zipIo });
    await convert(pt, back, { target: TARGETS.TT, io: zipIo });

    const [source, result] = await Promise.all([crcMap(TT_SOURCE), crcMap(back)]);
    const problems = [];
    for (const [name, crc] of source) {
      const isDerived = name.startsWith('data/_cache/')
        || name.startsWith('data/_css/')
        || name.startsWith('data/_errors/')
        || name === 'data/content.log'
        || name === 'data/default-user/content.log'
        || name.startsWith('data/default-user/user/cache/')
        || name.startsWith('data/default-user/thumbnails/')
        || name.startsWith('data/default-user/backups/')
        || name.startsWith('data/default-user/vectors/');
      const isAppPrivate = name === 'data/default-user/tauritavern-settings.json'
        || name.startsWith('data/default-user/user/lan-sync/')
        || (name.startsWith('data/_tauritavern/') && !name.startsWith('data/_tauritavern/extension-sources/'));
      if (isDerived || isAppPrivate) continue; // 经 PT 一跳设计内丢失(PT 无法承载)
      if (!result.has(name)) {
        problems.push(`丢失: ${name}`);
        continue;
      }
      if (result.get(name) !== crc) problems.push(`CRC 不一致: ${name}`);
    }
    for (const name of result.keys()) {
      if (!source.has(name)) problems.push(`多出: ${name}`);
    }
    expect(problems.slice(0, 10), `${problems.length} 个往返问题`).toEqual([]);
  });
});
