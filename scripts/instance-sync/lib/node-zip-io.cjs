/**
 * Node 侧 IO 适配器 —— 大包**不进内存**的 `convert()` 接缝实现
 *
 * 背景：`src/core/zip-io.js` 的 `zipIo` 在 Node 上两端都会整包进内存 ——
 *   - 输入：`openReader('<path>')` 走 `fs.readFile` 后 `new Blob([buffer])`（约 2× 体积）；
 *   - 输出：`createWriter('<path>')` 用 `zip.Uint8ArrayWriter`，`close()` 时才 `writeFile`。
 * 本任务的真源包 **3.8 G**，这条路不可接受（设计见 `design.md` §2）。
 *
 * 做法：`convert()` 的 `options.io` 是**文档化的注入接缝**
 * （`transform.js:34-35` 与 `transform.js:257` 的契约校验：`{openReader, createWriter}`），
 * 本模块只替换**字节的来处与去处**，其余全程复用产品管线：
 *   - 输入：`fs.openAsBlob()`（Node 19+）给出**磁盘惰性 Blob**，`zip.BlobReader` 按需切片读，
 *     不把整包读进内存 ⇒ 直接复用 `zipIo.openReader`；
 *   - 输出：`zipIo.createWriter(writerTarget, …)` 对**非字符串**目标原样使用
 *     （`zip-io.js:145`）⇒ 传入本模块的 `FileWriter`，字节直接追加落盘。
 * 并发窗口、`addLazy` 直通、Store 统计、首条目保序等语义**全部保持产品实现不变**。
 *
 * 纪律：**不改 `src/**`**（本任务是验证与数据同源，不是改产品）；本文件只在 `scripts/` 下。
 *
 * @module scripts/instance-sync/lib/node-zip-io
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const VENDOR_ZIP = path.join(REPO_ROOT, 'src', 'vendor', 'zip.js');
const CORE_ZIP_IO = path.join(REPO_ROOT, 'src', 'core', 'zip-io.js');

let cached = null;

/**
 * 装载 vendor zip.js 与产品的 `zipIo`。
 * 两者都是 ESM，从 CJS 用动态 `import()` 载入（`file://` URL 形式，Windows 路径必需）。
 */
async function loadDeps() {
  if (cached) return cached;
  const zip = await import(pathToFileURL(VENDOR_ZIP).href);
  const core = await import(pathToFileURL(CORE_ZIP_IO).href);
  if (!core.zipIo || typeof core.zipIo.openReader !== 'function') {
    throw new Error('src/core/zip-io.js 未导出可用的 zipIo —— io 接缝契约已变，请复核 transform.js:257');
  }
  cached = { zip, zipIo: core.zipIo };
  return cached;
}

/**
 * 文件落点 Writer —— 字节**追加直写磁盘**，不在内存里攒。
 * 契约来自 zip.js 的 `Writer` 基类（运行时内省确认：原型上只有 `writeUint8Array`）：
 * 子类需实现 `init(size?)` / `writeUint8Array(array)` / `getData()`。
 */
function makeFileWriter(zip) {
  return class FileWriter extends zip.Writer {
    /** @param {string} filePath */
    constructor(filePath) {
      super();
      this.filePath = filePath;
      this.bytesWritten = 0;
      this._fd = null;
    }

    /**
     * @param {number} [size] zip.js 在已知总长时会传；本实现不需要，但必须接受
     *
     * ⚠️ **必须调 `super.init()`**：zip.js 的 `Writer` 基类构造器建了一个 `WritableStream`，
     * 其 write 回调在 `!this.initialized` 时抛 `ERR_WRITER_NOT_INITIALIZED`
     * （实测报错：`Error: Writer not initialized`），而 `initialized` **只**由基类
     * `init(){this.initialized = true}` 设置。漏调 ⇒ 第一个条目就炸。
     */
    async init(size) {
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      this._fd = fs.openSync(this.filePath, 'w');
      this.declaredSize = typeof size === 'number' ? size : null;
      super.init(size);
    }

    async writeUint8Array(array) {
      if (this._fd === null) throw new Error('FileWriter 未 init() 就写入');
      // writeSync 对 Uint8Array 全程有效；Node 会处理部分写
      let off = 0;
      while (off < array.length) {
        off += fs.writeSync(this._fd, array, off, array.length - off);
      }
      this.bytesWritten += array.length;
      this.size = this.bytesWritten; // 与基类字段保持同步（基类构造器初始化为 0）
    }

    /** @returns {string} 落盘路径（zip.js 用其返回值作为 `ZipWriter.close()` 的结果） */
    async getData() {
      if (this._fd !== null) {
        fs.closeSync(this._fd);
        this._fd = null;
      }
      return this.filePath;
    }

    /** 失败路径清理：关句柄并删掉半截产物，避免留下看似完整的假包 */
    async abort() {
      if (this._fd !== null) {
        try { fs.closeSync(this._fd); } catch { /* 已关 */ }
        this._fd = null;
      }
      try { await fsp.rm(this.filePath, { force: true }); } catch { /* 不存在 */ }
    }
  };
}

/**
 * 构造 Node 侧 io 适配器。
 * @returns {Promise<{openReader: Function, createWriter: Function}>}
 */
async function createNodeIo() {
  const { zip, zipIo } = await loadDeps();
  const FileWriter = makeFileWriter(zip);

  return {
    /**
     * 打开读包器。传入字符串路径时改用**磁盘惰性 Blob**，避免整包读入内存。
     * 传 Blob/File 时行为与产品一致。
     */
    async openReader(source) {
      if (typeof source === 'string') {
        // 注意：`fs.openAsBlob` 挂在 **node:fs**（回调模块）上，**不在** fs/promises 上
        // （Node v24.14.1 实测：fs.openAsBlob=function，fsp.openAsBlob=undefined）。
        // 用错会静默落到下面的整包进内存回退 —— 3.8 G 包会直接打爆内存。
        if (typeof fs.openAsBlob === 'function') {
          const blob = await fs.openAsBlob(source, { type: 'application/zip' });
          return zipIo.openReader(blob);
        }
        console.warn('[node-zip-io] 本 Node 无 fs.openAsBlob，回退产品路径（整包进内存，大包慎用）');
      }
      return zipIo.openReader(source);
    },

    /**
     * 创建写包器。传字符串路径时以 `FileWriter` 为落点（边压边落盘）。
     * @param {string|object} destination
     * @param {{level?: number}} [options]
     */
    async createWriter(destination, options = {}) {
      if (typeof destination !== 'string') return zipIo.createWriter(destination, options);
      const writer = new FileWriter(destination);
      const handle = await zipIo.createWriter(writer, options);
      // 透出落点与真实字节数，便于调用方记录（不改变产品契约）
      handle.filePath = destination;
      handle.bytesWritten = () => writer.bytesWritten;
      return handle;
    },
  };
}

/** 便捷：一次性构造并缓存 */
async function getNodeIo() {
  return createNodeIo();
}

module.exports = { createNodeIo, getNodeIo, makeFileWriter, REPO_ROOT };
