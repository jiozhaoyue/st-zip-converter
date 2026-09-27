import { describe, expect, it } from 'vitest';
import { namedBlob } from '../src/core/filename-template.js';

/**
 * `namedBlob` —— 给 blob 一个可读的名字而**不改动原对象**。
 *
 * 事故（2026-09-27 实测，由 E2E 矩阵 M-10 抓到）：三处 `xxx.name = record.name`
 * 对 **`File`** 赋值 ⇒ `TypeError: Cannot set property name of #<File> which has only a getter`
 * （`File.name` 只读 + ES 模块恒严格模式）⇒ 批量转换**每个子项都失败、整批零产物**，
 * 暂存区「载入为源」与工作区状态恢复同样在运行期炸掉、且在 catch 里静默夭折。
 */

const file = (name = 'a.zip', bytes = [1, 2, 3]) =>
  new File([new Uint8Array(bytes)], name, { type: 'application/zip' });

describe('namedBlob：名字已对则**原样返回**（零拷贝、零行为变化）', () => {
  it('File 自带同名 ⇒ 返回**同一个对象**（身份相同）', () => {
    const f = file('same.zip');
    expect(namedBlob(f, 'same.zip')).toBe(f);
  });

  it('不传 name ⇒ 保留 blob 自带的名字', () => {
    const f = file('keep.zip');
    expect(namedBlob(f, undefined).name).toBe('keep.zip');
    expect(namedBlob(f, '').name).toBe('keep.zip');
  });

  it('null / undefined 原样透传（调用方无需分支）', () => {
    expect(namedBlob(null, 'x.zip')).toBe(null);
    expect(namedBlob(undefined, 'x.zip')).toBe(undefined);
  });
});

describe('namedBlob：名字不对时包一层（不复制数据、不抛错）', () => {
  it('纯 Blob（无 name）⇒ 得到带名字的 File', () => {
    const b = new Blob([new Uint8Array([9, 9])], { type: 'application/zip' });
    const named = namedBlob(b, 'from-host.zip');
    expect(named.name).toBe('from-host.zip');
    expect(named.type).toBe('application/zip');
    expect(named.size).toBe(2);
  });

  it('File 但名字与记录不符 ⇒ 换成记录里的名字', () => {
    const f = file('old.zip');
    const named = namedBlob(f, 'record-name.zip');
    expect(named.name).toBe('record-name.zip');
    expect(named).not.toBe(f);
    expect(named.size).toBe(f.size);
  });

  it('既无记录名又无自带名 ⇒ 兜底名字（不产出 undefined 名字）', () => {
    const b = new Blob([new Uint8Array([1])]);
    expect(namedBlob(b, undefined).name).toBe('datapack.zip');
  });
});

describe('判别力：把旧写法钉成反例（它**必须**抛）', () => {
  it('严格模式下对 File 赋值 name 抛 TypeError —— 这就是本 helper 存在的理由', () => {
    const f = file('ro.zip');
    // ES 模块恒为严格模式；若将来某运行时改成可写，本用例会转红并提醒我们重新评估
    expect(() => { f.name = 'other.zip'; }).toThrow(TypeError);
  });

  it('对照：helper 走的路径**不抛**，且结果为期望名字', () => {
    const f = file('ro.zip');
    expect(() => namedBlob(f, 'other.zip')).not.toThrow();
    expect(namedBlob(f, 'other.zip').name).toBe('other.zip');
  });
});
