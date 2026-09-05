import * as zip from '@zip.js/zip.js';

/**
 * 通用标准 zip IO 适配器 (基于 @zip.js/zip.js)
 * 支持纯浏览器 Blob/File，同时兼顾 Node 测试环境中的文件路径读写。
 */

zip.configure({ useWebWorkers: false });

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

    return {
      totalEntries: rawEntries.filter((e) => !e.directory).length,
      async *entries() {
        for (const entry of rawEntries) {
          if (entry.directory) continue;
          yield {
            fileName: entry.filename,
            uncompressedSize: entry.uncompressedSize,
            lastModified: entry.lastModDate ?? null,
            crc32: entry.crc32 ?? null,
            isDirectory: false,
            openStream: async () => {
              const { readable, writable } = new TransformStream({}, { highWaterMark: 1 });
              entry.getData(writable).catch((err) => readable.cancel(err));
              return readable;
            },
            read: async () => {
              return new Uint8Array(await entry.arrayBuffer());
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
