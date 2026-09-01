import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ZipWriter } from '../src/core/write.js';
import { detectLayout, LAYOUTS } from '../src/core/detect.js';
import { generateAll, stEntries, lEntries, ttEntries } from '../fixtures/gen.js';

const tmpDirs = [];

async function tmpDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tavern-convert-detect-'));
  tmpDirs.push(dir);
  return dir;
}

async function zipFrom(entries) {
  const dir = await tmpDir();
  const outPath = path.join(dir, 'sample.zip');
  const writer = await ZipWriter.create(outPath);
  for (const [name, data] of entries) {
    writer.add(name, data);
  }
  await writer.close();
  return outPath;
}

describe('detectLayout', () => {
  let fixturesDir;

  it('st: 摊平无 manifest', async () => {
    const result = await detectLayout(await zipFrom(stEntries()));
    expect(result.layout).toBe(LAYOUTS.ST);
  });

  it('l: 摊平 + manifest(schemaVersion+selection)', async () => {
    const result = await detectLayout(await zipFrom(lEntries()));
    expect(result.layout).toBe(LAYOUTS.L);
  });

  it('tt: data/ 根', async () => {
    const result = await detectLayout(await zipFrom(ttEntries()));
    expect(result.layout).toBe(LAYOUTS.TT);
  });

  it('pt-native: manifest 带 per-file moduleId → 明确判为不支持', async () => {
    const manifest = {
      format: 'pure-tavern-archive',
      schemaVersion: 1,
      files: [{ path: 'characters/a.png', moduleId: 'characters', kind: 'blob', sha256: 'x' }],
    };
    const result = await detectLayout(await zipFrom([
      ['manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8')],
      ['characters/a.png', Buffer.from('x', 'utf8')],
    ]));
    expect(result.layout).toBe(LAYOUTS.PT_NATIVE);
  });

  it('unknown: 空包或无关条目', async () => {
    const result = await detectLayout(await zipFrom([['random/file.txt', Buffer.from('?', 'utf8')]]));
    expect(result.layout).toBe(LAYOUTS.UNKNOWN);
  });

  it('合成固件三包判定一致', async () => {
    fixturesDir = await tmpDir();
    const outputs = await generateAll(fixturesDir);
    expect((await detectLayout(outputs['fixture-st.zip'])).layout).toBe(LAYOUTS.ST);
    expect((await detectLayout(outputs['fixture-l.zip'])).layout).toBe(LAYOUTS.L);
    expect((await detectLayout(outputs['fixture-tt.zip'])).layout).toBe(LAYOUTS.TT);
  });
});
