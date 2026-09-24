/**
 * 有界 fetch 封装（超时 + AbortSignal 兜底）
 *
 * 存在原因（L1-MR-7 / 审计 R-01·R-02·R-05）：恢复链路的全部网络 `await` 此前**没有超时、
 * 没有 AbortSignal、没有 destroy 兜底**。宿主或网络一旦挂起，promise 永久 pending，
 * UI 也没有取消入口——用户唯一能做的只有刷新页面。
 *
 * 本模块把「超时」与「外部取消」合流到同一个内部 `AbortController`，并保证：
 * - 两者任一触发都能让 `fetch` settle（不会永久 pending）；
 * - 定时器在 `finally` 中强制清理（否则 Node/Vitest 下进程会被挂住）；
 * - 超时与用户主动取消**抛不同类型**，让 UI 能给出不同文案。
 *
 * 分层：本模块属 `src/ui/`（Web API 允许），`src/core/` 不得导入它。
 */

/** 超时错误（与用户主动取消的 `AbortError` 区分，便于 UI 给出不同文案）。 */
export class TimeoutError extends Error {
  /**
   * @param {string} message
   * @param {{ label?: string, timeoutMs?: number }} [info]
   */
  constructor(message, { label = '', timeoutMs = 0 } = {}) {
    super(message);
    this.name = 'TimeoutError';
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/** 短请求（凭证 / 用户信息）超时：10 秒。 */
export const SHORT_FETCH_TIMEOUT_MS = 10_000;

/** 一般请求默认超时：2 分钟。长上传请显式传 `timeoutMs: 0` 由 signal 兜底。 */
export const DEFAULT_FETCH_TIMEOUT_MS = 120_000;

/**
 * 带超时与外部 signal 兜底的 fetch。
 *
 * `timeoutMs <= 0` 表示不设超时（仅靠 `signal` 兜底）——用于大包上传这类
 * 耗时本就可能超过任何固定阈值的请求。
 * @param {string} url 请求地址
 * @param {RequestInit} [init={}] 原生 fetch 参数
 * @param {object} [opts={}]
 * @param {number} [opts.timeoutMs=DEFAULT_FETCH_TIMEOUT_MS] 超时毫秒；`<= 0` 表示不超时
 * @param {AbortSignal} [opts.signal] 外部取消信号
 * @param {string} [opts.label=''] 出错信息中的操作名（如「获取 CSRF token」）
 * @returns {Promise<Response>}
 * @throws {TimeoutError} 超时
 * @throws {Error} 外部 signal 触发的中止（其 `name` 为 `AbortError`）
 */
export async function fetchWithTimeout(url, init = {}, opts = {}) {
  const {
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    signal: externalSignal,
    label = '',
  } = opts;

  // 外部已取消：立即抛错，不发起请求
  if (externalSignal?.aborted) {
    throw makeAbortError(label);
  }

  const controller = new AbortController();
  let timer = null;
  let timedOut = false;

  // 超时与外部 signal 合流：任一触发都 abort 内部 controller
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    // AbortError 来源二选一：超时 or 外部取消——必须区分，否则 UI 无法给出正确提示
    if (timedOut) {
      throw new TimeoutError(
        `${label || '请求'}超时（${Math.round(timeoutMs / 1000)} 秒无响应）`,
        { label, timeoutMs },
      );
    }
    if (externalSignal?.aborted) {
      // 保持 AbortError 语义，供上层识别「用户主动取消」
      throw makeAbortError(label);
    }
    throw err;
  } finally {
    // 必须清理：否则 Vitest 进程会因挂起的定时器无法退出
    if (timer !== null) clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * 构造语义明确的 AbortError。
 * 不直接 `new DOMException(...)`——Node 与浏览器对 `DOMException` 的构造签名支持不一，
 * 且上层只依赖 `name` 判别。
 * @param {string} label
 * @returns {Error}
 */
function makeAbortError(label) {
  const err = new Error(`${label || '请求'}已取消`);
  err.name = 'AbortError';
  return err;
}
