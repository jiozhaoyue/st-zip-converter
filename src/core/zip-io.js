import * as zip from '../vendor/zip.js';
import { Decompress } from '../vendor/fzstd.js';
import { logger } from './logger.js';

/**
 * 通用标准 zip IO 适配器 (基于自包含 zip.js + fzstd)
 * 支持纯浏览器 Blob/File，同时兼顾 Node 测试环境中的文件路径读写。
 * 原生注册 Method 93 (Zstandard / 7-Zip ZS / TauriTavern) 解码器。
 */

zip.configure({ useWebWorkers: false });

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
              const { readable, writable } = new TransformStream({}, { highWaterMark: 1 });
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
   * 创建 ZipWriter 写入器
   * @param {zip.BlobWriter|string} [destination]
   * @param {object} [options]
   * @param {number} [options.level=5] 压缩等级 0(Store)-9(Max)
   */
  async createWriter(destination = new zip.BlobWriter('application/zip'), { level = 5 } = {}) {
    const isFilePath = typeof destination === 'string';
    const writerTarget = isFilePath ? new zip.Uint8ArrayWriter() : destination;
    const writer = new zip.ZipWriter(writerTarget, { level, bufferedWrite: true });
    let queue = Promise.resolve();
    const written = new Set();

    function enqueue(task) {
      const next = queue.then(task, task);
      queue = next;
      return next;
    }

    return {
      async add(name, data) {
        if (written.has(name)) return;
        written.add(name);
        return enqueue(async () => {
          await writer.add(name, new zip.Uint8ArrayReader(new Uint8Array(data)));
        });
      },
      addLazy(name, openFn) {
        if (written.has(name)) return;
        written.add(name);
        return enqueue(async () => {
          const { readable, writable } = new TransformStream({}, { highWaterMark: 1 });
          openFn((err, source) => {
            if (err) {
              writable.abort(err);
              return;
            }
            source.pipeTo(writable).catch((err) => writable.abort(err));
          });
          await writer.add(name, readable);
        });
      },
      waitForRoom: async () => {
        await queue;
      },
      async close() {
        await queue;
        const result = await writer.close();
        if (isFilePath) {
          const fs = await import('node:fs/promises');
          await fs.writeFile(destination, result);
          return destination;
        }
        return destination;
      },
      async abort() {
        await queue.catch(() => {});
      },
    };
  },
};
