/**
 * R-16 / U-5 / U-6 · 批量转换的编排核单测。
 *
 * 三条被锁定的语义（都来自真实失效形态，不是假想）：
 * 1. **子项游标**：断点 `itemIndex = k` ⇒ 前 k 个子项**不重跑**；
 * 2. **`AbortError` 必须终止循环**：其余错误"记日志继续"是既有语义，
 *    但暂停/中止是用户意图 —— 现状的 `catch { logger.error }` 会**吞掉 `AbortError` 并继续跑下一个包**，
 *    导致界面显示"已暂停"而后台还在往下跑，断点游标与实际进度脱节；
 * 3. **跨子项不得复用条目清单**：不同源包几乎必然含同名条目（`settings.json` 等），
 *    复用会让第二个子项**错误跳过** ⇒ 产物缺条目。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  batchResumeVerdict,
  createCheckpointThrottle,
  runBatchItems,
  seedEntriesFor,
} from '../index.js';

function abortError() {
  const err = new Error('转换任务已被中止/暂停');
  err.name = 'AbortError';
  return err;
}

describe('runBatchItems · 子项游标与中止语义', () => {
  it('从 startIndex 开始：已完成的子项不重跑', async () => {
    const seen = [];
    const res = await runBatchItems({
      items: ['a', 'b', 'c', 'd'],
      startIndex: 2,
      convertItem: async (item, i) => { seen.push([item, i]); },
    });

    expect(seen).toEqual([['c', 2], ['d', 3]]);
    expect(res).toMatchObject({ processed: 2, aborted: false, error: null });
  });

  it('startIndex 起点即末尾 ⇒ 什么都不做（幂等的空跑）', async () => {
    const convertItem = vi.fn(async () => {});
    const res = await runBatchItems({ items: ['a', 'b'], startIndex: 2, convertItem });
    expect(convertItem).not.toHaveBeenCalled();
    expect(res).toMatchObject({ processed: 0, aborted: false });
  });

  it('⭐ 第 k 个子项抛 AbortError ⇒ **后续子项一律不得被处理**', async () => {
    const calls = [];
    const res = await runBatchItems({
      items: [0, 1, 2, 3, 4],
      convertItem: async (item) => {
        calls.push(item);
        if (item === 2) throw abortError();
      },
    });

    // 判别力：把"rethrow/break"去掉（即被 catch 吞掉继续）⇒ calls 会变成 [0,1,2,3,4] 而转红
    expect(calls).toEqual([0, 1, 2]);
    expect(res.aborted).toBe(true);
    expect(res.error?.name).toBe('AbortError');
    expect(res.processed).toBe(2); // 抛错的那一个不算 processed
  });

  it('非中止错误：记日志后**继续**（单个坏包不打断整批）', async () => {
    const calls = [];
    const failures = [];
    const res = await runBatchItems({
      items: [0, 1, 2],
      convertItem: async (item) => {
        calls.push(item);
        if (item === 1) throw new Error('坏包');
      },
      onItemError: (err, i) => failures.push([err.message, i]),
    });

    expect(calls).toEqual([0, 1, 2]);          // 继续跑完了
    expect(failures).toEqual([['坏包', 1]]);
    expect(res).toMatchObject({ processed: 2, aborted: false, error: null });
  });

  it('不传 onItemError 时非中止错误也不得外泄（不得把整批炸掉）', async () => {
    const res = await runBatchItems({
      items: [0, 1],
      convertItem: async (item) => { if (item === 0) throw new Error('坏包'); },
    });
    expect(res.aborted).toBe(false);
    expect(res.processed).toBe(1);
  });
});

describe('batchResumeVerdict · 跨重载失效检测', () => {
  it('前提成立（产物数相符）⇒ 可续', () => {
    expect(batchResumeVerdict({ expectedOutputs: 3, productsPresent: 3 })).toEqual({ valid: true, reason: '' });
  });

  it('⚠️ 前提不成立（产物已不在内存）⇒ 作废，且原因里带两个数字', () => {
    const v = batchResumeVerdict({ expectedOutputs: 3, productsPresent: 1 });
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/3/);
    expect(v.reason).toMatch(/1/);
  });

  it('产物被清空（页面重载后队列为空）⇒ 作废，不得硬续', () => {
    expect(batchResumeVerdict({ expectedOutputs: 5, productsPresent: 0 }).valid).toBe(false);
  });
});

describe('⭐ 批量断点清单的往返（本轮实修过的缺陷）', () => {
  /** 落盘替身：`TaskManager.onCheckpoint` 把清单**原样**存成 `task.checkpoint`，`pause()` 落盘它 */
  const sinkOf = () => {
    const calls = [];
    return { sink: vi.fn(async (m) => { calls.push(m); }), calls };
  };

  /**
   * 复刻 `handleBatchConvert` 的清单组装（字段与顺序一致）。
   * @param {object} p
   * @param {boolean} p.legacy 只用旧的 `{doneEntries, totalEntries}`（= 曾经那个 bug 的形态）
   */
  function assembleBatchManifest({ legacy = false } = {}) {
    const outputs = [{ index: 0, name: 'a.zip' }];
    const itemIds = ['id0', 'id1'];
    const totalItems = 2;
    const nextIndex = 1; // 第 0 项已完成 ⇒ 下一个待处理是第 1 项
    const doneEntries = new Map([['chunk-0.jsonl', 123]]);

    const { sink, calls } = sinkOf();
    const maybeCheckpoint = createCheckpointThrottle(sink, doneEntries, legacy
      ? {} // 旧写法：不给 buildManifest
      : {
        buildManifest: (doneObject, { totalEntries = 0 } = {}) => ({
          kind: 'batch',
          itemIndex: nextIndex,
          outputs: [...outputs],
          doneEntries: doneObject,
          itemIds: [...itemIds],
          totalItems,
          totalEntries,
        }),
      });
    maybeCheckpoint({ force: true, totalEntries: 1 });
    return calls.at(-1);
  }

  it('⭐ 清单必须承载游标/产物/源包 id（否则续传永远作废重跑整批）', () => {
    const checkpoint = assembleBatchManifest();
    // 这三个字段是续传的全部依据：游标（从哪继续）、产物清单（还剩多少）、源包 id（去哪取源）
    expect(checkpoint.itemIndex).toBe(1);
    expect(checkpoint.outputs).toEqual([{ index: 0, name: 'a.zip' }]);
    expect(checkpoint.itemIds).toEqual(['id0', 'id1']);
    expect(checkpoint.totalItems).toBe(2);
    expect(checkpoint.kind).toBe('batch');
    expect(checkpoint.doneEntries).toEqual({ 'chunk-0.jsonl': 123 });
  });

  it('⭐ 往返：清单 → 落盘 → 续传判定 必须判为**可续**', () => {
    const checkpoint = assembleBatchManifest();
    // 内存队列里第 0 项的产物还在 ⇒ 数目相符 ⇒ 可续（**不是**"作废重跑"）
    const verdict = batchResumeVerdict({
      expectedOutputs: (checkpoint.outputs ?? []).length,
      productsPresent: 1,
    });
    expect(verdict.valid).toBe(true);
  });

  it('⚠️ 旧写法（清单只有 doneEntries/totalEntries）⇒ **静默误判**，故作废重跑', () => {
    // 这是本仓实际栽过的形态：`{doneEntries, totalEntries}` 原样成为 `task.checkpoint`
    // ⇒ `checkpoint.outputs` 为 undefined ⇒ 失效检测把「已完成 1 项」读成「0 项」
    // ⇒ 与内存里真实存在的 1 个产物不符 ⇒ **每次续传都作废重跑整批**（跳过语义永不生效）。
    const legacy = assembleBatchManifest({ legacy: true });
    expect(legacy.itemIndex).toBeUndefined();
    expect(legacy.outputs).toBeUndefined();
    const verdict = batchResumeVerdict({
      expectedOutputs: (legacy.outputs ?? []).length, // = 0（读不到）
      productsPresent: 1,                             // 实际有 1 个
    });
    expect(verdict.valid).toBe(false);
  });
});

