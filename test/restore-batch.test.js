import { describe, it, expect, vi } from 'vitest';
import {
  BATCH_STATUS,
  ITEM_STATUS,
  createRestoreBatch,
} from '../src/core/restore-batch.js';

/**
 * 批量恢复编排状态机单测（需求见
 * `.trellis/tasks/09-25-batch-restore-luker-endpoint/prd.md` §R2 与 `design.md` §3）。
 *
 * 纯逻辑、无 DOM、无 fetch —— 本仓无 jsdom，故状态机放 `src/core/` 以便直测
 * （与 `task-manager.js` 同形）。
 */

/** 造 items */
const mkItems = (...names) => names.map((n) => ({ id: n, name: `${n}.zip` }));

/** 造 restoreOne：按 name 决定行为 */
function restoreOneBy(rules) {
  const calls = [];
  const fn = vi.fn(async ({ id }) => {
    calls.push(id);
    const rule = rules[id];
    if (rule instanceof Error) throw rule;
    return rule ?? { success: true };
  });
  fn.calls = calls;
  return fn;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createRestoreBatch：逐项推进与收尾态', () => {
  it('全部成功 → done，且按 items 顺序执行', async () => {
    const restoreOne = restoreOneBy({ a: { success: true }, b: { success: true }, c: { success: true } });
    const batch = createRestoreBatch({ items: mkItems('a', 'b', 'c'), restoreOne });

    const state = await batch.start();
    expect(restoreOne.calls).toEqual(['a', 'b', 'c']);
    expect(state.status).toBe(BATCH_STATUS.DONE);
    expect(state.doneCount).toBe(3);
    expect(state.failedCount).toBe(0);
    expect(state.items.every((i) => i.status === ITEM_STATUS.DONE)).toBe(true);
  });

  it('单项失败不中断整批，收尾为 partial-failed 且保留逐项原因', async () => {
    const restoreOne = restoreOneBy({
      a: { success: true },
      b: new Error('恢复失败 (500): boom'),
      c: { success: true },
    });
    const batch = createRestoreBatch({ items: mkItems('a', 'b', 'c'), restoreOne });

    const state = await batch.start();
    expect(restoreOne.calls).toEqual(['a', 'b', 'c']); // 失败项之后的项照跑
    expect(state.status).toBe(BATCH_STATUS.PARTIAL_FAILED);
    expect(state.doneCount).toBe(2);
    expect(state.failedCount).toBe(1);
    expect(state.items.find((i) => i.id === 'b').reason).toContain('500');
  });

  it('restoreToHost 返回 success:false（未抛错）同样记为失败，不得当成功', async () => {
    const restoreOne = restoreOneBy({ a: { success: false, reason: '宿主未确认成功' } });
    const batch = createRestoreBatch({ items: mkItems('a'), restoreOne });

    const state = await batch.start();
    expect(state.status).toBe(BATCH_STATUS.PARTIAL_FAILED);
    expect(state.items[0].status).toBe(ITEM_STATUS.FAILED);
  });
});

describe('createRestoreBatch：未确认态（诚实性核心）', () => {
  it('unconfirmed 记为 unconfirmed 而非 done，且收尾为 partial-failed', async () => {
    const restoreOne = restoreOneBy({
      a: { success: true },
      b: { success: false, unconfirmed: true, reason: '响应体不可解析' },
    });
    const batch = createRestoreBatch({ items: mkItems('a', 'b'), restoreOne });

    const state = await batch.start();
    expect(state.items.find((i) => i.id === 'b').status).toBe(ITEM_STATUS.UNCONFIRMED);
    expect(state.unconfirmedCount).toBe(1);
    expect(state.doneCount).toBe(1);
    expect(state.status).toBe(BATCH_STATUS.PARTIAL_FAILED);
  });

  it('retryFailed 不重跑未确认项（请求可能已落盘，重跑等于重复写入）', async () => {
    const restoreOne = restoreOneBy({
      a: { success: true },
      b: { success: false, unconfirmed: true, reason: '未确认' },
      c: new Error('失败'),
    });
    const batch = createRestoreBatch({ items: mkItems('a', 'b', 'c'), restoreOne });
    await batch.start();
    restoreOne.calls.length = 0;

    // 重跑前：可重跑标记为真（失败项存在）
    expect(batch.getState().canRetryFailed).toBe(true);

    const afterRetry = batch.retryFailed();
    // 只有明确失败项回到队列；未确认项保持 unconfirmed
    expect(afterRetry.items.filter((i) => i.status === ITEM_STATUS.QUEUED).map((i) => i.id)).toEqual(['c']);
    expect(afterRetry.items.find((i) => i.id === 'b').status).toBe(ITEM_STATUS.UNCONFIRMED);
    expect(afterRetry.canContinue).toBe(true);

    await batch.start();
    expect(restoreOne.calls).toEqual(['c']); // 未确认项 b 未被重跑
  });
});

