/**
 * R-19 · `restoreCapability` 只读调试探针单测。
 *
 * 背景：三态（`unknown` / `available` / `unsupported`）此前是模块级 `let`、**无任何出口**
 * ⇒ Playwright 断言不了真正的三态，E2E 只能验非破坏性的可见性契约。
 *
 * 四条断言对应 `design.md` D3.2 的三条硬约束 + D3.3 的测试表：
 *   ① 初始态 `unknown`（未探测）
 *   ② 探测失败后为 `unsupported` 且 `unsupportedReason` 非空
 *   ③ 返回对象**冻结**（只读 —— 否则 E2E 能伪造状态、断言失去判别力）
 *   ④ 全局**已占用时不覆盖**且发 warn（宿主或别的扩展可能同名）
 *
 * 三态迁移的驱动法沿用 `test/restore-chain.test.js` 的成熟做法：
 * `vi.resetModules()` 拿全新的模块状态 + `endpointFetch` 替身控制端点状态码。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const realFetch = globalThis.fetch;
const DEBUG_KEY = '__stZipConverterDebug';

/** 按端点返回状态码的 fetch 替身（未登记的端点一律 404）；凭证端点单独给正常响应 */
function endpointFetch(statusByEndpoint) {
  return vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('csrf-token')) return { ok: true, status: 200, json: async () => ({ token: 't' }) };
    if (u.includes('/api/users/me')) return { ok: true, status: 200, json: async () => ({ handle: 'default-user' }) };
    const status = statusByEndpoint[u] ?? 404;
    return { ok: status >= 200 && status < 300, status, json: async () => ({ success: true }) };
  });
}

/** 单测环境无 DOM：给一个最小的 `window` 承载调试挂载 */
function stubWindow() {
  const w = {};
  globalThis.window = w;
  return w;
}

describe('R-19 · getRestoreProbe 只读出口', () => {
  let savedWindow;

  beforeEach(() => {
    savedWindow = globalThis.window;
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedWindow === undefined) delete globalThis.window;
    else globalThis.window = savedWindow;
    vi.restoreAllMocks();
  });

  it('① 初始态：未探测时为 unknown，且原因为空串', async () => {
    const { getRestoreProbe } = await import('../src/ui/host-bridge.js');
    expect(getRestoreProbe()).toEqual({ capability: 'unknown', unsupportedReason: '' });
  });

  it('② 探测后：全部候选 404 ⇒ unsupported 且 unsupportedReason 非空', async () => {
    globalThis.fetch = endpointFetch({}); // 全 404
    const { restoreToHost, getRestoreProbe } = await import('../src/ui/host-bridge.js');

    await expect(
      restoreToHost(new Blob(['x']), { mode: 'merge', platform: 'st' }),
    ).rejects.toMatchObject({ code: 'RESTORE_UNSUPPORTED' });

    const probe = getRestoreProbe();
    expect(probe.capability).toBe('unsupported');
    expect(probe.unsupportedReason.length).toBeGreaterThan(0);
    // 原因文案含「端点 → 状态码」，两项都是源码里的静态常量 ⇒ 不构成泄漏（§2.3）
    expect(probe.unsupportedReason).toMatch(/\/api\/users\/restore.*404/);
  });

  it('③ 只读：返回对象冻结，改不动（E2E 无法伪造状态）', async () => {
    const { getRestoreProbe } = await import('../src/ui/host-bridge.js');
    const probe = getRestoreProbe();

    expect(Object.isFrozen(probe)).toBe(true);
    // 严格模式下写冻结对象会抛 TypeError；非严格模式静默失败 —— 两种都算「改不动」
    expect(() => { probe.capability = 'available'; }).toThrow(TypeError);
    expect(getRestoreProbe().capability).toBe('unknown');
  });

  it('③b 只读：两次调用返回**不同**的快照对象（不是共享可变引用）', async () => {
    const { getRestoreProbe } = await import('../src/ui/host-bridge.js');
    expect(getRestoreProbe()).not.toBe(getRestoreProbe());
  });

  it('④ 挂载：成功挂到 window，命名空间本身冻结', async () => {
    const w = stubWindow();
    const { mountDebugProbe } = await import('../index.js');

    mountDebugProbe();

    expect(Object.prototype.hasOwnProperty.call(w, DEBUG_KEY)).toBe(true);
    expect(Object.isFrozen(w[DEBUG_KEY])).toBe(true);
    expect(typeof w[DEBUG_KEY].getRestoreProbe).toBe('function');
  });

  it('④b 挂载：已被占用时**不覆盖**且发 warn', async () => {
    const w = stubWindow();
    const sentinel = { mine: true };
    w[DEBUG_KEY] = sentinel;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { mountDebugProbe } = await import('../index.js');

    mountDebugProbe();

    // 不覆盖：仍是原来那个对象（静默覆盖会悄悄弄坏别人的对象）
    expect(w[DEBUG_KEY]).toBe(sentinel);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('④c 挂载：无 window（Node/Worker 环境）时静默跳过，不抛', async () => {
    delete globalThis.window;
    const { mountDebugProbe } = await import('../index.js');
    expect(() => mountDebugProbe()).not.toThrow();
  });
});