describe('seedEntriesFor · 条目清单只对断点指向的那个子项有效', () => {
  const checkpoint = { itemIndex: 2, doneEntries: { 'settings.json': 999, 'a.png': 111 } };

  it('游标命中当前子项 ⇒ 播种（该子项已完成的条目不重做）', () => {
    const seeded = seedEntriesFor({ checkpoint, index: 2, startIndex: 2 });
    expect(seeded.size).toBe(2);
    expect(seeded.get('settings.json')).toBe(999);
  });

  it('⭐ 游标不命中 ⇒ 空清单（跨子项复用会因**同名条目**错误跳过 ⇒ 产物缺条目）', () => {
    // 'settings.json' 在两个源包里都存在 —— 若把上一个子项的清单拿来用，
    // 第二个子项的 settings.json 会被当成"已完成"而**跳过**。
    expect(seedEntriesFor({ checkpoint, index: 3, startIndex: 2 }).size).toBe(0);
    expect(seedEntriesFor({ checkpoint, index: 1, startIndex: 2 }).size).toBe(0);
  });

  it('无断点 / 无清单 ⇒ 空 Map（新任务与小任务都走这条）', () => {
    expect(seedEntriesFor({ checkpoint: null, index: 0, startIndex: 0 }).size).toBe(0);
    expect(seedEntriesFor({ checkpoint: { itemIndex: 0 }, index: 0, startIndex: 0 }).size).toBe(0);
  });

  it('返回的是**新的** Map（不得共享引用）', () => {
    const a = seedEntriesFor({ checkpoint, index: 2, startIndex: 2 });
    const b = seedEntriesFor({ checkpoint, index: 2, startIndex: 2 });
    expect(a).not.toBe(b);
    a.set('x', 1);
    expect(b.has('x')).toBe(false);
  });
});
