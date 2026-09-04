import * as zip from '@zip.js/zip.js';
import { convert } from './transform.js';
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
    const reportInstance = await convert(source, destination, {
      ...options,
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
      options,
    });
  });
}
