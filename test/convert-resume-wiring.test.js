/**
 * R-16 · 转换路径的**断点落盘契约**单测。
 *
 * ⚠️ 本文件守护的是本次修复里最隐蔽的一处缺陷（`design.md` D0.2b）：
 *
 * `runConversionTask` 的 `onEntryDone` 是**顶层参数**，只被传进**主线程降级分支**；
 * Worker 分支经 `postMessage`，函数**过不了结构化克隆** ⇒ **真浏览器里永不触发**
 * （`src/core/worker-client.js:89` 的 JSDoc："主线程路径直通；Worker 路径由 onProgress 累积"）。
 *
 * 若把断点落盘挂到 `onEntryDone` 上：浏览器里断点**永不落盘** ⇒ 暂停后无法续传（= R-16 没修），
 * 而 `npm test` **全绿** —— 因为 Vitest 无 `Worker`，走的是主线程路径，`onEntryDone` 会触发。
 * **缺陷被测试掩盖**，这正是本仓最怕的那类形态。
 *
 * 所以这里把契约拆成可断言的形式：
 * - `attachConversionProgress` 的单测**只按 Worker 路径的签名调用**（只有 `onProgress`），
 *   断言断点仍被喂到；
 * - 「是否真的接在 `onProgress` 上」由 **E2E（真浏览器 / 真 Worker）** 守 —— 两者缺一不可。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  attachConversionProgress,
  convertExitForAbort,
  createCheckpointThrottle,
  resumedNote,
} from '../index.js';

/** 造一个与 TaskManager.onCheckpoint 同形的落盘替身 */
function fakeCheckpointSink() {
  const calls = [];
  const sink = vi.fn(async (manifest) => { calls.push(manifest); });
  return { sink, calls };
}

describe('attachConversionProgress · Worker 路径回调契约', () => {
  it('⭐ 只调 onProgress（模拟 Worker 路径）⇒ 断点仍被喂到', async () => {
    const { sink, calls } = fakeCheckpointSink();
    const doneEntries = new Map();
    const maybeCheckpoint = createCheckpointThrottle(sink, doneEntries);
    const track = attachConversionProgress({ doneEntries, maybeCheckpoint });

    // Worker 路径**只会**调这一个签名（onEntryDone 在那条路径上根本不存在）
    track(1, 3, 'characters/A.png', 111);
    track(2, 3, 'chats/A.jsonl', 222);
    track(3, 3, 'settings.json', 333); // 末条 ⇒ force

    expect(doneEntries.size).toBe(3);
    expect(doneEntries.get('characters/A.png')).toBe(111);
    // 断点确实落盘了 —— 只挂 onEntryDone 的实现会让这里为 0
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.at(-1).doneEntries['settings.json']).toBe(333);
  });

  it('无 crc32 的回调不得污染清单（进度消息可能不带 crc）', () => {
    const { sink } = fakeCheckpointSink();
    const doneEntries = new Map();
    const track = attachConversionProgress({
      doneEntries, maybeCheckpoint: createCheckpointThrottle(sink, doneEntries),
    });

    track(1, 2, 'x.png', undefined);
    track(2, 2, undefined, 123);

    expect(doneEntries.size).toBe(0);
  });

  it('⭐ 方向纪律：断点内容 ⊆ 已完成条目（滞后安全、超前是缺陷）', () => {
    const { sink, calls } = fakeCheckpointSink();
    const doneEntries = new Map();
    const track = attachConversionProgress({
      doneEntries, maybeCheckpoint: createCheckpointThrottle(sink, doneEntries, { everyEntries: 1 }),
    });

    track(1, 4, 'a', 1);
    track(2, 4, 'b', 2);

    // 每次落盘的清单必须**只含当时已完成**的条目 ——
    // 超前（含未完成条目）会让续传**错误跳过**它们 ⇒ 产物缺条目
    expect(calls[0].doneEntries).toEqual({ a: 1 });
    expect(calls[1].doneEntries).toEqual({ a: 1, b: 2 });
  });
});

describe('convertExitForAbort · 收尾出口判定', () => {
  const abortErr = () => Object.assign(new Error('转换任务已被中止/暂停'), { name: 'AbortError' });

  it('⭐⭐ AbortError + PAUSED ⇒ paused，**绝不是 fail**（本设计最容易写错的一处）', () => {
    // 误走 fail() ⇒ `fail` 会 adapter.remove(id) 清掉**刚落盘的断点** ⇒ 续传能力当场失效，
    // 且 UI 显示"失败"，而暂停是正常用户操作。
    const { action } = convertExitForAbort({ err: abortErr(), record: { state: 'paused' } });
    expect(action).toBe('paused');
    expect(action).not.toBe('fail');
  });

  it('AbortError + ABORTED ⇒ aborted（中止丢弃断点已由 TaskManager.abort 完成）', () => {
    expect(convertExitForAbort({ err: abortErr(), record: { state: 'aborted' } }).action).toBe('aborted');
  });

  it('AbortError 但任务已不在 PAUSED/ABORTED ⇒ none（不做事，尤其不得 fail）', () => {
    for (const state of ['running', 'done', 'failed', undefined]) {
      expect(convertExitForAbort({ err: abortErr(), record: state ? { state } : null }).action).toBe('none');
    }
    expect(convertExitForAbort({ err: abortErr(), record: null }).action).toBe('none');
  });

  it('非中止错误 ⇒ fail（与任务状态无关）', () => {
    expect(convertExitForAbort({ err: new Error('坏包'), record: { state: 'running' } }).action).toBe('fail');
    expect(convertExitForAbort({ err: new Error('坏包'), record: { state: 'paused' } }).action).toBe('fail');
    expect(convertExitForAbort({ err: undefined, record: null }).action).toBe('fail');
  });

  it('name 相似但不是 AbortError 的错误 ⇒ fail（不得靠字符串匹配蒙混）', () => {
    const e = Object.assign(new Error('x'), { name: 'Aborted' });
    expect(convertExitForAbort({ err: e, record: { state: 'paused' } }).action).toBe('fail');
  });
});

