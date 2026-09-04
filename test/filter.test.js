import { describe, expect, it } from 'vitest';
import * as zip from '@zip.js/zip.js';
import { zipIo } from '../src/core/zip-io.js';
import { convert, TARGETS } from '../src/core/transform.js';
import { inspectArchive, CATEGORIES, CATEGORY_LABELS } from '../src/core/inspect.js';
import { lEntries, stEntries, ttEntries } from '../fixtures/gen.js';

async function createFixtureBlob(entries) {
  const blobWriter = new zip.BlobWriter('application/zip');
  const writer = new zip.ZipWriter(blobWriter);
  for (const [name, data] of entries) {
    await writer.add(name, new zip.Uint8ArrayReader(new Uint8Array(data)));
  }
  await writer.close();
  return blobWriter.getData();
}

async function listEntryNames(blob) {
  const reader = await zipIo.openReader(blob);
  const names = [];
  for await (const entry of reader.entries()) {
    names.push(entry.fileName);
  }
  await reader.close();
  return names;
}

describe('零拷贝中央目录预检与 10 大标准类目聚合 (inspectArchive)', () => {
  it('正确统计固件包中的 10 大类目分布与体积 (对齐 ST / Luker 规范)', async () => {
    const blob = await createFixtureBlob(lEntries());
    const info = await inspectArchive(blob);

    expect(info.layout).toBe('l');
    expect(info.totalFiles).toBeGreaterThan(5);
    expect(info.totalBytes).toBeGreaterThan(0);

    const { categories } = info;
    // 验证所有 10 项标准类目均被初始化
    expect(categories[CATEGORIES.CHARACTERS]).toBeDefined();
    expect(categories[CATEGORIES.CHATS]).toBeDefined();
    expect(categories[CATEGORIES.LOREBOOKS]).toBeDefined();
    expect(categories[CATEGORIES.PRESETS]).toBeDefined();
    expect(categories[CATEGORIES.SETTINGS]).toBeDefined();
    expect(categories[CATEGORIES.SECRETS]).toBeDefined();
    expect(categories[CATEGORIES.ASSETS]).toBeDefined();
    expect(categories[CATEGORIES.EXTENSIONS]).toBeDefined();
    expect(categories[CATEGORIES.GLOBAL_EXTENSIONS]).toBeDefined();
    expect(categories[CATEGORIES.VECTORS]).toBeDefined();

    // 验证具体计数
    expect(categories[CATEGORIES.CHARACTERS].count).toBe(1);
    expect(categories[CATEGORIES.CHATS].count).toBe(1);
    expect(categories[CATEGORIES.LOREBOOKS].count).toBe(1);
    expect(categories[CATEGORIES.PRESETS].count).toBe(1); // OpenAI Settings
    expect(categories[CATEGORIES.SETTINGS].count).toBe(2); // settings.json + backups/auto-2026.json
    expect(categories[CATEGORIES.SECRETS].count).toBe(1);
    expect(categories[CATEGORIES.ASSETS].count).toBe(1); // User Avatars
    expect(categories[CATEGORIES.GLOBAL_EXTENSIONS].count).toBe(2); // extensions/third-party
    expect(categories[CATEGORIES.VECTORS].count).toBe(0); // 空类目
  });

  it('正确统计 TT 固件包中的 data/default-user 类目分布', async () => {
    const blob = await createFixtureBlob(ttEntries());
    const info = await inspectArchive(blob);

    expect(info.layout).toBe('tt');
    const { categories } = info;
    expect(categories[CATEGORIES.CHARACTERS].count).toBe(1);
    expect(categories[CATEGORIES.SECRETS].count).toBe(1);
    expect(categories[CATEGORIES.GLOBAL_EXTENSIONS].count).toBeGreaterThanOrEqual(2);
  });
});

describe('类目选择过滤与安全脱敏导出 (convert with selection)', () => {
  it('脱敏导出: 禁用 secrets，产物中不含 secrets.json 且报告中记录 filtered', async () => {
    const sourceBlob = await createFixtureBlob(stEntries());
    const targetWriter = new zip.BlobWriter('application/zip');

    const report = await convert(sourceBlob, targetWriter, {
      target: TARGETS.L,
      io: zipIo,
      selection: {
        secrets: false,
      },
    });

    const resultBlob = await targetWriter.getData();
    const names = await listEntryNames(resultBlob);

    expect(names.includes('secrets.json')).toBe(false);
    expect(names.includes('characters/Fixture Character.png')).toBe(true);

    const json = report.toJSON();
    expect(json.totals.filtered).toBeGreaterThanOrEqual(1);
    expect(json.filtered.some((f) => f.path === 'secrets.json' && f.category === 'secrets')).toBe(true);

    // Luker manifest 中的 selection.secrets 应为 false
    const reader = await zipIo.openReader(resultBlob);
    let manifestData = null;
    for await (const entry of reader.entries()) {
      if (entry.fileName === 'manifest.json') {
        manifestData = JSON.parse(new TextDecoder().decode(await entry.read()));
      }
    }
    await reader.close();
    expect(manifestData.selection.secrets).toBe(false);
    expect(manifestData.selection.characters).toBe(true);
  });

  it('精细勾选: 仅导出角色卡与素材，排除第三方扩展、聊天、预设与密钥', async () => {
    const sourceBlob = await createFixtureBlob(lEntries());
    const targetWriter = new zip.BlobWriter('application/zip');

    const report = await convert(sourceBlob, targetWriter, {
      target: TARGETS.TT,
      io: zipIo,
      selection: {
        characters: true,
        assets: true,
        lorebooks: false,
        chats: false,
        secrets: false,
        presets: false,
        settings: false,
        extensions: false,
        globalExtensions: false,
      },
    });

    const resultBlob = await targetWriter.getData();
    const names = await listEntryNames(resultBlob);

    // 应该保留
    expect(names.some((n) => n.includes('Fixture Character.png'))).toBe(true);
    expect(names.some((n) => n.includes('fixture-avatar.png'))).toBe(true);

    // 应该被排除
    expect(names.some((n) => n.includes('chats/'))).toBe(false);
    expect(names.some((n) => n.includes('secrets.json'))).toBe(false);
    expect(names.some((n) => n.includes('fixture-world.json'))).toBe(false);
    expect(names.some((n) => n.includes('OpenAI Settings/'))).toBe(false);
    expect(names.some((n) => n.includes('extensions/'))).toBe(false);
    expect(names.some((n) => n.includes('_tauritavern/extension-sources/'))).toBe(false);
  });
});
