import * as zip from '@zip.js/zip.js';

/**
 * 纯浏览器/标准 ESM zip IO 适配器
 * 基于 @zip.js/zip.js 实现流式直通与惰性读写。
 */

zip.configure({ useWebWorkers: false });

export const zipIo = {
  /**
   * 打开 ZipReader 读取器
   * @param {Blob|File} source
   */
  async openReader(source) {
    const blobReader = source instanceof zip.BlobReader ? source : new zip.BlobReader(source);
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
   * @param {zip.BlobWriter} destination
   */
  async createWriter(destination = new zip.BlobWriter('application/zip')) {
    const writer = new zip.ZipWriter(destination, { level: 6 });
    return {
      async add(name, data) {
        await writer.add(name, new zip.Uint8ArrayReader(new Uint8Array(data)));
      },
      addLazy(name, openFn) {
        const { readable, writable } = new TransformStream({}, { highWaterMark: 1 });
        openFn((err, source) => {
          if (err) {
            writable.abort(err);
            return;
          }
          source.pipeTo(writable).catch((err) => writable.abort(err));
        });
        void writer.add(name, readable);
      },
      waitForRoom: async () => {},
      async close() {
        await writer.close();
        return destination;
      },
      async abort() {},
    };
  },
};
