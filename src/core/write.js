import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import yazl from 'yazl';

/** 产物统一固定 mtime:同输入同条目顺序产出稳定归档(压缩字节仍随 zlib 版本浮动)。 */
export const FIXED_MTIME = new Date('2020-01-01T00:00:00.000Z');

/** 写侧背压上限:yazl 的 outputStream 是 PassThrough,磁盘变慢时缓冲无界,
 * 必须由读入方在积压超限时暂停(yazl 没有逐条目完成事件可等)。 */
const BACKPRESSURE_LIMIT = 16 << 20; // 16 MiB

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
  #aborted = false;
  #error = null;

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
    zip.on('error', (err) => {
      writer.#error = err;
      fileStream.destroy(err);
    });
    return writer;
  }

  /**
   * 惰性流式条目:yazl 泵到该条目时才调用 openFn 拿源流。
   * 配合顺序泵(yazl 严格逐条目)与 yauzl 单读流约束:源流在泵时打开,
   * 泵完才轮到下一条,天然只有一条源流打开;内存与条目大小无关。
   * @param {string} name 最终条目路径
   * @param {(cb: (err: Error|null, stream?: import('node:stream').Readable) => void) => void} openFn
   */
  addLazy(name, openFn, { compress = true } = {}) {
    this.#zip.addReadStreamLazy(name, { mtime: FIXED_MTIME, compress }, (cb) => {
      try {
        openFn(cb);
      } catch (err) {
        cb(err);
      }
    });
  }

  /**
   * 背压闸:写侧积压(writable+readable 队列)超过上限时挂起,等 pipe 排空。
   * 每次add 前调用,保证峰值内存 ≈ 最大单条目 + 上限,而不是整个包。
   */
  async waitForRoom() {
    const stream = this.#zip.outputStream;
    while (stream.writableLength + stream.readableLength > BACKPRESSURE_LIMIT) {
      if (this.#aborted) throw new Error('ZipWriter aborted');
      await new Promise((resolve) => setImmediate(resolve));
    }
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
      if (this.#error) {
        reject(this.#error);
        return;
      }
      this.#fileStream.on('finish', resolve);
      this.#fileStream.on('error', reject);
    });
    return this.#outPath;
  }

  /** 转换失败时调用:丢弃半成品文件,不留损坏 zip。 */
  async abort() {
    this.#aborted = true;
    try {
      this.#zip.end();
    } catch { /* 尽力而为 */ }
    this.#fileStream.destroy();
    await fs.promises.rm(this.#outPath, { force: true }).catch(() => {});
  }
}

/** --dry-run 用:同接口但不落盘。 */
export class NullZipWriter {
  add() {}
  addLazy() {}
  async waitForRoom() {}
  async close() {
    return null;
  }
  async abort() {}
}
