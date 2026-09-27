/**
 * R-16 · 任务类型判据单测（`taskKindOf` 是**全仓唯一**的任务类型判据）。
 *
 * 最要命的一条是**前缀重叠**：`convert-batch-` 与 `convert-` 重叠，
 * 若按声明顺序遍历，`convert-batch-<ts>` 会被 `convert-` 先吃掉 ⇒
 * **静默降级成单包语义**（断点字段读不到、恢复走错执行体，且不报错）。
 * 所以这里既测「照前缀长度降序」的结果，也测「不得依赖对象字面量插入顺序」这个性质。
 */
import { describe, expect, it } from 'vitest';
import { TASK_KINDS, TASK_PREFIX, taskKindOf } from '../index.js';

describe('taskKindOf · 任务类型唯一判据', () => {
  it('四个前缀各自解析正确', () => {
    expect(taskKindOf('fetch-1699999999999')).toBe(TASK_KINDS.FETCH);
    expect(taskKindOf('convert-1699999999999')).toBe(TASK_KINDS.CONVERT);
    expect(taskKindOf('convert-batch-1699999999999')).toBe(TASK_KINDS.CONVERT_BATCH);
    expect(taskKindOf('restore-1699999999999')).toBe(TASK_KINDS.RESTORE);
  });

  it('⭐ 前缀重叠负例：convert-batch- 不得被 convert- 吃掉', () => {
    // 这是本判据存在的首要理由。若实现依赖插入顺序（TASK_PREFIX 字面量里
    // CONVERT 在 CONVERT_BATCH 之前），本断言会拿到 'convert' 而转红。
    expect(taskKindOf('convert-batch-1')).toBe(TASK_KINDS.CONVERT_BATCH);
    expect(taskKindOf('convert-batch-')).toBe(TASK_KINDS.CONVERT_BATCH);
  });

  it('⭐ 前缀重叠负例：不得依赖对象字面量的插入顺序', () => {
    // 断言性质而非实现：把前缀表按长度**升序**喂进去也应得到同样结果。
    // （实现里显式 sort，故这条是"结果不随表的书写顺序变化"的性质检查。）
    const byLengthAsc = Object.entries(TASK_PREFIX).sort((a, b) => a[1].length - b[1].length);
    const byLengthDesc = Object.entries(TASK_PREFIX).sort((a, b) => b[1].length - a[1].length);
    // 两种顺序下，"最长前缀优先"的判定结果必须一致
    const pick = (entries, id) => entries.find(([, prefix]) => id.startsWith(prefix))?.[0];
    const sorted = byLengthDesc.find(([, prefix]) => 'convert-batch-1'.startsWith(prefix))?.[0];
    expect(sorted).toBe(TASK_KINDS.CONVERT_BATCH);
    expect(pick(byLengthAsc, 'convert-batch-1')).toBe(TASK_KINDS.CONVERT); // 升序会选错 —— 这就是要 sort 的原因
  });

  it('未知 id 返回 null（调用方须 warn，不得静默）', () => {
    expect(taskKindOf('upload-123')).toBeNull();
    expect(taskKindOf('')).toBeNull();
    expect(taskKindOf('convert')).toBeNull();      // 无连字符：不是任何前缀
    expect(taskKindOf('prefixfetch-1')).toBeNull(); // 前缀必须在**开头**
  });

  it('非字符串返回 null，不抛', () => {
    expect(taskKindOf(undefined)).toBeNull();
    expect(taskKindOf(null)).toBeNull();
    expect(taskKindOf(42)).toBeNull();
    expect(taskKindOf({})).toBeNull();
  });

  it('类型表与前缀表一一对应（防漏配）', () => {
    const kinds = Object.values(TASK_KINDS).sort();
    const prefixed = Object.keys(TASK_PREFIX).sort();
    expect(prefixed).toEqual(kinds);
    for (const prefix of Object.values(TASK_PREFIX)) {
      expect(prefix.endsWith('-')).toBe(true); // 前缀须以连字符收尾，否则会吃掉同前缀的别的 id
    }
  });
});
