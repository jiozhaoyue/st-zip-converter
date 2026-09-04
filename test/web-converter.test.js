import { describe, expect, it } from 'vitest';
import * as zip from '@zip.js/zip.js';
import { zipIo } from '../src/core/zip-io.js';
import { convert, TARGETS } from '../src/core/transform.js';
import { detectFromReader, LAYOUTS } from '../src/core/detect.js';
import { lEntries } from '../fixtures/gen.js';

async function createFixtureBlob(entries) {
  const blobWriter = new zip.BlobWriter('application/zip');
  const writer = new zip.ZipWriter(blobWriter);
  for (const [name, data] of entries) {
    await writer.add(name, new zip.Uint8ArrayReader(new Uint8Array(data)));
  }
  await writer.close();
  return blobWriter.getData();
}

describe('纯 Web 转换引擎 (zipIo + transform)', () => {
  it('能够从 Blob 检测源包布局为 Luker', async () => {
    const blob = await createFixtureBlob(lEntries());
    const reader = await zipIo.openReader(blob);
    const detection = await detectFromReader(reader);
    await reader.close();

    expect(detection.layout).toBe(LAYOUTS.L);
  });

  it.each([TARGETS.ST, TARGETS.L, TARGETS.TT, TARGETS.PT])('Blob 到 Blob 完整转换 (%s) 并触发进度回调', async (target) => {
    const sourceBlob = await createFixtureBlob(lEntries());
    const targetWriter = new zip.BlobWriter('application/zip');

    const progressLog = [];
    const report = await convert(sourceBlob, targetWriter, {
      target,
      io: zipIo,
      onProgress: (cur, total, name) => {
        progressLog.push({ cur, total, name });
      },
    });

    const resultBlob = await targetWriter.getData();
    expect(resultBlob.size).toBeGreaterThan(0);
    expect(progressLog.length).toBeGreaterThan(0);
    expect(report.target).toBe(target);

    // 验证产物可以正常被 ZipReader 读取
    const verifyReader = await zipIo.openReader(resultBlob);
    const names = [];
    for await (const entry of verifyReader.entries()) {
      names.push(entry.fileName);
    }
    await verifyReader.close();

    if (target === TARGETS.ST) {
      expect(names).toContain('_convert/INSTALL.md');
      expect(names).toContain('characters/Fixture Character.png');
    } else if (target === TARGETS.TT) {
      expect(names.some((n) => n.startsWith('data/default-user/'))).toBe(true);
    } else if (target === TARGETS.PT) {
      expect(names.some((n) => n.startsWith('data/default-user/'))).toBe(true);
    } else if (target === TARGETS.L) {
      expect(names).toContain('manifest.json');
    }
  });
});
