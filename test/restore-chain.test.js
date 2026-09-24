import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SHORT_FETCH_TIMEOUT_MS, TimeoutError, fetchWithTimeout } from '../src/ui/fetch-bounds.js';

/**
 * 恢复链路有界等待与并发互斥单测（审计 R-01 / R-02 / R-05 / R-12 / R-15）。
 *
 * 需求见 `.trellis/tasks/09-24-perf-hardening-transfer-memory/design.md` §2 / §3。
 */

const realFetch = globalThis.fetch;

/** 构造 AbortError（与真实 fetch 被 abort 时的行为一致） */
function makeAbortError() {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * 挂起的 fetch 替身——**必须响应 init.signal**，否则与真实 fetch 语义不符：
 * 真实 fetch 在 signal abort 时会 reject(AbortError)，不响应的 mock 会让超时/取消
 * 的断言永远等不到 settle（测试自身挂死）。
 */
function hangingFetch() {
  return vi.fn((url, init = {}) => new Promise((_, reject) => {
    const signal = init.signal;
    if (!signal) return; // 无 signal：真挂起（用于考察「无兜底」的反例）
    if (signal.aborted) { reject(makeAbortError()); return; }
    signal.addEventListener('abort', () => reject(makeAbortError()), { once: true });
  }));
}

/** 返回指定响应体的 fetch 替身 */
function jsonFetch(body, { ok = true, status = 200 } = {}) {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  }));
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('fetchWithTimeout：有界等待', () => {
  it('fetch 挂起时按 timeoutMs 抛 TimeoutError（不再永久 pending）', async () => {
    globalThis.fetch = hangingFetch();
    await expect(
      fetchWithTimeout('/x', {}, { timeoutMs: 20, label: '测试请求' }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it('TimeoutError 携带 label 与 timeoutMs，便于 UI 给出准确文案', async () => {
    globalThis.fetch = hangingFetch();
    const err = await fetchWithTimeout('/x', {}, { timeoutMs: 20, label: '恢复数据包' })
      .catch((e) => e);
    expect(err.name).toBe('TimeoutError');
    expect(err.label).toBe('恢复数据包');
    expect(err.timeoutMs).toBe(20);
    expect(err.message).toContain('恢复数据包');
  });

  it('外部 signal 取消时抛 AbortError（与超时区分）', async () => {
    globalThis.fetch = hangingFetch();
    const controller = new AbortController();
    const p = fetchWithTimeout('/x', {}, { timeoutMs: 5000, signal: controller.signal, label: 'R' });
    controller.abort();
    const err = await p.catch((e) => e);
    expect(err.name).toBe('AbortError');
  });

  it('外部已取消时立即抛错，不发起请求', async () => {
    const spy = hangingFetch();
    globalThis.fetch = spy;
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchWithTimeout('/x', {}, { timeoutMs: 5000, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('timeoutMs <= 0 表示不设硬超时（仅靠 signal 兜底）——大包上传用', async () => {
    globalThis.fetch = jsonFetch({ success: true });
    await expect(
      fetchWithTimeout('/x', {}, { timeoutMs: 0 }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('正常响应时把 signal 传给 fetch 且不残留定时器', async () => {
    const spy = jsonFetch({ success: true });
    globalThis.fetch = spy;
    vi.useFakeTimers();
    await fetchWithTimeout('/x', {}, { timeoutMs: 10_000 });
    // 若未 clearTimeout，fake timers 下会残留一个待触发的 10s 定时器
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    expect(spy.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('SHORT_FETCH_TIMEOUT_MS 为短请求提供了有限阈值', () => {
    expect(SHORT_FETCH_TIMEOUT_MS).toBeGreaterThan(0);
    expect(SHORT_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

describe('restoreToHost：并发互斥（R-12）', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('在途时第二次调用被拒绝，且首次返回后标志复位', async () => {
    // 首请求挂起，使第一次调用停留在在途状态
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    let call = 0;
    globalThis.fetch = vi.fn(async (url) => {
      call += 1;
      if (call === 1) return { ok: true, status: 200, json: async () => ({ handle: 'u' }) };   // /csrf-token
      if (call === 2) return { ok: true, status: 200, json: async () => ({ handle: 'u' }) };   // /api/users/me
      await firstGate;                                                                         // restore 挂起
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });

    const { restoreToHost, isRestoreInFlight } = await import('../src/ui/host-bridge.js');
    expect(isRestoreInFlight()).toBe(false);

    const p = restoreToHost(new Blob(['x']), { mode: 'merge', platform: 'st' });
    // 让首请求推进到「在途」状态
    await new Promise((r) => setTimeout(r, 20));
    expect(isRestoreInFlight()).toBe(true);

    // 第二次调用必须被拒绝，而不是并发写同一用户目录
    await expect(
      restoreToHost(new Blob(['y']), { mode: 'merge', platform: 'st' }),
    ).rejects.toThrow(/已有恢复任务正在进行/);

    releaseFirst();
    await p;
    expect(isRestoreInFlight()).toBe(false);
  });

  it('首次调用失败后标志同样复位（finally 生效）', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('csrf-token')) return { ok: false, status: 403, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ handle: 'u' }) };
    });
    const { restoreToHost, isRestoreInFlight } = await import('../src/ui/host-bridge.js');
    await expect(restoreToHost(new Blob(['x']))).rejects.toThrow();
    expect(isRestoreInFlight()).toBe(false);
  });
});

describe('restoreToHost：修掉伪成功（R-15）', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('响应体不可解析时返回 unconfirmed，而不是 success: true', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('csrf-token')) {
        return { ok: true, status: 200, json: async () => ({ token: 't' }) };
      }
      if (String(url).includes('/api/users/me')) {
        return { ok: true, status: 200, json: async () => ({ handle: 'u' }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => { throw new SyntaxError('Unexpected token'); },
      };
    });

    const { restoreToHost } = await import('../src/ui/host-bridge.js');
    const result = await restoreToHost(new Blob(['x']), { mode: 'merge', platform: 'st' });
    expect(result.success).toBe(false);
    expect(result.unconfirmed).toBe(true);
    expect(result.reason).toBeTruthy();
  });
});
