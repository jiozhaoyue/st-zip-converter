import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { alertDialog } from '../src/ui/host-bridge.js';

/**
 * alertDialog 适配器测试（R5 / L0-11）。
 *
 * 契约（与 confirmDialog 同构，但宿主方法不同）：
 * - 宿主路径用 **`SillyTavern.getContext().Popup.show.text(header, text)`** ——
 *   官方文档（docs.sillytavern.app, Writing Extensions）只文档化 `confirm` / `input` / `text`，
 *   其中 `.text` 是"只显示一条信息"的那个；**没有 `alert`**。
 *   运行时交叉核对亦确认 `Popup.show` 的键恰为 `['confirm','input','text']`。
 *   故本测试**故意不提供** `show.alert`：若实现哪天改成调 `show.alert`，用例 1 会失败。
 * - 宿主不可用 / 调用抛错 → **静默降级**为 `window.alert`，文案原样透传；
 * - 两者都不可用（纯 Node）→ 静默 resolve，不阻断调用方。
 */

const g = globalThis;

function setGlobal(key, value) {
  if (value === undefined) delete g[key];
  else g[key] = value;
}

describe('alertDialog 宿主原生信息提示适配器', () => {
  beforeEach(() => {
    setGlobal('SillyTavern', undefined);
    g.window = { alert: undefined };
  });

  afterEach(() => {
    setGlobal('SillyTavern', undefined);
    delete g.window;
  });

  it('宿主可用时走 Popup.show.text，参数序为 (header, text)，且不再调 window.alert', async () => {
    const calls = [];
    let windowAlertCalled = false;
    setGlobal('SillyTavern', {
      getContext: () => ({
        Popup: {
          show: {
            text: async (header, text) => {
              calls.push([header, text]);
              return 1;
            },
          },
        },
      }),
    });
    g.window = { alert: () => { windowAlertCalled = true; } };

    await alertDialog('宿主未写入任何条目。\n请核对数据包内容。');
    expect(calls).toEqual([['数据包互转', '宿主未写入任何条目。\n请核对数据包内容。']]);
    expect(windowAlertCalled).toBe(false);
  });

  it('标题可覆盖（默认是插件功能名）', async () => {
    const calls = [];
    setGlobal('SillyTavern', {
      getContext: () => ({ Popup: { show: { text: async (header, text) => { calls.push([header, text]); } } } }),
    });

    await alertDialog('正文', '自定义标题');
    expect(calls).toEqual([['自定义标题', '正文']]);
  });

  it('宿主只有 confirm/input（无 text）时降级为 window.alert，并把原文案透传', async () => {
    let asked = null;
    setGlobal('SillyTavern', {
      getContext: () => ({
        Popup: { show: { confirm: async () => 1, input: async () => null } },
      }),
    });
    g.window = { alert: (msg) => { asked = msg; } };

    await alertDialog('降级提示');
    expect(asked).toBe('降级提示');
  });

  it('原生弹窗抛错时静默降级，不把异常抛给调用方', async () => {
    let asked = null;
    setGlobal('SillyTavern', {
      getContext: () => ({
        Popup: { show: { text: async () => { throw new Error('host popup unavailable'); } } },
      }),
    });
    g.window = { alert: (msg) => { asked = msg; } };

    await expect(alertDialog('抛错后降级')).resolves.toBeUndefined();
    expect(asked).toBe('抛错后降级');
  });

  it('宿主 getContext 抛错（脚本未就绪）时静默降级', async () => {
    let asked = null;
    setGlobal('SillyTavern', { getContext: () => { throw new Error('not ready'); } });
    g.window = { alert: (msg) => { asked = msg; } };

    await expect(alertDialog('未就绪')).resolves.toBeUndefined();
    expect(asked).toBe('未就绪');
  });

  it('宿主与 window 均不可用时不阻断调用方（纯 Node 路径）', async () => {
    delete g.window;
    await expect(alertDialog('纯 Node')).resolves.toBeUndefined();
  });
});
