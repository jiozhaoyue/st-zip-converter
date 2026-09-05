import { describe, expect, it } from 'vitest';
import * as zip from '@zip.js/zip.js';
import { resolveFilename, sanitizeFilename, DEFAULT_FILENAME_TEMPLATE } from '../src/core/filename-template.js';
import { zipIo } from '../src/core/zip-io.js';
import { convert, TARGETS } from '../src/core/transform.js';
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

describe('自定义包名模板解析器 (resolveFilename)', () => {
  it('正确替换预设占位符 {source}, {target}, {handle}, {date}', () => {
    const filename = resolveFilename('{source}-to-{target}_{handle}_{date}.zip', {
      sourceName: 'MySillyTavernBackup.zip',
      target: 'pt',
      handle: 'alice',
      date: '2026-09-05',
    });

    expect(filename).toBe('MySillyTavernBackup-to-pt_alice_2026-09-05.zip');
  });

  it('模板未提供扩展名时自动补齐 .zip', () => {
    const filename = resolveFilename('{source}_{target}', {
      sourceName: 'backup.zip',
      target: 'tt',
    });

    expect(filename.endsWith('.zip')).toBe(true);
    expect(filename).toBe('backup_tt.zip');
  });

  it('模板为空时回退到默认模板 DEFAULT_FILENAME_TEMPLATE', () => {
    const filename = resolveFilename('', {
      sourceName: 'test.zip',
      target: 'l',
      date: '2026-09-05',
    });

    expect(filename).toBe('test-to-l-2026-09-05.zip');
  });

  it('自动过滤与清洗跨平台非法字符', () => {
    const clean = sanitizeFilename('bad:file/name*with?illegal"chars<and>pipes|end.zip');
    expect(clean).not.toContain(':');
    expect(clean).not.toContain('/');
    expect(clean).not.toContain('*');
    expect(clean).not.toContain('?');
    expect(clean).not.toContain('"');
    expect(clean).not.toContain('<');
    expect(clean).not.toContain('>');
    expect(clean).not.toContain('|');
  });
});

describe('多级 Zip 压缩率支持 (Store 0 vs Deflate 9)', () => {
  it('支持 level 0 (极速存储模式 / Store) 生成合规压缩包并可被读取', async () => {
    const sourceBlob = await createFixtureBlob(lEntries());
    const storeWriter = new zip.BlobWriter('application/zip');

    const report = await convert(sourceBlob, storeWriter, {
      target: TARGETS.PT,
      io: zipIo,
      compressionLevel: 0,
    });

    const storeBlob = await storeWriter.getData();
    expect(storeBlob.size).toBeGreaterThan(0);
    const totals = report.toJSON().totals;
    expect(totals.copied + totals.synthesized).toBeGreaterThan(0);

    // 验证 ZipReader 能够无损解压与遍历
    const reader = await zipIo.openReader(storeBlob);
    const names = [];
    for await (const entry of reader.entries()) {
      names.push(entry.fileName);
      // 验证 entry.read() 正常读取二进制数据
      const data = await entry.read();
      expect(data).toBeDefined();
    }
    await reader.close();

    expect(names.some((n) => n.includes('Fixture Character.png'))).toBe(true);
  });

  it('对比 level 9 (极限压缩) 与 level 0 (极速存储): level 9 体积更小', async () => {
    // 构造高压缩比 entries (重复文本)
    const largeText = new TextEncoder().encode('A'.repeat(50000) + 'B'.repeat(50000));
    const customEntries = [
      ...lEntries(),
      ['huge_text.json', largeText],
    ];

    const sourceBlob = await createFixtureBlob(customEntries);

    // Level 0: Store
    const storeWriter = new zip.BlobWriter('application/zip');
    await convert(sourceBlob, storeWriter, {
      target: TARGETS.ST,
      io: zipIo,
      compressionLevel: 0,
    });
    const storeBlob = await storeWriter.getData();

    // Level 9: Maximum Deflate
    const maxDeflateWriter = new zip.BlobWriter('application/zip');
    await convert(sourceBlob, maxDeflateWriter, {
      target: TARGETS.ST,
      io: zipIo,
      compressionLevel: 9,
    });
    const maxDeflateBlob = await maxDeflateWriter.getData();

    expect(maxDeflateBlob.size).toBeLessThan(storeBlob.size);

    // 验证两者生成的内容解压后完全一致
    const maxReader = await zipIo.openReader(maxDeflateBlob);
    let maxText = null;
    for await (const entry of maxReader.entries()) {
      if (entry.fileName.includes('huge_text.json')) {
        maxText = await entry.read();
      }
    }
    await maxReader.close();

    expect(maxText).toEqual(largeText);
  });
});
