import { describe, expect, it, beforeEach } from 'vitest';
import { ExportQueue } from '../src/ui/export-queue.js';

// Node 环境无 DOM 下载，mock triggerBlobDownload 的依赖（document.createElement 等仅浏览器用）
// ExportQueue.enqueue 中 autoDownload 走 triggerBlobDownload —— 测试中不设 autoDownload 即可。

function makeBlob(size = 1024) {
  return new Blob([new Uint8Array(size)], { type: 'application/zip' });
}

describe('ExportQueue 待导出区状态机', () => {
  let queue;

  beforeEach(() => {
    queue = new ExportQueue();
  });

  it('入队：默认 converted 来源、ephemeral', () => {
    const item = queue.enqueue({ blob: makeBlob(), name: 'out.zip' });
    expect(queue.items.length).toBe(1);
    expect(item.origin).toBe('converted');
    expect(item.ephemeral).toBe(true);
    expect(item.storedId).toBe(null);
  });

  it('入队带自定义来源与目标格式', () => {
    const item = queue.enqueue({ blob: makeBlob(), name: 'a.zip', origin: 'host-export', targetLayout: 'st' });
    expect(item.origin).toBe('host-export');
    expect(item.targetLayout).toBe('st');
  });

  it('remove 移除条目并通知订阅者', () => {
    let notified = 0;
    queue.subscribe(() => notified++);
    const item = queue.enqueue({ blob: makeBlob(), name: 'x.zip' });
    queue.remove(item.id);
    expect(queue.items.length).toBe(0);
    expect(notified).toBe(2); // enqueue + remove
  });

  it('clear 清空全部', () => {
    queue.enqueue({ blob: makeBlob(), name: 'a.zip' });
    queue.enqueue({ blob: makeBlob(), name: 'b.zip' });
    queue.clear();
    expect(queue.items.length).toBe(0);
  });

  it('stash 在无 IndexedDB 环境（Node）安全降级', async () => {
    const item = queue.enqueue({ blob: makeBlob(), name: 's.zip' });
    // Node 环境 isStorageSupported() false → saveFile 返回 null，不抛错
    await queue.stash(item.id);
    expect(item.ephemeral).toBe(true); // 未真正入库（无 DB），但也不报错
  });

  it('download 临时产物触发 stash 路径不抛错（Node 降级）', async () => {
    const item = queue.enqueue({ blob: makeBlob(), name: 'd.zip' });
    await expect(queue.download(item.id)).resolves.toBeUndefined();
  });

  it('批量 stashAll/downloadAll 在 Node 降级下不抛错', async () => {
    queue.enqueue({ blob: makeBlob(), name: 'a.zip' });
    queue.enqueue({ blob: makeBlob(), name: 'b.zip' });
    await expect(queue.stashAll()).resolves.toBeUndefined();
    await expect(queue.downloadAll()).resolves.toBeUndefined();
  });
});
