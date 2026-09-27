import { describe, expect, it } from 'vitest';
import { filterStashFiles, stashBatchCapability } from '../src/ui/stash-list.js';

describe('filterStashFiles', () => {
  it('仅保留 upload 与 host-export 来源', () => {
    const files = [
      { id: '1', origin: 'upload' },
      { id: '2', origin: 'host-export' },
      { id: '3', origin: 'converted' },
      { id: '4', origin: 'delta' },
      { id: '5', origin: 'split-part' },
      { id: '6' }, // 无 origin 视为旧数据，不显示
    ];
    const out = filterStashFiles(files);
    expect(out.map((f) => f.id)).toEqual(['1', '2']);
  });

  it('空输入返回空数组', () => {
    expect(filterStashFiles([])).toEqual([]);
    expect(filterStashFiles(null)).toEqual([]);
  });
});

describe('stashBatchCapability', () => {
  it('未选中时全部不可用', () => {
    const cap = stashBatchCapability(new Set());
    expect(cap).toEqual({
      canLoad: false, canBatchConvert: false, canDownload: false, canRestore: false, canDelete: false,
    });
  });

  it('单选时允许载入为源', () => {
    const cap = stashBatchCapability(new Set(['a']));
    expect(cap.canLoad).toBe(true);
  });

  it('多选时禁止载入为源，允许下载/删除', () => {
    const cap = stashBatchCapability(new Set(['a', 'b']));
    expect(cap.canLoad).toBe(false);
    expect(cap.canDownload).toBe(true);
    expect(cap.canDelete).toBe(true);
  });

  it('批量转换：选中 ≥1 即可用（不复用 canLoad 的单选语义）', () => {
    // ⚠️ 回归守护：`canLoad` 是 n === 1 的**单选**语义，若批量转换误用它，
    // 选 2 个以上时按钮会被禁用 —— 而批量**恰恰只在多选时才有意义**
    expect(stashBatchCapability(new Set(['a'])).canBatchConvert).toBe(true);
    expect(stashBatchCapability(new Set(['a', 'b'])).canBatchConvert).toBe(true);
    expect(stashBatchCapability(new Set(['a', 'b', 'c'])).canBatchConvert).toBe(true);
    expect(stashBatchCapability(new Set()).canBatchConvert).toBe(false);
  });

  it('宿主不可用时禁止写回', () => {
    const cap = stashBatchCapability(new Set(['a']), false);
    expect(cap.canRestore).toBe(false);
    const cap2 = stashBatchCapability(new Set(['a']), true);
    expect(cap2.canRestore).toBe(true);
  });
});
