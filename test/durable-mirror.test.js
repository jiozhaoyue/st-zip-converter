import { describe, it, expect, beforeEach, vi } from 'vitest';

// db.js 在 Node 无 IndexedDB 会降级返回 null，镜像路径依赖 storedId，
// 这里 mock saveFile 固定返回成功 id 以驱动 stash/ensureStored 全路径。
vi.mock('../src/storage/db.js', () => ({
  saveFile: vi.fn(async () => 'stored-1'),
  deleteFile: vi.fn(async () => true),
  getFile: vi.fn(async () => null),
  ORIGINS: Object.freeze({
    UPLOAD: 'upload',
    HOST_EXPORT: 'host-export',
    CONVERTED: 'converted',
    DELTA: 'delta',
    SPLIT_PART: 'split-part',
  }),
}));

const { ExportQueue } = await import('../src/ui/export-queue.js');
const { putArtifact, __setAuthorityClientForTest } = await import('../src/storage/authority-store.js');

// fire-and-forget 镜像链为异步微任务，断言前用宏任务清空
const flushAsync = () => new Promise((r) => setTimeout(r, 10));

/** 构造 mock Authority client：KV + blob 内存实现 */
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
          return rec ? { content: rec.content } : null;
        },
        delete: async ({ name }) => { blobs.delete(name); },
      },
    },
    _kv: kv,
    _blobs: blobs,
  };
}

describe('export-queue 入库 → Authority 持久归档镜像', () => {
  beforeEach(() => __setAuthorityClientForTest(undefined));

  it('stash 入库成功时镜像产物到 Authority blob', async () => {
    const client = mockClient();
    __setAuthorityClientForTest(client);
    const queue = new ExportQueue();
    const item = queue.enqueue({
      blob: new Blob([new Uint8Array(2048)], { type: 'application/zip' }),
      name: 'out-l.zip',
      targetLayout: 'l',
    });

    await queue.stash(item.id);
    expect(item.storedId).toBe('stored-1');
    expect(item.ephemeral).toBe(false);
    await flushAsync();
    // 镜像落盘：blob part + KV 清单
    expect(client._blobs.has('out-l.zip__part_000000')).toBe(true);
    expect(client._kv.has('blob-manifest:out-l.zip')).toBe(true);
  });

  it('Authority 不可用时 stash 正常完成且不报错', async () => {
    __setAuthorityClientForTest(null);
    const queue = new ExportQueue();
    const item = queue.enqueue({ blob: new Blob(['x']), name: 'out.zip' });
    await queue.stash(item.id);
    expect(item.storedId).toBe('stored-1');
  });

  it('ensureStored 下载路径同样触发镜像', async () => {
    const client = mockClient();
    __setAuthorityClientForTest(client);
    const queue = new ExportQueue();
    const item = queue.enqueue({ blob: new Blob(['y']), name: 'quick.zip' });
    const id = await queue.ensureStored(item.id);
    expect(id).toBe('stored-1');
    await flushAsync();
    expect(client._kv.has('blob-manifest:quick.zip')).toBe(true);
  });

  it('已入库条目重复 stash 不重复镜像', async () => {
    const client = mockClient();
    __setAuthorityClientForTest(client);
    const queue = new ExportQueue();
    const item = queue.enqueue({ blob: new Blob(['z']), name: 'once.zip' });
    await queue.stash(item.id);
    await flushAsync();
    const manifestCount = () => [...client._kv.keys()].filter((k) => k.startsWith('blob-manifest:once')).length;
    await queue.stash(item.id);
    await queue.stashAll();
    await flushAsync();
    expect(manifestCount()).toBe(1);
  });

  it('putArtifact 直连：同名覆盖保留最新产物', async () => {
    const client = mockClient();
    __setAuthorityClientForTest(client);
    await putArtifact('a.zip', new Blob(['v1']));
    await putArtifact('a.zip', new Blob([new Uint8Array(1024)]));
    expect(client._blobs.has('a.zip__part_000000')).toBe(true);
    const manifest = client._kv.get('blob-manifest:a.zip');
    expect(manifest.size).toBe(1024);
  });
});
