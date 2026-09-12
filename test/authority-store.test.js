import { describe, it, expect, beforeEach } from 'vitest';
import {
  getAuthorityClient,
  isAuthorityAvailable,
  createCheckpointAdapter,
  putArtifact,
  getArtifact,
  deleteArtifact,
  __setAuthorityClientForTest,
} from '../src/storage/authority-store.js';

/** 构造 mock Authority client：KV + blob（base64）内存实现 */
function mockClient() {
  const kv = new Map();
  const blobs = new Map();
  return {
    storage: {
      kv: {
        set: async ({ key, value }) => { kv.set(key, value); },
        get: async ({ key }) => (kv.has(key) ? { value: kv.get(key) } : null),
      },
      blob: {
        put: async ({ name, content, contentType }) => {
          blobs.set(name, { content, contentType });
          return { id: `blob-${name}` };
        },
        get: async ({ name }) => {
          const rec = blobs.get(name);
          return rec ? { content: rec.content, contentType: rec.contentType } : null;
        },
        delete: async ({ name }) => { blobs.delete(name); },
      },
    },
    _kv: kv,
    _blobs: blobs,
  };
}

describe('authority-store 可选适配器', () => {
  beforeEach(() => __setAuthorityClientForTest(undefined));

  it('不可用时探测返回 false 且所有接口安全降级', async () => {
    __setAuthorityClientForTest(null);
    expect(isAuthorityAvailable()).toBe(false);
    expect(await getAuthorityClient()).toBeNull();
    expect(await createCheckpointAdapter()).toBeNull();
    expect(await putArtifact('a.zip', new Blob(['x']))).toBeNull();
    expect(await getArtifact('a.zip')).toBeNull();
    expect(await deleteArtifact('a.zip')).toBe(false);
  });

  it('checkpoint adapter 遵循 TaskManager {save,load,remove} 接缝', async () => {
    const client = mockClient();
    __setAuthorityClientForTest(client);
    const adapter = await createCheckpointAdapter();
    expect(adapter).not.toBeNull();

    await adapter.save('fetch-1', { receivedBytes: 1024, totalBytes: 2048, opfsName: 'tmp-x' });
    expect(await adapter.load('fetch-1')).toEqual({
      receivedBytes: 1024, totalBytes: 2048, opfsName: 'tmp-x',
    });
    await adapter.remove('fetch-1');
    expect(await adapter.load('fetch-1')).toBeNull();
    // 不存在的清单返回 null（与 task-manager ADAPTER 约定一致）
    expect(await adapter.load('nope')).toBeNull();
  });

  it('大 blob 分块写入并完整重组', async () => {
    const client = mockClient();
    __setAuthorityClientForTest(client);
    // 1.5MB 数据，512KB 块 → 3 块（验证跨块边界重组）
    const bytes = new Uint8Array(1536 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const src = new Blob([bytes], { type: 'application/zip' });

    const progress = [];
    const res = await putArtifact('big.zip', src, {
      chunkSize: 512 * 1024,
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(res).toEqual({ name: 'big.zip', size: bytes.length, chunks: 3 });
    expect(progress.at(-1)).toEqual([3, 3]);
    // 分块确实落盘：3 个 part + 1 个 manifest（KV）
    expect(client._blobs.size).toBe(3);

    const out = await getArtifact('big.zip');
    expect(out).toBeInstanceOf(Blob);
    expect(out.type).toBe('application/zip');
    expect(out.size).toBe(bytes.length);
    const roundtrip = new Uint8Array(await out.arrayBuffer());
    expect(roundtrip).toEqual(bytes);
  });

  it('deleteArtifact 清理清单与全部分块', async () => {
    const client = mockClient();
    __setAuthorityClientForTest(client);
    await putArtifact('gone.zip', new Blob([new Uint8Array(5 * 1024 * 1024)]));
    expect(client._blobs.size).toBe(2);
    expect(await deleteArtifact('gone.zip')).toBe(true);
    expect(client._blobs.size).toBe(0);
    expect(await getArtifact('gone.zip')).toBeNull();
  });

  it('get 对缺失 blob 返回 null 而非抛错', async () => {
    const client = mockClient();
    __setAuthorityClientForTest(client);
    await putArtifact('ok.zip', new Blob(['hello']));
    // 篡改清单指向不存在的分块
    const manifestKey = 'blob-manifest:ok.zip';
    const m = client._kv.get(manifestKey);
    client._kv.set(manifestKey, { ...m, parts: [{ id: 'missing', name: 'missing' }] });
    expect(await getArtifact('ok.zip')).toBeNull();
  });
});
