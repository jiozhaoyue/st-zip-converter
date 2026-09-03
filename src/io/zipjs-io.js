import * as zip from '@zip.js/zip.js';

/**
 * 浏览器/zip.js IO 适配器(插件用;Node 测试里也用它验证与 CLI 同源同构)。
 *
 * 契约与 node-io 相同,但 source 是 Blob/File、destination 是 zip.BlobWriter 实例。
 * 流式直通链路:reader.openStream 返回 TransformStream 的 readable(内部 entry.getData
 * 往 writable 写解压数据),writer.addLazy 再用一层 TransformStream 交给 zip.js。
 * 两端任一侧变慢都会被 HWM=1 的 TransformStream 挡住,不会整包驻留内存。
 */

zip.configure({ useWebWorkers: false });

export const zipjsIo = {
  async openReader(source) {
    // ZipReader 需要显式 Reader 实例;Blob/File 一律包 BlobReader
    const reader = new zip.ZipReader(source instanceof zip.BlobReader ? source : new zip.BlobReader(source));
    const rawEntries = await reader.getEntries();
    return {
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

  async createWriter(destination) {
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
      async abort() {
        // BlobWriter 无半成品文件需要清理
      },
    };
  },
};
