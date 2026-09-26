/**
 * `resolveTargetLayout` —— 目标选择器原始值 → 布局码的归一
 *
 * 本文件守护的是一处**已发生过的真实缺陷**（N-1，2026-09-26 由 E2E 功能矩阵 M-3 查出）：
 *
 * 目标下拉里的 `native` 表示「宿主原生格式」，必须经 `hostLayoutCode()` 归一；
 * 但修前只有宿主拉取路径与文件名预览做了归一，而 `refreshPlan` / `btnConvert` /
 * `runBatchConversion` / 扩展清单的 `targetLayout` 都把字符串 `'native'`
 * **直接交给计划器与转换器**。计划器的合成分支只认 `TARGETS.L` / `TARGETS.ST`
 * （`src/core/plan-preview.js`）⇒ `native` 不匹配任何分支，
 * 「宿主原生格式」退化成**原样直通**。
 *
 * 后果的不对称性正是它长期没被发现的原因：
 * 在 **ST 宿主**上（源本就是 ST 布局）直通**恰好等价**，用户看不出差别；
 * 在 **Luker 宿主上选「宿主原生格式」**就会拿到**未经布局转换**的结果。
 *
 * ⚠️ 因此本文件的**负例**（`native` + `luker` ⇒ 必须是 `l`，
 * 而**不是** `'native'` 本身）才是真正的判别力所在 —— 只测正例会让这个缺陷再次漏网。
 */

import { describe, expect, it } from 'vitest';
import { hostLayoutCode, resolveTargetLayout } from '../src/ui/host-bridge.js';

describe('resolveTargetLayout：native 归一', () => {
  it('native + ST 宿主 ⇒ st', () => {
    expect(resolveTargetLayout('native', 'st')).toBe('st');
  });

  it('native + Luker 宿主 ⇒ l（**N-1 的核心负例**：绝不可原样返回 "native"）', () => {
    const got = resolveTargetLayout('native', 'luker');
    expect(got).toBe('l');
    expect(got).not.toBe('native');
  });

  it('native + standalone ⇒ 原样透传（与 hostLayoutCode 语义一致）', () => {
    expect(resolveTargetLayout('native', 'standalone')).toBe('standalone');
  });

  it('platform 缺省时按 st 处理（与宿主拉取路径的 `|| \'st\'` 兜底一致）', () => {
    expect(resolveTargetLayout('native', undefined)).toBe('st');
    expect(resolveTargetLayout('native', '')).toBe('st');
  });

  it('归一结果与 hostLayoutCode 直接调用一致（不留第二套映射）', () => {
    for (const p of ['st', 'luker', 'standalone']) {
      expect(resolveTargetLayout('native', p)).toBe(hostLayoutCode(p));
    }
  });
});

describe('resolveTargetLayout：显式布局码原样通过', () => {
  it('四个布局码都不被改写', () => {
    for (const code of ['st', 'l', 'tt', 'pt']) {
      expect(resolveTargetLayout(code, 'luker')).toBe(code);
      expect(resolveTargetLayout(code, 'st')).toBe(code);
    }
  });

  it('显式布局码不受宿主影响（跨宿主指定目标是合法用法）', () => {
    expect(resolveTargetLayout('pt', 'luker')).toBe('pt');
    expect(resolveTargetLayout('tt', 'st')).toBe('tt');
  });
});

describe('resolveTargetLayout：空值与缺省', () => {
  it('空 / undefined / null / 纯空白 ⇒ 走 fallback', () => {
    for (const empty of ['', undefined, null, '   ']) {
      expect(resolveTargetLayout(empty, 'st')).toBe('l');       // 缺省 fallback
    }
  });

  it('fallback 可指定（调用处各自的缺省不同）', () => {
    expect(resolveTargetLayout('', 'st', 'pt')).toBe('pt');
    expect(resolveTargetLayout('', 'st', '')).toBe('');
  });

  it('空值**不**退化成宿主原生（空 ≠ native）—— 两者语义不同', () => {
    // 若把空值当 native 处理，Luker 上会得到 'l'；此处必须得到 fallback
    expect(resolveTargetLayout('', 'luker', 'pt')).toBe('pt');
  });

  it('前后空白被裁掉后再判定', () => {
    expect(resolveTargetLayout('  native  ', 'luker')).toBe('l');
    expect(resolveTargetLayout(' st ', 'luker')).toBe('st');
  });
});