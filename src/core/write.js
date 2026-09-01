import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import yazl from 'yazl';

/** 产物统一固定 mtime:同输入同条目顺序产出稳定归档(压缩字节仍随 zlib 版本浮动)。 */
export const FIXED_MTIME = new Date('2020-01-01T00:00:00.000Z');

/**
 * 流式 zip 写出。每个条目要么给 Buffer,要么给"返回 Readable 的工厂";
 * 工厂方式下 yazl 何时拉流不受我们控制,所以大文件走 buffer 路径以外的
 * addReadStream 时,调用方必须保证流在 add 前可立即创建。
 * 当前实现:Buffer 直接 addBuffer;流经 Passthrough 缓一层后 addReadStream。
 */
export class ZipWriter {
  #zip;
  #output;
  #fileStream;
  #outPath;

  constructor(zip, outPath) {
    this.#zip = zip;
    this.#outPath = outPath;
  }

  static async create(outPath) {
    await fs.promises.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
    const zip = new yazl.ZipFile();
    const fileStream = fs.createWriteStream(outPath);
    zip.outputStream.pipe(fileStream);
    const writer = new ZipWriter(zip, outPath);
    writer.#fileStream = fileStream;
    return writer;
  }

  /**
   * @param {string} name 最终条目路径(zip 内 posix 路径)
   * @param {Buffer|(() => import('node:stream').Readable)} source
   */
  add(name, source, { compress = true } = {}) {
    const options = { mtime: FIXED_MTIME, compress };
    if (Buffer.isBuffer(source)) {
      this.#zip.addBuffer(source, name, options);
      return;
    }
    if (typeof source !== 'function') {
      throw new TypeError(`ZipWriter.add: source must be Buffer or stream factory, got ${typeof source}`);
    }
    // 用工厂保持惰性:只有 yazl 真正开始拉数据时才打开源流,保证同一时刻
    // 最多只有一个 yauzl 读流打开(yauzl 硬限制)。背压会让 resume 触发多次,
    // 必须保证源流只创建一次。
    const passthrough = new PassThrough({ highWaterMark: 1 << 20 });
    let started = false;
    passthrough.on('resume', () => {
      if (started) return;
      started = true;
      const stream = source();
      stream.on('error', (err) => passthrough.destroy(err));
      stream.pipe(passthrough);
    });
    this.#zip.addReadStream(passthrough, name, options);
  }

  /** 结束写归档并等待落盘。 */
  async close() {
    this.#zip.end();
    await new Promise((resolve, reject) => {
      this.#fileStream.on('finish', resolve);
      this.#fileStream.on('error', reject);
    });
    return this.#outPath;
  }
}
