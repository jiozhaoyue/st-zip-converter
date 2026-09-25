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
// vendor 压缩/解压线程池上限：默认仅 2，GB 级包是瓶颈；拉满到物理核心数（至少 4）
const HW = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;

zip.configure({
  useWebWorkers: true,
  chunkSize: CHUNK_SIZE,
  maxWorkers: Math.max(4, HW),
});

/**
 * 已压缩内容扩展名集合：对这些条目 deflate 是纯浪费 CPU（压缩率≈0），
 * Store 直存（level 0）可大幅加速写出。
 */
export const STORE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico',
  '.mp4', '.webm', '.mp3', '.ogg', '.wav', '.flac',
  '.db', '.sqlite', '.sqlite3', '.zst', '.7z', '.zip', '.gz', '.br', '.rar',
]);

/**
 * 条目压缩等级分流：已压缩扩展名 → 0 (Store)，其余透传用户等级。
 * @param {string} fileName 条目名（可能带路径）
 * @param {number} userLevel 用户选择的压缩等级 0-9
 * @returns {number} 实际生效的压缩等级
 */
export function entryCompressionLevel(fileName, userLevel) {
  const base = fileName.slice(fileName.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot === -1) return userLevel;
  return STORE_EXTENSIONS.has(base.slice(dot).toLowerCase()) ? 0 : userLevel;
}

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
              /**
               * 读失败时**安全地**把错误转达给消费方。
               *
               * 历史事故（2026-09-26 实测，见任务 `09-26-all-instance-data-sync-e2e`
               * 的 `research/build-packs-blocker.md`）：此行原为 `readable.cancel(err)`。
               * 当消费方（`writer.addLazy` 的 `source.pipeTo(writable)`）**已经锁定**该流时，
               * `cancel()` 自身抛 `ERR_INVALID_STATE: ReadableStream is locked`；该抛出发生在
               * `.catch()` 回调里 ⇒ 升级为**未处理拒绝**，后果是：
               *   ① Node 侧直接杀死进程，且**不留下任何转换错误**；
               *   ② 真正的主错误被这条无意义的 "ReadableStream is locked" 彻底掩盖。
               * 修正：已锁定/已取消时不再 cancel（此时错误本就会经 TransformStream
               * 自然传播给消费方）；cancel 自身的失败也无处可报，显式吞掉。
               */
              entry.getData(writable).catch((err) => {
                if (!readable.locked) {
                  readable.cancel(err).catch(() => {});
                }
              });
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
   * @param {boolean} [options.bufferedWrite=false] 是否让 vendor 为**每条目**建临时流整条缓冲。
   *   默认**关闭**——实测该模式在真实包规模上会永不落盘，见下方说明。
   */
  async createWriter(destination = new zip.BlobWriter('application/zip'), {
    level = 5,
    /**
     * zip.js 的 `bufferedWrite: true` 会为**每一个条目**建一个 `highWaterMark: Infinity`
     * 的临时流，把整条数据缓冲完才写入目标。
     *
     * 实测（2026-09-26，真源包 1602.7 MB / 8683 条目，任务
     * `09-26-all-instance-data-sync-e2e` 的 `research/build-packs-blocker.md`）：
     *   - `bufferedWrite: true`  → 落点文件字节数**恒为 0**、`close()` **永不返回**，
     *     RSS 涨到 1.0–1.5 GB；配合上方 `openStream` 的未处理拒绝还会**杀死进程**。
     *   - `bufferedWrite: false` → **82.4 s 完成**，产出 614 MB，RSS ~330 MB（有界）。
     * 同一份数据、同一落点，唯一变量是该标志。
     *
     * 故默认改为 `false`（直写目标、不做整条缓冲）。确需旧行为的调用方可显式传 `true`。
     */
    bufferedWrite = false,
  } = {}) {
    const isFilePath = typeof destination === 'string';
    const writerTarget = isFilePath ? new zip.Uint8ArrayWriter() : destination;
    const writer = new zip.ZipWriter(writerTarget, { level, bufferedWrite });
    const written = new Set();
    /**
     * **正在写入**的条目 —— 背压窗口**只看它**。
     *
     * ⚠️ 绝不可把「已受理但仍在排队」的条目也算进来：那样排队者自身会把窗口占满，
     * `inflight.size` 永远降不到 `CONCURRENCY` 以下，`waitForSlot()` 便会在等待一批
     * **永不 settle** 的 promise 上永久自锁（2026-09-26 用纯形态复刻实测：100 条任务只完成 6 条，
     * 其余 94 条永久饿死。证据见任务 `09-26-all-instance-data-sync-e2e` 的
     * `research/build-packs-blocker.md` 的 Bug D）。
     */
    const inflight = new Set();
    /**
     * **全部未完成**条目（含仍在排队的）—— `close()` 必须等齐它，
     * 否则排队中的条目会被静默丢弃（产出「少了条目但看着完整」的包）。
     */
    const pending = new Set();
    /**
     * 首条目闸门：中央目录首条的顺序语义要求「首条目先落盘，再放开并发」
     * （见原实现的注释）。用显式闸门表达，**不再**靠 `firstEntryDone` 顺带承担背压 ——
     * 原写法把窗限放在 `if (!firstEntryDone)` **之后**，而 `convert()` 是在紧凑循环里
     * **同步、不 await** 地投递全部条目，于是所有任务开跑时该标志仍为 `false`，
     * **全部走首条目分支、无一经过背压** ⇒ 无界并发（Bug C）。
     */
    let firstEntryClaimed = false;
    let releaseFirstEntry = null;
    const firstEntryGate = new Promise((resolve) => { releaseFirstEntry = resolve; });
    // Store 直存统计（report 消费）：命中已压缩扩展名而绕过 deflate 的条目数与字节量
    const storeStats = { count: 0, bytes: 0 };

    /** 登记一个**正在写入**的条目（占用背压窗口）。只许包住「真正在写」的那段。 */
    function track(promise) {
      const wrapped = promise.finally(() => inflight.delete(wrapped));
      inflight.add(wrapped);
      return wrapped;
    }

    /** 登记一个**已受理、可能仍在排队**的条目（不占背压窗口，但 `close()` 要等它）。 */
    function enqueue(promise) {
      const wrapped = promise.finally(() => pending.delete(wrapped));
      pending.add(wrapped);
      return wrapped;
    }

    /** 认领「首条目」身份。必须在**同步**段调用（IIFE 起跑前），否则认领会飘。 */
    function claimFirst() {
      if (firstEntryClaimed) return false;
      firstEntryClaimed = true;
      return true;
    }

    function levelFor(name) {
      const lv = entryCompressionLevel(name, level);
      return lv;
    }

    function noteStore(name, byteSize) {
      if (levelFor(name) === 0 && level !== 0) {
        storeStats.count += 1;
        storeStats.bytes += byteSize || 0;
      }
    }

    /**
     * 并发背压：在飞条目数达到并发上限时等待任一完成。
     * 只看 `inflight`（在跑条目），排队者不计入 —— 这是不自锁的前提。
     */
    async function waitForSlot() {
      while (inflight.size >= CONCURRENCY) {
        await Promise.race(inflight);
      }
    }

    /**
     * 条目写入的**公共前置**：非首条目先等首条目闸门，再取背压窗口。
     * 取窗口必须发生在闸门**之后**，否则窗口会被一堆等闸门的条目占住。
     */
    async function acquireWriteTurn(isFirst) {
      if (!isFirst) await firstEntryGate;
      await waitForSlot();
    }

    /** 放行首条目闸门（成功/失败都放行，否则其余条目会永久阻塞） */
    function releaseGate(isFirst) {
      if (isFirst) releaseFirstEntry();
    }

    return {
      /**
       * 添加内存条目（并发窗口内直接交给 vendor 压缩写入）
       */
      async add(name, data) {
        if (written.has(name)) return;
        written.add(name);
        const entryLevel = levelFor(name);
        noteStore(name, data.byteLength ?? data.length ?? 0);
        const bytes = new Uint8Array(data);
        const isFirst = claimFirst();
        return enqueue((async () => {
          try {
            await acquireWriteTurn(isFirst);
            await track(writer.add(name, new zip.Uint8ArrayReader(bytes), { level: entryLevel }));
          } finally {
            releaseGate(isFirst);
          }
        })());
      },

      /**
       * 流式直通条目（pass-through 大文件零拷贝）
       *
       * 背压顺序**不可颠倒**：先过首条目闸门，再取并发窗口。原实现把窗口放在
       * `if (!firstEntryDone)` 之后，而 `convert()` 是同步紧凑投递，导致窗口形同虚设（Bug C）。
       */
      addLazy(name, openFn, byteSize = 0) {
        if (written.has(name)) return Promise.resolve();
        written.add(name);
        const entryLevel = levelFor(name);
        noteStore(name, byteSize);
        const isFirst = claimFirst();
        return enqueue((async () => {
          try {
            await acquireWriteTurn(isFirst);
            const { readable, writable } = new TransformStream({}, { highWaterMark: 16 });
            const addPromise = writer.add(name, readable, { level: entryLevel });
            openFn((err, source) => {
              if (err) {
                writable.abort(err);
                return;
              }
              source.pipeTo(writable).catch((err) => writable.abort(err));
            });
            await track(addPromise);
          } finally {
            releaseGate(isFirst);
          }
        })());
      },

      /**
       * 背压等待：全部在飞条目落盘（供上层在内存峰值敏感处调用）
       */
      waitForRoom: async () => {
        // 等 `pending`（含排队者）而非 `inflight`（只有在跑者）：
        // 本方法供上层在**内存峰值敏感**处调用，若只等在跑者，队列里积压的条目仍会持续占内存。
        // `pending` 是 `inflight` 的超集 —— 每个被 track 的写入都发生在一个已 enqueue 的任务内。
        while (pending.size > 0) {
          await Promise.race(pending);
        }
      },

      /**
       * Store 直存统计（命中已压缩扩展名绕过 deflate 的条目）
       * @returns {{count: number, bytes: number}}
       */
      getStoreStats: () => ({ ...storeStats }),

      async close() {
        // 收齐**全部**未完成条目（含仍在排队的）再关闭 —— 只等 `inflight` 会漏掉排队者，
        // 产出「少了条目却看着完整」的包。收齐后中央目录才完整。
        await Promise.allSettled([...pending]);
        const result = await writer.close();
        if (isFilePath) {
          const fs = await import('node:fs/promises');
          await fs.writeFile(destination, result);
          return destination;
        }
        return destination;
      },

      async abort() {
        await Promise.allSettled([...pending].map((p) => p.catch(() => {})));
      },
    };
  },
};
