import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

/**
 * `L1-MR-8` 守护（本任务 **AC-B4**）：`worker.terminate()` 之后**必须**把持有它的变量置空。
 *
 * 事故原型（本仓 `034b7ab`）：terminate 后未置空 ⇒ 被终止的 Worker **静默忽略**所有
 * `postMessage` ⇒ 此后**每一次**转换都永久挂起，表现为「不报错但就是不动」，
 * 排查成本极高（《L1-MR-8 Worker 生命周期：terminate 后必须置空引用》）。
 *
 * 判别力点在第 2 条用例：第一次中止后**再发起一次**任务，必须**新建** Worker 实例；
 * 把 `workerInstance = null` 去掉 ⇒ `instances.length` 停在 1 ⇒ 该用例转红。
 *
 * 做法：Node 里 `supportsWebWorker()` 为假（无 `window`/`Worker`）会走主线程降级，
 * 故此处**装最小桩**把两条全局补上，再用动态 `import` 拿一份干净的模块实例
 * （`vi.resetModules()`），从而真正走到 Worker 分支。
 */

const g = globalThis;
let instances = [];

class FakeWorker {
  constructor() {
    this.terminated = false;
    this.posted = [];
    instances.push(this);
  }
  addEventListener() {}
  removeEventListener() {}
  postMessage(msg) { this.posted.push(msg); }
  terminate() { this.terminated = true; }
}

/** 起一个任务并立刻中止；返回其结算文本（避免未处理拒绝噪声） */
async function startAbortedTask() {
  const mod = await import('../src/core/worker-client.js');
  const ac = new AbortController();
  const p = mod.runConversionTask({
    source: new Blob([new Uint8Array([1, 2, 3])]),
    target: 'st',
    options: { signal: ac.signal },
  });
  const settled = p.then(() => 'resolved', (e) => `rejected:${e && e.name}`);
  ac.abort();
  return settled;
}

describe('runConversionTask 中止路径（L1-MR-8：terminate 后置空引用）', () => {
  beforeEach(() => {
    instances = [];
    vi.resetModules();
    g.window = g.window || {};
    g.Worker = FakeWorker;
  });

  afterEach(() => {
    delete g.Worker;
    delete g.window;
  });

  it('确实走了 Worker 分支（桩生效，不是主线程降级）', async () => {
    const settled = await startAbortedTask();
    expect(instances.length).toBe(1);
    expect(await settled).toBe('rejected:AbortError');
  });

  it('中止时 terminate 当前 Worker，并以 AbortError 拒绝', async () => {
    const settled = await startAbortedTask();
    expect(instances[0].terminated).toBe(true);
    expect(await settled).toBe('rejected:AbortError');
  });

  it('**判别力点**：中止后再发起任务必须**新建** Worker（未置空则复用死实例 ⇒ 永久挂起）', async () => {
    await startAbortedTask();
    expect(instances.length).toBe(1);

    await startAbortedTask(); // 第二次：若引用没置空，这里会复用第一个（已 terminated）实例
    expect(instances.length).toBe(2);
    expect(instances[1]).not.toBe(instances[0]);
    expect(instances[1].terminated).toBe(true);
  });
});
