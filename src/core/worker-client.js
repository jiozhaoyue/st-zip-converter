import * as zip from '../vendor/zip.js';
import { convert } from './transform.js';
import { generatePlan } from './plan-preview.js';
import { zipIo, readZipEntryManifest } from './zip-io.js';
import { logger } from './logger.js';

/**
 * 协作式暂停的**有界等待**上限（`L1-MR-7`）。
 *
 * 暂停不再立即 `terminate()`，而是先请 worker 把已写部分收尾成合法半成品再回报。
 * 但它**必须有界**：worker 卡住/收尾过慢时，超时即回落为「硬终止 + 无半成品」——
 * 调用方据此把续传降级成「完整重做」（正确），而不是无限等下去。
 * 兜底不是防御性编程，它是**正确性的一部分**：少了它就会出现「既等不到半成品、又不终止」的挂死。
 */
const PAUSE_FINALIZE_TIMEOUT_MS = 30000;

let workerInstance = null;
let messageIdCounter = 0;

function supportsWebWorker() {
  return typeof window !== 'undefined' && typeof Worker !== 'undefined';
}

function getWorker() {
  if (!workerInstance && supportsWebWorker()) {
    workerInstance = new Worker(new URL('./converter-worker.js', import.meta.url), {
      type: 'module',
    });
  }
  return workerInstance;
}

/**
 * 启动异步完全扫描规划任务（支持 Web Worker）
 * @param {object} params
 * @param {Blob|File|string} params.source
 * @param {string} params.target
 * @param {object} [params.options]
 * @returns {Promise<object>}
 */
export async function runPlanTask({ source, target, options = {} }) {
  // 如果在 Node/Vitest 或没有 Worker 环境，执行主线程降级
  if (!supportsWebWorker() || typeof source === 'string') {
    const excludedSet = Array.isArray(options.excludedPaths)
      ? new Set(options.excludedPaths)
      : (options.excludedPaths || new Set());

    return generatePlan(source, target, {
      ...options,
      excludedPaths: excludedSet,
      io: zipIo,
    });
  }

  const worker = getWorker();
  const id = ++messageIdCounter;

  // 确保 options.excludedPaths 可通过 postMessage 序列化
  const serializedOptions = {
    ...options,
    excludedPaths: options.excludedPaths instanceof Set
      ? Array.from(options.excludedPaths)
      : options.excludedPaths,
  };

  return new Promise((resolve, reject) => {
    const handler = (e) => {
      const data = e.data;
      if (!data || data.id !== id) return;

      if (data.type === 'PLAN_DONE') {
        worker.removeEventListener('message', handler);
        resolve(data.plan);
      } else if (data.type === 'ERROR') {
        worker.removeEventListener('message', handler);
        reject(new Error(data.error));
      }
    };

    worker.addEventListener('message', handler);
    worker.postMessage({
      type: 'PLAN',
      id,
      sourceBlob: source,
      target,
      options: serializedOptions,
    });
  });
}

/**
 * 把中止时的半成品交给调用方（**持久化由调用方负责**：Browser 写 OPFS、Node 侧本就在磁盘上）。
 *
 * 失败**绝不上抛**：没有半成品只是「续传会重做整包」（正确的降级），绝不能因此改变暂停语义。
 * @param {object} p
 * @param {function} [p.onPaused]
 * @param {boolean} p.isBlob 产物是否在内存（BlobWriter）还是已写到 p.destination 路径
 * @param {any} p.destination
 */
async function deliverPartial({ onPaused, isBlob, destination }) {
  if (typeof onPaused !== 'function') return;
  try {
    const partialBlob = isBlob ? await destination.getData() : null;
    const manifest = partialBlob ? await readZipEntryManifest(partialBlob) : null;
    await onPaused({ partialBlob, manifest });
  } catch (err) {
    logger.warn('[worker-client] 半成品交付失败（续传将重做整包）:', err);
  }
}

/**
 * 启动异步转换任务（优先 Web Worker 多线程，单测或受限环境自动主线程降级）
 * @param {object} params
 * @param {Blob|File|string} params.source
 * @param {string} params.target
 * @param {object} [params.options]
 * @param {AbortSignal} [params.options.signal] 中止信号（Worker 路径转成协作式暂停消息，主线程路径透传 convert）
 * @param {boolean} [params.options.finalizeOnAbort] 中止时把已写部分收成一个**合法半成品**并交给 `onPaused`
 * @param {Map<string,number>|Object<string,number>} [params.options.resumeCrcMap] 断点续传**台账**
 *   （不再是跳过的充分条件：跳过还要求条目**来自半成品**，见 `transform.js` 的跳过分支）
 * @param {function} [params.onProgress] (current, total, filename, crc32)
 * @param {function} [params.onEntryDone] (源条目名, crc32)——主线程路径直通；Worker 路径由 onProgress 累积
 * @param {function} [params.onPaused] 中止且拿到半成品时回调 `({partialBlob, manifest})`；
 *   **在 reject 之前 await** ⇒ 用户刚暂停就立刻点继续时，半成品已落盘
 * @returns {Promise<{ report: object, resultBlob?: Blob, targetPath?: string }>}
 */
