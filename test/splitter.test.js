import { describe, it, expect } from 'vitest';
import { splitArchiveEntries, getEntryPriority } from '../src/core/splitter.js';
import { zipIo } from '../src/core/zip-io.js';

describe('Smart Incremental Split Archives (智能增量独立分包引擎测试)', () => {
  it('correctly sorts entry priority (Core -> Extensions -> Assets)', () => {
    expect(getEntryPriority('settings.json')).toBe(1);
    expect(getEntryPriority('characters/Alice.png')).toBe(1);
    expect(getEntryPriority('chats/Alice/chat.jsonl')).toBe(1);
    expect(getEntryPriority('extensions/my-extension/index.js')).toBe(2);
    expect(getEntryPriority('backgrounds/cool-bg.png')).toBe(3);
    expect(getEntryPriority('User Avatars/alice.png')).toBe(3);
  });

  it('splits entries into multiple independent, valid zip archives based on threshold', async () => {
    // 构造模拟条目 (设置阈值为极小值，例如 0.005MB 约 5KB，用于快速触发切包)
    const entries = [
      { path: 'settings.json', data: new TextEncoder().encode(JSON.stringify({ theme: 'dark' })) },
      { path: 'characters/Alice.png', data: new Uint8Array(3000) },
      { path: 'extensions/ext1/index.js', data: new Uint8Array(4000) },
      { path: 'extensions/ext2/index.js', data: new Uint8Array(4000) },
      { path: 'backgrounds/big-bg-1.png', data: new Uint8Array(5000) },
      { path: 'backgrounds/big-bg-2.png', data: new Uint8Array(5000) },
    ];

    // 0.006 MB 阈值 (约 6KB)
    const result = await splitArchiveEntries(entries, {
      thresholdMB: 0.007,
      target: 'st',
      handle: 'default-user',
      compressionLevel: 0, // 极速存储便于精细体积校验
    });

    expect(result.totalParts).toBeGreaterThan(1);
    expect(result.parts.length).toBe(result.totalParts);

    // 验证每一个分卷都是独立的合法 Zip
    for (let i = 0; i < result.parts.length; i++) {
      const part = result.parts[i];
      expect(part.partIndex).toBe(i + 1);
      expect(part.totalParts).toBe(result.totalParts);
      expect(part.blob).toBeDefined();
      expect(part.blob.size).toBeGreaterThan(0);
      expect(part.partName).toMatch(/\.zip$/i);

      // 打开验证中央目录与包含的 split-manifest.json
      const reader = await zipIo.openReader(part.blob);
      const fileNames = [];
      let foundManifest = false;

      for await (const e of reader.entries()) {
        fileNames.push(e.fileName);
        if (e.fileName === '_convert/split-manifest.json') {
          foundManifest = true;
          const text = new TextDecoder().decode(await e.read());
          const manifest = JSON.parse(text);
          expect(manifest.partIndex).toBe(i + 1);
          expect(manifest.totalParts).toBeUndefined(); // part specific
          expect(manifest.splitId).toBe(result.splitId);
        }
      }

      await reader.close();
      expect(foundManifest).toBe(true);
      expect(fileNames.length).toBe(part.fileCount + 1); // data files + manifest
    }
  });

  it('isolates single oversized file into its own standalone package and marks isOversized', async () => {
    const entries = [
      { path: 'settings.json', data: new Uint8Array(1000) },
      { path: 'models/huge-model.onnx', data: new Uint8Array(20000) }, // 超过单包阈值
      { path: 'backgrounds/small.png', data: new Uint8Array(1000) },
    ];

    // 0.01 MB (约 10KB)，huge-model (20KB) 必然超限
    const result = await splitArchiveEntries(entries, {
      thresholdMB: 0.01,
      target: 'luker',
      handle: 'alice',
      compressionLevel: 0,
    });

    const oversizedPart = result.parts.find((p) => p.isOversized);
    expect(oversizedPart).toBeDefined();
    expect(oversizedPart.files).toContain('models/huge-model.onnx');

    // 验证该超大卷依然是合法的 Zip
    const reader = await zipIo.openReader(oversizedPart.blob);
    let hasModel = false;
    for await (const e of reader.entries()) {
      if (e.fileName === 'models/huge-model.onnx') hasModel = true;
    }
    await reader.close();
    expect(hasModel).toBe(true);
  });
});