describe('createRestoreBatch：重跑与中止', () => {
  it('重跑只跑失败项，已成功项不重复恢复', async () => {
    let failFirst = true;
    const restoreOne = vi.fn(async ({ id }) => {
      if (id === 'b' && failFirst) throw new Error('首次失败');
      return { success: true };
    });
    const batch = createRestoreBatch({ items: mkItems('a', 'b'), restoreOne });

    await batch.start();
    expect(batch.getState().status).toBe(BATCH_STATUS.PARTIAL_FAILED);

    failFirst = false;
    batch.retryFailed();
    const state = await batch.start();
    expect(state.status).toBe(BATCH_STATUS.DONE);
    // a 只跑过一次（第二次 start 只跑了 b）
    expect(restoreOne.mock.calls.filter(([arg]) => arg.id === 'a')).toHaveLength(1);
    expect(restoreOne.mock.calls.filter(([arg]) => arg.id === 'b')).toHaveLength(2);
  });

  it('中止：在途项正常完成则仍记成功，未跑的项保持 queued，续跑只跑未完成项', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const restoreOne = vi.fn(async ({ id }) => {
      if (id === 'b') await gate;
      return { success: true };
    });
    const batch = createRestoreBatch({ items: mkItems('a', 'b', 'c'), restoreOne });
    const started = batch.start();
    await flush(); // 让 a 完成、b 进入 running

    batch.abort();
    release(); // b 的请求已完成（未被底层取消）→ 必须如实记为成功，而不是「已中止」
    const state = await started;

    expect(state.status).toBe(BATCH_STATUS.ABORTED);
    expect(state.items.find((i) => i.id === 'a').status).toBe(ITEM_STATUS.DONE);
    expect(state.items.find((i) => i.id === 'b').status).toBe(ITEM_STATUS.DONE);
    expect(state.items.find((i) => i.id === 'c').status).toBe(ITEM_STATUS.QUEUED);
    expect(state.canContinue).toBe(true);

    // 续跑：只跑未完成的 c
    const resumed = await batch.start();
    expect(resumed.status).toBe(BATCH_STATUS.DONE);
    expect(restoreOne.mock.calls.filter(([arg]) => arg.id === 'c')).toHaveLength(1);
  });

  it('中止时 AbortError 记「已取消」，其他错误仍记失败', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const restoreOne = vi.fn(async () => {
      await gate;
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    });
    const batch = createRestoreBatch({ items: mkItems('a'), restoreOne });
    const started = batch.start();
    await flush();
    batch.abort();
    release();
    const state = await started;

    expect(state.items[0].status).toBe(ITEM_STATUS.ABORTED);
    expect(state.items[0].reason).toContain('取消');
  });

  it('onUpdate 随状态变化回调，快照含计数且为拷贝（外部改不动内部状态）', async () => {
    const seen = [];
    const restoreOne = restoreOneBy({ a: { success: true } });
    const batch = createRestoreBatch({
      items: mkItems('a'),
      restoreOne,
      onUpdate: (s) => seen.push(s),
    });
    await batch.start();

    expect(seen.length).toBeGreaterThanOrEqual(3); // running → item running → done → 收尾
    const last = seen[seen.length - 1];
    expect(last.status).toBe(BATCH_STATUS.DONE);
    expect(last.doneCount).toBe(1);

    last.items[0].status = '篡改';
    expect(batch.getState().items[0].status).toBe(ITEM_STATUS.DONE);
  });

  it('start 进行中重复调用直接返回当前快照（不并发跑第二遍）', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const restoreOne = vi.fn(async () => { await gate; return { success: true }; });
    const batch = createRestoreBatch({ items: mkItems('a'), restoreOne });

    const first = batch.start();
    await flush();
    const second = batch.start(); // 进行中
    expect(restoreOne).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(await second).toMatchObject({ status: BATCH_STATUS.RUNNING }); // 返回的是当时快照
    expect(restoreOne).toHaveBeenCalledTimes(1);
  });
});
