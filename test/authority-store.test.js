import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getAuthorityClient,
  isAuthorityAvailable,
  createCheckpointAdapter,
  putArtifact,
  getArtifact,
  deleteArtifact,
  __setAuthorityClientForTest,
} from '../src/storage/authority-store.js';
import { TaskManager } from '../src/core/task-manager.js';

/**
 * 构造 mock Authority client：KV + blob（base64）内存实现。
 * @param {{failBlobPutAt?: number, failKvSetAt?: number, failKvGetAt?: number}} [inject] 故障注入：
 *   第 N 次 `blob.put` / `kv.set` / `kv.get` 起 reject（0 = 不注入）。可事后经 `_inject` 改写。
 */
function mockClient(inject = {}) {
  const kv = new Map();
  const blobs = new Map();
  const state = {
    putCalls: 0, setCalls: 0, getCalls: 0,
    failBlobPutAt: 0, failKvSetAt: 0, failKvGetAt: 0,
    ...inject,
  };
  const bomb = (label) => Object.assign(new Error(`${label} 注入失败`), { injected: true });
  return {
    storage: {
      kv: {
        set: async ({ key, value }) => {
          state.setCalls += 1;
          if (state.failKvSetAt && state.setCalls >= state.failKvSetAt) throw bomb('kv.set');
          kv.set(key, value);
        },
        get: async ({ key }) => {
          state.getCalls += 1;
          if (state.failKvGetAt && state.getCalls >= state.failKvGetAt) throw bomb('kv.get');
          return kv.has(key) ? { value: kv.get(key) } : null;
        },
      },
      blob: {
        put: async ({ name, content, contentType }) => {
          state.putCalls += 1;
          if (state.failBlobPutAt && state.putCalls >= state.failBlobPutAt) throw bomb('blob.put');
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
    _inject: state,
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

  it('大 blob 分块写入并完整重组', { timeout: 30000 }, async () => {
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

  // ── 传输内存与失败语义（审计 F-A / F-C / F-D / F-F / F-B）────────────────────

  it('写入走 blob.stream() 逐块切分，不触碰整包 arrayBuffer（审计 F-A / F-C）', async () => {
    const client = mockClient();
    __setAuthorityClientForTest(client);
    const bytes = new Uint8Array(1024 * 1024);
    const src = new Blob([bytes], { type: 'application/zip' });
    const streamSpy = vi.spyOn(src, 'stream');

    // 探针：任何整包读取立即报错——写入路径若回退到 arrayBuffer/text 会当场失败
    const probed = {
      size: src.size,
      type: src.type,
      stream: () => src.stream(),
      arrayBuffer: () => { throw new Error('写入路径不得整包读取 blob.arrayBuffer()'); },
      text: () => { throw new Error('写入路径不得整包读取 blob.text()'); },
    };

    const res = await putArtifact('stream.zip', probed, { chunkSize: 256 * 1024 });
    expect(res).toEqual({ name: 'stream.zip', size: 1024 * 1024, chunks: 4 });
    expect(streamSpy).toHaveBeenCalledTimes(1);
    // 真实 Blob 走同一路径
    expect(await putArtifact('whole.zip', src, { chunkSize: 1024 * 1024 }))
      .toEqual({ name: 'whole.zip', size: 1024 * 1024, chunks: 1 });
  });

  it('同名写入按代际隔离：分块名互不重叠，清单只指向最新代际（审计 F-F）', async () => {
    const client = mockClient();
    __setAuthorityClientForTest(client);

    await putArtifact('gen.zip', new Blob([new Uint8Array(1024)]), { chunkSize: 512 });
    const first = client._kv.get('blob-manifest:gen.zip');
    await putArtifact('gen.zip', new Blob([new Uint8Array(2048)]), { chunkSize: 512 });
    const second = client._kv.get('blob-manifest:gen.zip');

    // 清单带代际标识，同名单次覆盖不混写
    expect(first.gen).toBeTruthy();
    expect(second.gen).toBeTruthy();
    expect(second.gen).not.toBe(first.gen);
    expect(second.size).toBe(2048);

    const firstNames = first.parts.map((p) => p.name);
    const secondNames = second.parts.map((p) => p.name);
    expect(secondNames.some((n) => firstNames.includes(n))).toBe(false);
    // 清单里的每一块都真实存在（无悬空指向），旧代际已清理（无孤儿块）
    for (const name of secondNames) expect(client._blobs.has(name)).toBe(true);
    for (const name of firstNames) expect(client._blobs.has(name)).toBe(false);
  });

  it('putArtifact 中途失败：本批已写分块回滚，清单仍指向旧代际（审计 F-D）', async () => {
    const client = mockClient();
    __setAuthorityClientForTest(client);
    const chunkSize = 512 * 1024;
    await putArtifact('rollback.zip', new Blob([new Uint8Array(3 * chunkSize)]), { chunkSize });
    const before = client._kv.get('blob-manifest:rollback.zip');
    const blobsBefore = [...client._blobs.keys()].sort();

    // 第二版：第 2 个分块写入失败
    client._inject.failBlobPutAt = client._inject.putCalls + 2;
    await expect(
      putArtifact('rollback.zip', new Blob([new Uint8Array(3 * chunkSize)]), { chunkSize }),
    ).rejects.toThrow(/blob\.put 注入失败/);

    // 回滚彻底：本次写入的第一块也被删除，blob 集合与失败前完全一致
    expect([...client._blobs.keys()].sort()).toEqual(blobsBefore);
    // 清单未被改写，仍指向旧代际 → 旧产物保持可读
    expect(client._kv.get('blob-manifest:rollback.zip')).toBe(before);
    const out = await getArtifact('rollback.zip');
    expect(out.size).toBe(before.size);
  });

  it('清单写入失败：本次分块不残留（孤儿清理，审计 F-D）', async () => {
    const client = mockClient();
    __setAuthorityClientForTest(client);
    client._inject.failKvSetAt = 1; // 首次 kv.set（即清单写入）即失败
    await expect(putArtifact('orphan.zip', new Blob([new Uint8Array(1024)])))
      .rejects.toThrow(/kv\.set 注入失败/);
    expect(client._blobs.size).toBe(0);
    expect(client._kv.size).toBe(0);
  });

  it('读旧清单失败：本次分块同样回滚，清单未改动（审计 F-D 的读路径）', async () => {
    const client = mockClient();
    __setAuthorityClientForTest(client);
    await putArtifact('readfail.zip', new Blob([new Uint8Array(1024)]));
    const before = client._kv.get('blob-manifest:readfail.zip');
    const blobsBefore = [...client._blobs.keys()].sort();

    // 下一次 kv.get（即「读旧清单」）失败
    client._inject.failKvGetAt = client._inject.getCalls + 1;
    await expect(putArtifact('readfail.zip', new Blob([new Uint8Array(1024)])))
      .rejects.toThrow(/kv\.get 注入失败/);

    expect([...client._blobs.keys()].sort()).toEqual(blobsBefore);
    expect(client._kv.get('blob-manifest:readfail.zip')).toBe(before);
    // 解除注入后旧产物仍可读（清单未被改写）
    client._inject.failKvGetAt = 0;
    expect((await getArtifact('readfail.zip')).size).toBe(before.size);
  });

  it('KV 写失败不阻断暂停：pause 仍返回 true 且 signal 已中止（审计 F-B / L1-MR-1）', async () => {
    const client = mockClient();
    __setAuthorityClientForTest(client);
    const adapter = await createCheckpointAdapter();
    const tm = new TaskManager(adapter);
    const { signal, onCheckpoint } = tm.start('fetch-1', '宿主拉取', { resumable: true });
    const manifest = { receivedBytes: 512, opfsName: 'tmp-x.zip' };

    client._inject.failKvSetAt = 1; // 后端自此全部拒写
    await onCheckpoint(manifest, { force: true, bytes: 512 }); // 节流落盘失败：仅告警
    expect(signal.aborted).toBe(false);

    expect(await tm.pause('fetch-1')).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(tm.get('fetch-1').state).toBe('paused');
    // 内存断点保留：本次会话内续传不受可选后端故障影响
    expect(tm.get('fetch-1').checkpoint).toEqual(manifest);
  });
});