export async function runConversionTask({ source, target, options = {}, onProgress, onEntryDone, onPaused }) {
  // 如果在 Node/Vitest 或没有 Worker 环境，或者传入的是路径字符串，执行同构主线程降级
  if (!supportsWebWorker() || typeof source === 'string') {
    const isBlob = typeof source !== 'string';
    const destination = isBlob ? new zip.BlobWriter('application/zip') : options.targetPath;
    const excludedSet = Array.isArray(options.excludedPaths)
      ? new Set(options.excludedPaths)
      : (options.excludedPaths || new Set());

    try {
      const reportInstance = await convert(source, destination, {
        ...options,
        excludedPaths: excludedSet,
        target,
        io: zipIo,
        onProgress,
        onEntryDone,
      });
      const resultBlob = isBlob ? await destination.getData() : null;
      return {
        report: typeof reportInstance.toJSON === 'function' ? reportInstance.toJSON() : reportInstance,
        resultBlob,
        targetPath: isBlob ? null : destination,
      };
    } catch (err) {
      // 与 Worker 路径**逐字节同构**：中止且开了 finalizeOnAbort ⇒ 交出半成品再上抛 AbortError
      if (err?.name === 'AbortError' && options.finalizeOnAbort) {
        await deliverPartial({ onPaused, isBlob, destination });
      }
      throw err;
    }
  }

  // 浏览器多线程环境：中止走**协作式收尾**（见 PAUSE_FINALIZE_TIMEOUT_MS 的说明），
  // 不再一上来就 terminate() 丢掉半成品。
  const worker = getWorker();
  const id = ++messageIdCounter;
  const finalizeOnAbort = options.finalizeOnAbort === true;

  const serializedOptions = {
    ...options,
    excludedPaths: options.excludedPaths instanceof Set
      ? Array.from(options.excludedPaths)
      : options.excludedPaths,
    resumeCrcMap: options.resumeCrcMap instanceof Map
      ? Object.fromEntries(options.resumeCrcMap)
      : (options.resumeCrcMap ?? undefined),
  };
  delete serializedOptions.signal; // AbortSignal 不可 postMessage ⇒ 改送 PAUSE 消息，由 worker 自持信号

  // 主线程累积断点清单（PROGRESS 消息带 crc32；节流落盘由调用方 onCheckpoint 完成）
  const doneEntries = new Map();

  return new Promise((resolve, reject) => {
    let settled = false;
    let pauseTimer = null;
    /** 收到 worker 的 PAUSED 时用它交付半成品；超时兜底会把它清掉 */
    let pauseResolver = null;

    const cleanup = () => {
      if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
      worker.removeEventListener('message', handler);
      options.signal?.removeEventListener?.('abort', onAbort);
    };

    /**
     * 中止收尾的唯一出口。`partial` 为 null 表示「没有半成品」⇒ 调用方把续传降级为完整重做。
     * terminate 一律执行（有半成品也执行）：绝不把死 worker 留在池子里（`L1-MR-8`）。
     */
    const finishAborted = async (partial) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { worker.terminate(); } catch { /* 已终止 */ }
      // terminate 后该实例不可再用；置空让下一次任务重建，
      // 否则暂停过一次后所有后续任务都向死 worker postMessage 而永久挂起
      workerInstance = null;
      if (partial && typeof onPaused === 'function') {
        try {
          await onPaused(partial);
        } catch (err) {
          logger.warn('[worker-client] 半成品交付失败（续传将重做整包）:', err);
        }
      }
      reject(new DOMException('转换任务已被中止/暂停', 'AbortError'));
    };

    const onAbort = () => {
      if (settled) return;
      if (!finalizeOnAbort) {
        // 不需要半成品（旧语义）⇒ 直接收尾，行为与改动前一致
        void finishAborted(null);
        return;
      }
      // 有界等待：worker 收尾过慢/卡住 ⇒ 回落为「硬终止 + 无半成品」
      pauseTimer = setTimeout(() => { pauseTimer = null; void finishAborted(null); }, PAUSE_FINALIZE_TIMEOUT_MS);
      pauseResolver = finishAborted;
      try {
        worker.postMessage({ type: 'PAUSE', id });
      } catch {
        void finishAborted(null);
      }
    };
    options.signal?.addEventListener?.('abort', onAbort);

    const handler = (e) => {
      const data = e.data;
      if (!data || data.id !== id) return;

      if (data.type === 'PROGRESS') {
        if (data.crc32 != null) doneEntries.set(data.filename, data.crc32);
        if (typeof onProgress === 'function') {
          onProgress(data.current, data.total, data.filename, data.crc32);
        }
      } else if (data.type === 'PAUSED') {
        const resolvePause = pauseResolver;
        pauseResolver = null;
        if (resolvePause) {
          void resolvePause({
            partialBlob: data.partialBlob ?? null,
            manifest: data.manifest ?? null,
            // 半成品不可用时 worker 回报的原因（不吞错：主线程据此可诊断，而不是只看到「没有」）
            partialError: data.partialError ?? null,
          });
        }
      } else if (data.type === 'DONE') {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          report: data.report,
          resultBlob: data.resultBlob,
          doneEntries,
        });
      } else if (data.type === 'ERROR') {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(data.error));
      }
    };

    worker.addEventListener('message', handler);
    worker.postMessage({
      type: 'CONVERT',
      id,
      sourceBlob: source,
      target,
      options: serializedOptions,
    });
  });
}
