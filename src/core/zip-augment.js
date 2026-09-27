import * as zip from '../vendor/zip.js';
import { zipIo } from './zip-io.js';
import { logger } from './logger.js';

/**
 * 源包增强（纯 IO）—— 把一个 zip 的条目**惰性直通**复制到新包，并追加若干内存条目。
 *
 * ## 为什么在「源包」这一层注入
 *
 * 注入条目一旦进入源包，下游**既有代码零改动**即可正确处理它们：
 * `detectFromReader`（布局识别）、`routeSource`（类目判定）、`targetEntryPath`（目标落位：
 * L 的 `data/...`、PT/TT 的 `data/extensions/...`）、`selection` 过滤、`splitter`（分卷）——
 * 全部照常。若改为在 `convert()` 内部新增「注入条目」选项，则要同时改主循环、分卷器、
 * 报告计数与 Worker 消息协议四处，回归面大得多（见本任务 `design.md` D3）。
 *
 * ## 内存纪律
 *
 * - **计划为空 ⇒ 原样返回 `source`，不做任何 IO**（常态路径零成本）；
 * - 源条目一律 `addLazy` 流式直通（不整条缓冲）；
 * - 每 `BACKPRESSURE_EVERY` 条 `await writer.waitForRoom()` —— 复用 `zip-io.js` 里
 *   已经付出过代价的结论（无界投递曾把内存峰值推到 6.2 GB）；
 * - 浏览器可传 OPFS 目标（`{ writable, finalize }`）把增强包直接落到磁盘，避免再占一份内存。
 *
 * @module core/zip-augment
 */

/** 每多少条做一次背压（与 zip-io 的 CONCURRENCY 同量级，取 8 的倍数便于观察） */
const BACKPRESSURE_EVERY = 64;

/** 中止检查（与 transform.js 同一形态：`DOMException('...', 'AbortError')`） */
function checkAbort(signal) {
  if (signal?.aborted) {
    throw new DOMException('源包增强已被中止/暂停', 'AbortError');
  }
}

/**
 * 归一注入条目：名字必须是非空字符串，内容接受 string / Uint8Array / ArrayBuffer / Blob。
 * @param {Array<{name: string, data: any}>} entries
 * @returns {Array<{name: string, data: Uint8Array}>}
 */
function normalizeEntries(entries) {
  const out = [];
  const seen = new Set();
  for (const raw of entries || []) {
    if (!raw) continue;
    const name = typeof raw.name === 'string' ? raw.name.replace(/\\/g, '/').replace(/^\/+/, '') : '';
    if (!name) continue;
    if (seen.has(name)) continue; // 包内重名：只留第一条（与 zip-io 的 written 集合同语义）
    const data = raw.data;
    if (typeof data === 'string') {
      out.push({ name, data: new TextEncoder().encode(data) });
    } else if (data instanceof Uint8Array) {
      out.push({ name, data });
    } else if (data instanceof ArrayBuffer) {
      out.push({ name, data: new Uint8Array(data) });
    } else if (data && typeof data.arrayBuffer === 'function') {
      out.push({ name, data }); // Blob/File：交给 write 时再取字节
    } else {
      continue;
    }
    seen.add(name);
  }
  return out;
}

/**
 * 把源包重写为「源包条目 + 注入条目」的新包。
 *
 * @param {Blob|File|string} source 源包（浏览器 Blob / Node 路径）
 * @param {Array<{name: string, data: string|Uint8Array|ArrayBuffer|Blob}>} entries 注入条目
 * @param {object} [options]
 * @param {string|{writable: WritableStream, finalize?: function(): Promise<any>}} [options.target]
 *   落点：字符串 = Node 文件路径；**省略** = 内部新建 `BlobWriter` 并返回 Blob；
 *   `{writable, finalize}` = 自定义流（OPFS 同形）
 * @param {object} [options.io=zipIo] zip IO 适配器（测试可注入假实现）
 * @param {number} [options.compressionLevel=5]
 * @param {function(number, number): void} [options.onProgress] (已处理条目数, 总条目数)
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Blob|string|any>} 落点为省略 ⇒ Blob；字符串 ⇒ 该路径；
 *   自定义流 ⇒ `finalize()` 的返回值。`entries` 为空时返回 `source` 本身。
 */
