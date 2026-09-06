import * as zip from '../vendor/zip.js';
import { Decompress } from '../vendor/fzstd.js';
import { logger } from './logger.js';

/**
 * 通用标准 zip IO 适配器 (基于自包含 zip.js + fzstd)
 * 支持纯浏览器 Blob/File，同时兼顾 Node 测试环境中的文件路径读写。
 * 原生注册 Method 93 (Zstandard / 7-Zip ZS / TauriTavern) 解码器。
 *
 * 写入管线（并发版）：
 * - 移除旧串行队列（queue.then 链），改为并发滑动窗口直接调用 vendor ZipWriter.add
 *   （vendor add 内部自带互斥与顺序保证，实测并发 50 条目字节级一致）；
 * - addLazy 流式直通保持零拷贝，压缩由 vendor 内部原生 CompressionStream /
 *   Web Worker 完成（浏览器中不占主线程）；
 * - waitForSlot 背压控制在飞条目数；close 时收齐全部在飞写入；
 * - Node 测试环境无 Worker 时 vendor 自动退化主线程，正确性等价。
 */

const CONCURRENCY = Math.max(2, Math.min(8, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 6));
// 262144: zip.js 默认 65536 偏小，大文件流式循环次数过多
const CHUNK_SIZE = 262144;

zip.configure({
  useWebWorkers: true,
  chunkSize: CHUNK_SIZE,
});

// 注册 Method 93 (Zstandard) 解码器
class ZstdDecompressionStream extends TransformStream {
  constructor() {
    let decompressor;
    super({
      start(controller) {
        decompressor = new Decompress((chunk) => {
          controller.enqueue(chunk);
        });
      },
      transform(chunk) {
        decompressor.push(chunk, false);
      },
      flush() {
        decompressor.push(new Uint8Array(0), true);
      },
    });
  }
}

try {
  zip.registerCodec({
    compressionMethod: 93,
    format: 'zstd',
    DecompressionStream: ZstdDecompressionStream,
  });
} catch {
  // 忽略重复注册
}

export const zipIo = {
  /**
   * 打开 ZipReader 读取器
   * @param {Blob|File|string} source
   */
  async openReader(source) {
    let blobSource = source;
    if (typeof source === 'string') {
      const fs = await import('node:fs/promises');
      const buffer = await fs.readFile(source);
      blobSource = new Blob([buffer], { type: 'application/zip' });
    }

    const blobReader = blobSource instanceof zip.BlobReader ? blobSource : new zip.BlobReader(blobSource);
    const reader = new zip.ZipReader(blobReader);
    const rawEntries = await reader.getEntries();

    const fileEntries = rawEntries.filter((e) => !e.directory);
    const zstdCount = fileEntries.filter((e) => e.compressionMethod === 93).length;
    if (zstdCount > 0) {
      logger.info(`检测到 ${zstdCount} 个 7-Zip ZS / TauriTavern Zstandard (Method 93) 压缩文件条目，已激活透明解压`);
    }

    return {
      totalEntries: fileEntries.length,
      async *entries() {
        for (const entry of rawEntries) {
          if (entry.directory) continue;
          yield {
            fileName: entry.filename,
            uncompressedSize: entry.uncompressedSize,
            lastModified: entry.lastModDate ?? null,
            crc32: entry.crc32 ?? null,
            compressionMethod: entry.compressionMethod,
            isDirectory: false,
            openStream: async () => {
              const { readable, writable } = new TransformStream({}, { highWaterMark: 16 });
              entry.getData(writable).catch((err) => readable.cancel(err));
              return readable;
            },
            read: async () => {
              return await entry.getData(new zip.Uint8ArrayWriter());
            },
            skip: () => {},
          };
        }
      },
      async close() {
        await reader.close();
      },
    };
  },

  /**
   * 创建 ZipWriter 写入器（并发滑动窗口版）
   * @param {zip.BlobWriter|string} [destination]
   * @param {object} [options]
   * @param {number} [options.level=5] 压缩等级 0(Store)-9(Max)
   */
  async createWriter(destination = new zip.BlobWriter('application/zip'), { level = 5 } = {}) {
    const isFilePath = typeof destination === 'string';
    const writerTarget = isFilePath ? new zip.Uint8ArrayWriter() : destination;
    const writer = new zip.ZipWriter(writerTarget, { level, bufferedWrite: true });
    const written = new Set();
    const inflight = new Set();
    let firstEntryDone = false;

    function track(promise) {
      const wrapped = promise.finally(() => inflight.delete(wrapped));
      inflight.add(wrapped);
      return wrapped;
    }

    /**
     * 并发背压：在飞条目数达到并发上限时等待任一完成
     */
    async function waitForSlot() {
      while (inflight.size >= CONCURRENCY) {
        await Promise.race(inflight);
      }
    }

    return {
      /**
       * 添加内存条目（并发窗口内直接交给 vendor 压缩写入）
       */
      async add(name, data) {
        if (written.has(name)) return;
        written.add(name);
        if (!firstEntryDone) {
          // 首条目（通常为 manifest.json / 顺序敏感条目）先落盘再放开并发，
          // 保证中央目录首条顺序与恢复端 manifest 处理兼容
          await track(writer.add(name, new zip.Uint8ArrayReader(new Uint8Array(data))));
          firstEntryDone = true;
          return;
        }
        await waitForSlot();
        return track(writer.add(name, new zip.Uint8ArrayReader(new Uint8Array(data))));
      },

      /**
       * 流式直通条目（pass-through 大文件零拷贝）
       */
      addLazy(name, openFn) {
        if (written.has(name)) return Promise.resolve();
        written.add(name);
        const task = (async () => {
          if (!firstEntryDone) {
            // 首条目独占写入（同 add 的保序语义）
            const { readable, writable } = new TransformStream({}, { highWaterMark: 16 });
            const addPromise = writer.add(name, readable);
            openFn((err, source) => {
              if (err) {
                writable.abort(err);
                return;
              }
              source.pipeTo(writable).catch((err) => writable.abort(err));
            });
            await addPromise;
            firstEntryDone = true;
            return;
          }
          await waitForSlot();
          const { readable, writable } = new TransformStream({}, { highWaterMark: 16 });
          const addPromise = writer.add(name, readable);
          openFn((err, source) => {
            if (err) {
              writable.abort(err);
              return;
            }
            source.pipeTo(writable).catch((err) => writable.abort(err));
          });
          await addPromise;
        })();
        return track(task);
      },

      /**
       * 背压等待：全部在飞条目落盘（供上层在内存峰值敏感处调用）
       */
      waitForRoom: async () => {
        while (inflight.size > 0) {
          await Promise.race(inflight);
        }
      },

      async close() {
        // 收齐全部在飞写入再关闭，保证中央目录完整
        await Promise.allSettled([...inflight]);
        const result = await writer.close();
        if (isFilePath) {
          const fs = await import('node:fs/promises');
          await fs.writeFile(destination, result);
          return destination;
        }
        return destination;
      },

      async abort() {
        await Promise.allSettled([...inflight].map((p) => p.catch(() => {})));
      },
    };
  },
};
