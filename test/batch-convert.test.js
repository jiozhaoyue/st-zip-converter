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
import { batchResumeVerdict, runBatchItems, seedEntriesFor } from '../index.js';

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