describe('resumedNote · 续传命中的可观测面', () => {
  it('⭐ 字段是 `totals.resumed`（**不是** `resumedCount` —— 该字段从不存在）', () => {
    // 仓里曾有注释与用例名写作 `resumedCount`，全仓零赋值零读取 ⇒ 永远 undefined。
    // 本条锁住真实字段名，否则 E2E 的「续传可观测」断言会永远读不到值。
    expect(resumedNote({ totals: { resumed: 3 } })).toContain('3');
    expect(resumedNote({ resumedCount: 3 })).toBe(''); // 用错字段名 ⇒ 拿不到提示（无声失效）
  });

  it('无命中 / 缺字段 ⇒ 空串（正常转换不被噪音污染）', () => {
    expect(resumedNote({ totals: { resumed: 0 } })).toBe('');
    expect(resumedNote({})).toBe('');
    expect(resumedNote(null)).toBe('');
    expect(resumedNote(undefined)).toBe('');
  });

  it('文案含「沿用断点」字样（E2E 据此断言）', () => {
    expect(resumedNote({ totals: { resumed: 1 } })).toContain('沿用断点');
  });
});

describe('createCheckpointThrottle · 节流与首次落盘', () => {
  it('⭐ 首次调用即落盘 —— 这是**载荷属性**，不是 bug', () => {
    // `lastFlushAt` 初值 0 ⇒ 时间条件立刻成立。为什么必须如此：
    // `TaskManager.pause()` 落盘的是**内存里的 `task.checkpoint`**，而它只在 `onCheckpoint`
    // **被调用时**才更新 ⇒ 若首次调用被节流掉，那么"任务刚开始就暂停"会因 `checkpoint === null`
    // 而 `resume()` 返回 null ⇒ **无法续传**（正是 R-16 的形态）。
    // 该行为与 `src/core/task-manager.js` 自身的节流一致（它的时间条件同样在首调用成立）。
    const { sink } = fakeCheckpointSink();
    const doneEntries = new Map();
    const maybeCheckpoint = createCheckpointThrottle(sink, doneEntries, { everyEntries: 999, everyMs: 60_000 });

    doneEntries.set('a', 1);
    maybeCheckpoint({ totalEntries: 1 });

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0].doneEntries).toEqual({ a: 1 });
  });

  it('窗口内**不为每个条目**建对象（O(n) 的 fromEntries 不得每 tick 跑一次）', () => {
    const { sink } = fakeCheckpointSink();
    const doneEntries = new Map();
    const maybeCheckpoint = createCheckpointThrottle(sink, doneEntries, { everyEntries: 64, everyMs: 60_000 });

    for (let i = 1; i <= 63; i += 1) {
      doneEntries.set(`f${i}`, i);
      maybeCheckpoint({ totalEntries: 63 });
    }
    // 63 个条目只落盘 1 次（首次），**不是 63 次** —— 后者会让 8683 条目的包产生
    // 约 7500 万次短命对象分配（O(n²) + GC 压力）
    expect(sink).toHaveBeenCalledTimes(1);

    // 窗口从**上次落盘时**的 size 起算：首次落盘时 size=1 ⇒ 需再攒满 64 条才到期
    for (let i = 64; i <= 64; i += 1) {
      doneEntries.set(`f${i}`, i);
      maybeCheckpoint({ totalEntries: 64 });
    }
    expect(sink).toHaveBeenCalledTimes(1); // 64 - 1 = 63 < 64 ⇒ 仍未到期

    doneEntries.set('f65', 65);
    maybeCheckpoint({ totalEntries: 65 }); // 65 - 1 = 64 ⇒ 到期
    expect(sink).toHaveBeenCalledTimes(2);
    expect(Object.keys(sink.mock.calls[1][0].doneEntries).length).toBe(65);
  });

  it('force 绕过节流（末条 / 子项边界必须落一次）', () => {
    const { sink } = fakeCheckpointSink();
    const doneEntries = new Map([['a', 1]]);
    const maybeCheckpoint = createCheckpointThrottle(sink, doneEntries, { everyEntries: 999, everyMs: 60_000 });

    maybeCheckpoint({ totalEntries: 1 });   // 首次 ⇒ 落
    expect(sink).toHaveBeenCalledTimes(1);

    sink.mockClear();
    maybeCheckpoint({ totalEntries: 1 });   // 窗口内、无 force ⇒ 不落
    expect(sink).not.toHaveBeenCalled();

    maybeCheckpoint({ force: true, totalEntries: 1 });
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('时间窗口到期也落盘（不只看条数）', () => {
    vi.useFakeTimers();
    try {
      const { sink } = fakeCheckpointSink();
      const doneEntries = new Map();
      const maybeCheckpoint = createCheckpointThrottle(sink, doneEntries, { everyEntries: 999, everyMs: 2000 });

      doneEntries.set('a', 1);
      maybeCheckpoint({ totalEntries: 1 });  // 首次 ⇒ 落
      sink.mockClear();

      maybeCheckpoint({ totalEntries: 1 });  // 未到期 ⇒ 不落
      expect(sink).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2001);
      maybeCheckpoint({ totalEntries: 1 });
      expect(sink).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
