import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { confirmDialog } from '../src/ui/host-bridge.js';

/**
 * confirmDialog 适配器测试（R5.3 / L0-11）。
 *
 * 契约：
 * - 宿主提供 `SillyTavern.getContext().Popup.show.confirm`（官方文档 API）时走原生弹窗，
 *   返回值与 `POPUP_RESULT.AFFIRMATIVE` 比对；
 * - 宿主不可用 / 缺 POPUP_RESULT / 调用抛错，一律**静默降级**为 `window.confirm`；
 * - 两者都不可用（纯 Node）时不阻断调用方。
 */

const g = globalThis;

function setGlobal(key, value) {
  if (value === undefined) delete g[key];
  else g[key] = value;
}

/** 构造一个宿主上下文：Popup.show.confirm 返回值由 result 决定 */
function hostWithConfirm(result, { omitPopupResult = false, throws = false } = {}) {
  return {
    getContext: () => {
      const ctx = {
        Popup: {
          show: {
            confirm: async () => {
              if (throws) throw new Error('host popup unavailable');
              return result;
            },
          },
        },
      };
      if (!omitPopupResult) ctx.POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0 };
      return ctx;
    },
  };
}

describe('confirmDialog 宿主原生确认适配器', () => {
  beforeEach(() => {
    setGlobal('SillyTavern', undefined);
    g.window = { confirm: undefined };
  });

  afterEach(() => {
    setGlobal('SillyTavern', undefined);
    delete g.window;
  });

  it('宿主可用时走原生弹窗，AFFIRMATIVE 解析为 true', async () => {
    const calls = [];
    setGlobal('SillyTavern', {
      getContext: () => ({
        Popup: {
          show: {
            confirm: async (header, text) => {
              calls.push([header, text]);
              return 1;
            },
          },
        },
        POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0 },
      }),
    });

    await expect(confirmDialog('确定删除吗？')).resolves.toBe(true);
    // 参数序按官方文档 Popup.show.confirm(header, text)
    expect(calls).toEqual([['数据包互转', '确定删除吗？']]);
  });

  it('原生弹窗返回非 AFFIRMATIVE（含 null = 直接关闭）视为取消', async () => {
    setGlobal('SillyTavern', hostWithConfirm(0));
    await expect(confirmDialog('x')).resolves.toBe(false);

    setGlobal('SillyTavern', hostWithConfirm(null));
    await expect(confirmDialog('x')).resolves.toBe(false);
  });

  it('宿主不可用时降级为 window.confirm，并把原文案透传', async () => {
    let asked = null;
    g.window = { confirm: (msg) => { asked = msg; return true; } };

    await expect(confirmDialog('降级确认')).resolves.toBe(true);
    expect(asked).toBe('降级确认');
  });

  it('原生弹窗抛错时静默降级，不把异常抛给调用方', async () => {
    setGlobal('SillyTavern', hostWithConfirm(1, { throws: true }));
    g.window = { confirm: () => false };

    await expect(confirmDialog('x')).resolves.toBe(false);
  });

  it('宿主未暴露 POPUP_RESULT 时不猜常量值，直接降级', async () => {
    let hostUsed = false;
    setGlobal('SillyTavern', {
      getContext: () => ({
        Popup: { show: { confirm: async () => { hostUsed = true; return 1; } } },
      }),
    });
    g.window = { confirm: () => true };

    await expect(confirmDialog('x')).resolves.toBe(true);
    expect(hostUsed).toBe(false);
  });

  it('宿主与 window 均不可用时不阻断调用方（纯 Node 路径）', async () => {
    delete g.window;
    await expect(confirmDialog('x')).resolves.toBe(true);
  });

  it('宿主 getContext 抛错（脚本未就绪）时静默降级', async () => {
    setGlobal('SillyTavern', {
      getContext: () => { throw new Error('not ready'); },
    });
    let asked = null;
    g.window = { confirm: (msg) => { asked = msg; return false; } };

    await expect(confirmDialog('未就绪')).resolves.toBe(false);
    expect(asked).toBe('未就绪');
  });
});