export async function augmentZip(source, entries, {
  target,
  io = zipIo,
  compressionLevel = 5,
  onProgress,
  signal,
} = {}) {
  const inject = normalizeEntries(entries);
  // 常态：没有要补的条目 ⇒ 一个字节都不动（不做任何 IO、不产生任何临时文件）
  if (inject.length === 0) return source;

  // ⚠️ `zip-io` 的 `close()` 返回的是**落点对象本身**（路径字符串或自定义流），
  // 不是产物数据；浏览器路径下产物要经 `BlobWriter.getData()` 取。
  // 故这里必须自己持有 BlobWriter 才能把 Blob 交出去（既有调用方 `worker-client.js:96`
  // 也是「自己建 BlobWriter → 转换 → `destination.getData()`」这一形态）。
  let destination = target;
  const ownsBlobWriter = destination === undefined;
  if (ownsBlobWriter) destination = new zip.BlobWriter('application/zip');

  const reader = await io.openReader(source);
  const writer = await io.createWriter(destination, { level: compressionLevel });
  /**
   * 待注入表（**源包优先**的唯一执行点）。
   *
   * ⚠️ 这里曾经写成「源条目命中注入名就 `continue` 跳过源条目」——**方向反了**：
   * 结果是原聊天被同名注入项**顶替**（内容被改写），而那正是本模块最不能犯的错。
   * 正确语义：源包里已有同名条目 ⇒ **划掉注入**、原条目照常写入。
   */
  const pending = new Map(inject.map((e) => [e.name, e]));
  const total = (reader.totalEntries ?? 0) + inject.length;
  let processed = 0;

  try {
    checkAbort(signal);

    for await (const entry of reader.entries()) {
      checkAbort(signal);
      const name = String(entry.fileName || '').replace(/\\/g, '/');
      pending.delete(name); // 源包优先：同名注入作废
      writer.addLazy(name, (cb) => {
        entry.openStream().then((stream) => cb(null, stream), (err) => cb(err));
      }, entry.uncompressedSize || 0);
      processed += 1;
      onProgress?.(processed, total);
      if (processed % BACKPRESSURE_EVERY === 0 && typeof writer.waitForRoom === 'function') {
        await writer.waitForRoom();
      }
    }

    for (const item of pending.values()) {
      checkAbort(signal);
      const bytes = item.data instanceof Uint8Array ? item.data : new Uint8Array(await item.data.arrayBuffer());
      await writer.add(item.name, bytes);
      processed += 1;
      onProgress?.(processed, total);
    }

    const result = await writer.close();
    // 自定义流目标（OPFS 同类）：close 只结束写入，产物由 finalize 交出
    if (target && typeof target === 'object' && typeof target.finalize === 'function') {
      return await target.finalize();
    }
    if (ownsBlobWriter) return await destination.getData();
    return result;
  } catch (err) {
    // 失败/中止：**不留半成品**。
    // `zip-io` 的写入器有 `abort()`（只收挂在飞 promise，**不**落盘），
    // 故路径目标下不会留下半截包 —— 这与 `transform.js` 中止路径的既有处置同向。
    try { await writer.abort?.(); } catch { /* 收尾失败不改变结论 */ }
    if (target && typeof target === 'object' && typeof target.abort === 'function') {
      try { await target.abort(); } catch { /* 清理失败不影响上抛的主错误 */ }
    }
    if (err?.name === 'AbortError') throw err;
    logger.error(`源包增强失败: ${err?.message || err}`);
    throw err;
  } finally {
    try { await reader.close(); } catch { /* 读侧关闭失败不改变结论 */ }
  }
}
