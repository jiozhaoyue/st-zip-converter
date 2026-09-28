import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

/**
 * 协作式暂停协议（`L1-MR-7` 有界等待 + `L1-MR-8` 生命周期）。
 *
 * 契约：暂停不再「主线程一上来就 `terminate()` 丢掉半成品」，而是
 *  ① 发 `PAUSE` 请 worker 收尾 → ② 有界等待 `PAUSED` 回报 → ③ **无论有无半成品都 terminate**。
 *
 * 这里用最小 Worker 桩真正走到 Worker 分支（做法与 `worker-terminate-guard.test.js` 同）。
 */

const g = globalThis;
let instances = [];

class FakeWorker {
  constructor() {
    this.terminated = false;
    this.posted = [];
    this.listeners = [];
    instances.push(this);
  }
  addEventListener(type, fn) { if (type === 'message') this.listeners.push(fn); }
  removeEventListener(type, fn) { if (type === 'message') this.listeners = this.listeners.filter((f) => f !== fn); }
  postMessage(msg) { this.posted.push(msg); }
  terminate() { this.terminated = true; }
  emit(data) { for (const fn of [...this.listeners]) fn({ data }); }
}

async function freshModule() {
  vi.resetModules();
  return import('../src/core/worker-client.js');
}

function startTask(mod, { onPaused, finalizeOnAbort = true } = {}) {
  const ac = new AbortController();
  const p = mod.runConversionTask({
    source: new Blob([new Uint8Array([1, 2, 3])]),
    target: 'st',
    options: { signal: ac.signal, finalizeOnAbort },
    onPaused,
  });
  return { ac, settled: p.then(() => 'resolved', (e) => `rejected:${e?.name}`) };
}

describe('runConversionTask 协作式暂停协议', () => {
  beforeEach(() => {
    instances = [];
    g.window = g.window || {};
    g.Worker = FakeWorker;
  });

  afterEach(() => {
    delete g.Worker;
    delete g.window;
    vi.useRealTimers();
  });

  it('① 收到 PAUSED ⇒ onPaused 拿到半成品，随后仍以 AbortError 拒绝，并 terminate', async () => {
    const mod = await freshModule();
    const seen = [];
    const { ac, settled } = startTask(mod, { onPaused: (p) => { seen.push(p); } });
    ac.abort();

    // 主线程必须**先发 PAUSE 请求**，而不是直接终止
    const w = instances[0];
    expect(w.posted.some((m) => m.type === 'PAUSE')).toBe(true);
    expect(w.terminated).toBe(false); // 还在等收尾

    const partialBlob = new Blob([new Uint8Array([9, 9])]);
    const manifest = [{ name: 'a.txt', crc32: 123, compressedSize: 4 }];
    w.emit({ type: 'PAUSED', id: w.posted.find((m) => m.type === 'CONVERT').id, partialBlob, manifest });

    expect(await settled).toBe('rejected:AbortError');
    expect(seen).toHaveLength(1);
    expect(seen[0].partialBlob).toBe(partialBlob);
    expect(seen[0].manifest).toEqual(manifest);
    expect(w.terminated).toBe(true);
  });

  it('②【有界兜底】worker 不回 PAUSED ⇒ 超时后仍拒绝 AbortError、onPaused 不被调用', async () => {
    vi.useFakeTimers();
    const mod = await freshModule();
    const onPaused = vi.fn();
    const { ac, settled } = startTask(mod, { onPaused });
    ac.abort();

    const w = instances[0];
    expect(w.terminated).toBe(false);

    await vi.advanceTimersByTimeAsync(30000);
    expect(await settled).toBe('rejected:AbortError');
    expect(onPaused).not.toHaveBeenCalled();
    expect(w.terminated).toBe(true);
  });

  it('③【L1-MR-8 回归】超时兜底之后再发起任务必须**新建** Worker（引用已置空）', async () => {
    vi.useFakeTimers();
    const mod = await freshModule();
    const first = startTask(mod, { onPaused: vi.fn() });
    first.ac.abort();
    await vi.advanceTimersByTimeAsync(30000);
    expect(await first.settled).toBe('rejected:AbortError');
    expect(instances).toHaveLength(1);

    vi.useRealTimers();
    // 第二次用旧语义（finalizeOnAbort:false）：本用例只关心「是否新建 Worker」，
    // 用真计时器等 30s 有界兜底没有意义
    const second = startTask(mod, { onPaused: vi.fn(), finalizeOnAbort: false });
    second.ac.abort();
    expect(instances).toHaveLength(2); // 未置空则会复用死实例 ⇒ 此断言转红
    expect(instances[1]).not.toBe(instances[0]);
    expect(await second.settled).toBe('rejected:AbortError');
  });

  it('④ onPaused 自身抛错 ⇒ 不影响暂停语义（仍拒绝 AbortError，不静默挂起）', async () => {
    const mod = await freshModule();
    const { ac, settled } = startTask(mod, {
      onPaused: () => { throw new Error('落盘失败'); },
    });
    ac.abort();
    const w = instances[0];
    w.emit({
      type: 'PAUSED',
      id: w.posted.find((m) => m.type === 'CONVERT').id,
      partialBlob: null,
      manifest: null,
    });
    expect(await settled).toBe('rejected:AbortError');
    expect(w.terminated).toBe(true);
  });

  it('⑤ 未开 finalizeOnAbort（旧语义）⇒ 立即终止、不发 PAUSE、onPaused 不调用', async () => {
    const mod = await freshModule();
    const onPaused = vi.fn();
    const { ac, settled } = startTask(mod, { onPaused, finalizeOnAbort: false });
    ac.abort();
    expect(await settled).toBe('rejected:AbortError');
    const w = instances[0];
    expect(w.posted.some((m) => m.type === 'PAUSE')).toBe(false);
    expect(w.terminated).toBe(true);
    expect(onPaused).not.toHaveBeenCalled();
  });

  it('⑥ DONE 正常路径不受影响（不再重复结算，且不 terminate 自身）', async () => {
    const mod = await freshModule();
    const { settled } = startTask(mod, { onPaused: vi.fn() });
    const w = instances[0];
    w.emit({ type: 'DONE', id: w.posted.find((m) => m.type === 'CONVERT').id, report: { ok: 1 } });
    expect(await settled).toBe('resolved');
    expect(w.terminated).toBe(false);
  });
});
