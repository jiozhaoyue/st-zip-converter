import * as zip from '../vendor/zip.js';
import { convert } from './transform.js';
import { generatePlan } from './plan-preview.js';
import { zipIo } from './zip-io.js';

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
 * 启动异步转换任务（优先 Web Worker 多线程，单测或受限环境自动主线程降级）
 * @param {object} params
 * @param {Blob|File|string} params.source
 * @param {string} params.target
 * @param {object} [params.options]
 * @param {function} [params.onProgress]
 * @returns {Promise<{ report: object, resultBlob?: Blob, targetPath?: string }>}
 */
export async function runConversionTask({ source, target, options = {}, onProgress }) {
  // 如果在 Node/Vitest 或没有 Worker 环境，或者传入的是路径字符串，执行同构主线程降级
  if (!supportsWebWorker() || typeof source === 'string') {
    const isBlob = typeof source !== 'string';
    const destination = isBlob ? new zip.BlobWriter('application/zip') : options.targetPath;
    const excludedSet = Array.isArray(options.excludedPaths)
      ? new Set(options.excludedPaths)
      : (options.excludedPaths || new Set());

    const reportInstance = await convert(source, destination, {
      ...options,
      excludedPaths: excludedSet,
      target,
      io: zipIo,
      onProgress,
    });
    const resultBlob = isBlob ? await destination.getData() : null;
    return {
      report: typeof reportInstance.toJSON === 'function' ? reportInstance.toJSON() : reportInstance,
      resultBlob,
      targetPath: isBlob ? null : destination,
    };
  }

  // 浏览器多线程环境
  const worker = getWorker();
  const id = ++messageIdCounter;

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

      if (data.type === 'PROGRESS') {
        if (typeof onProgress === 'function') {
          onProgress(data.current, data.total, data.filename);
        }
      } else if (data.type === 'DONE') {
        worker.removeEventListener('message', handler);
        resolve({
          report: data.report,
          resultBlob: data.resultBlob,
        });
      } else if (data.type === 'ERROR') {
        worker.removeEventListener('message', handler);
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
