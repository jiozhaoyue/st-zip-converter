import { describe, it, expect } from 'vitest';
import { incrementalMergeArchives } from '../src/ui/host-bridge.js';
import { zipIo } from '../src/core/zip-io.js';
import * as zip from '../src/vendor/zip.js';

describe('Incremental Archive Merge (增量数据包合并测试)', () => {
  it('merges base and incoming archives, keeping base unique items and updating overlapping items', async () => {
    // 1. 创建基准包 (Base Archive):
    // 包含 characters/Alice.png, chats/Alice.jsonl, presets/default.json
    const baseTarget = new zip.BlobWriter('application/zip');
    const baseWriter = await zipIo.createWriter(baseTarget);
    await baseWriter.add('characters/Alice.png', new TextEncoder().encode('Alice v1 Image Data'));
    await baseWriter.add('chats/Alice.jsonl', new TextEncoder().encode('Alice Chat History Old'));
    await baseWriter.add('presets/default.json', new TextEncoder().encode('{"preset": "v1"}'));
    await baseWriter.close();
    const baseBlob = await baseTarget.getData();

    // 2. 创建增量包 (Incoming Archive):
    // 包含更新后的 chats/Alice.jsonl (更新), 新增 characters/Bob.png (新增)
    const incTarget = new zip.BlobWriter('application/zip');
    const incWriter = await zipIo.createWriter(incTarget);
    await incWriter.add('chats/Alice.jsonl', new TextEncoder().encode('Alice Chat History NEW UPDATED'));
    await incWriter.add('characters/Bob.png', new TextEncoder().encode('Bob Avatar Data'));
    await incWriter.close();
    const incBlob = await incTarget.getData();

    // 3. 执行增量合并
    const { resultBlob, updatedCount, preservedCount, totalCount } = await incrementalMergeArchives(
      baseBlob,
      incBlob
    );

    expect(totalCount).toBe(4);
    expect(updatedCount).toBe(2); // chats/Alice.jsonl (更新) + characters/Bob.png (新增)
    expect(preservedCount).toBe(2); // characters/Alice.png (保留) + presets/default.json (保留)

    // 4. 检验合并后的包内容
    const mergedReader = await zipIo.openReader(resultBlob);
    const entriesMap = new Map();
    for await (const entry of mergedReader.entries()) {
      entriesMap.set(entry.fileName, new TextDecoder().decode(await entry.read()));
    }
    await mergedReader.close();

    expect(entriesMap.get('characters/Alice.png')).toBe('Alice v1 Image Data');
    expect(entriesMap.get('presets/default.json')).toBe('{"preset": "v1"}');
    expect(entriesMap.get('chats/Alice.jsonl')).toBe('Alice Chat History NEW UPDATED');
    expect(entriesMap.get('characters/Bob.png')).toBe('Bob Avatar Data');
  });
});
