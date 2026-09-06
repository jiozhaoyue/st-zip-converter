import { describe, expect, it } from 'vitest';
import { compareArchives, generateDeltaArchive } from '../src/core/delta.js';
import { incrementalMergeArchives } from '../src/ui/host-bridge.js';
import { zipIo } from '../src/core/zip-io.js';
import * as zip from '../src/vendor/zip.js';

async function createZip(entries) {
  const writerTarget = new zip.BlobWriter('application/zip');
  const writer = await zipIo.createWriter(writerTarget, { level: 5 });
  for (const [name, content] of entries) {
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    await writer.add(name, data);
  }
  await writer.close();
  return await writerTarget.getData();
}

describe('Delta Archive Engine (外部基准增量导出比对)', () => {
  it('比对两个 ZIP 并精准识别 added, modified 与 unchanged 条目', async () => {
    const baseBlob = await createZip([
      ['characters/Alice.png', 'avatar-content-v1'],
      ['chats/Alice/active.jsonl', 'chat-message-line-1\n'],
      ['settings.json', '{"theme":"dark"}'],
    ]);

    const targetBlob = await createZip([
      ['characters/Alice.png', 'avatar-content-v1'], // unchanged
      ['chats/Alice/active.jsonl', 'chat-message-line-1\nchat-message-line-2\n'], // modified
      ['settings.json', '{"theme":"dark"}'], // unchanged
      ['characters/Bob.png', 'avatar-bob-v1'], // added
    ]);

    const diff = await compareArchives(baseBlob, targetBlob);

    expect(diff.added.map((e) => e.fileName)).toEqual(['characters/Bob.png']);
    expect(diff.modified.map((e) => e.fileName)).toEqual(['chats/Alice/active.jsonl']);
    expect(diff.unchanged.map((e) => e.fileName).sort()).toEqual([
      'characters/Alice.png',
      'settings.json',
    ].sort());
    expect(diff.deleted).toEqual([]);
  });

  it('基于外部基准生成纯增量补丁包 (Delta Zip)，仅包含变更项与 _delta_manifest.json', async () => {
    const baseBlob = await createZip([
      ['doc1.txt', 'identical content'],
      ['doc2.txt', 'version 1'],
    ]);

    const targetBlob = await createZip([
      ['doc1.txt', 'identical content'], // unchanged
      ['doc2.txt', 'version 2 updated!'], // modified
      ['doc3.txt', 'new file added!'], // added
    ]);

    const { deltaBlob, stats, manifest } = await generateDeltaArchive(baseBlob, targetBlob, {
      baseName: 'v1-base.zip',
    });

    expect(stats.addedCount).toBe(1);
    expect(stats.modifiedCount).toBe(1);
    expect(stats.unchangedCount).toBe(1);
    expect(stats.totalChanges).toBe(2);

    expect(manifest.baseArchiveName).toBe('v1-base.zip');
    expect(manifest.changes.added).toEqual(['doc3.txt']);
    expect(manifest.changes.modified).toEqual(['doc2.txt']);

    // 读取 delta 包条目验证
    const reader = await zipIo.openReader(deltaBlob);
    const entryNames = [];
    let manifestContent = null;
    for await (const entry of reader.entries()) {
      entryNames.push(entry.fileName);
      if (entry.fileName === '_delta_manifest.json') {
        const raw = await entry.read();
        manifestContent = JSON.parse(new TextDecoder().decode(raw));
      } else {
        entry.skip();
      }
    }
    await reader.close();

    // 未变更项 doc1.txt 绝不可包含在 delta 包中
    expect(entryNames.includes('doc1.txt')).toBe(false);
    expect(entryNames.includes('doc2.txt')).toBe(true);
    expect(entryNames.includes('doc3.txt')).toBe(true);
    expect(entryNames.includes('_delta_manifest.json')).toBe(true);
    expect(manifestContent.type).toBe('delta-patch');
  });

  it('增量补丁包 (Delta Zip) 可与基准包通过 incrementalMergeArchives 完美合并还原最新数据', async () => {
    const baseBlob = await createZip([
      ['unchanged.txt', 'stay same'],
      ['modified.txt', 'old content'],
    ]);

    const latestBlob = await createZip([
      ['unchanged.txt', 'stay same'],
      ['modified.txt', 'new content'],
      ['added.txt', 'brand new content'],
    ]);

    const { deltaBlob } = await generateDeltaArchive(baseBlob, latestBlob, {
      baseName: 'base.zip',
    });

    // 使用系统内置的增量合并器将补丁包注入基准包
    const { resultBlob, updatedCount, preservedCount } = await incrementalMergeArchives(baseBlob, deltaBlob);

    expect(updatedCount).toBe(3); // modified.txt + added.txt + _delta_manifest.json
    expect(preservedCount).toBe(1); // unchanged.txt

    // 验证合并产物中的每个文件内容
    const reader = await zipIo.openReader(resultBlob);
    const resultMap = new Map();
    for await (const entry of reader.entries()) {
      const data = await entry.read();
      resultMap.set(entry.fileName, new TextDecoder().decode(data));
    }
    await reader.close();

    expect(resultMap.get('unchanged.txt')).toBe('stay same');
    expect(resultMap.get('modified.txt')).toBe('new content');
    expect(resultMap.get('added.txt')).toBe('brand new content');
  });
});
