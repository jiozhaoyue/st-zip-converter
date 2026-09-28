import * as zip from '../vendor/zip.js';
import { convert } from './transform.js';
import { generatePlan } from './plan-preview.js';
import { zipIo, readZipEntryManifest } from './zip-io.js';

/**
 * 协作式暂停：主线程收到 `PAUSE` 消息后转成本线程的 `controller.abort()`。
 *
 * 为什么必须由 worker 自持信号：`AbortSignal` **不可 `postMessage`**
 * （`worker-client.js` 侧同样注释过这一点），主线程送不进来，只能送「请求暂停」这条消息。
 * 于是暂停从「主线程 `terminate()` 直接丢弃半成品」变成「worker 自己收尾成合法 zip 再回报」。
 */
let activeId = null;
let activeController = null;

// Dedicated Worker 转换引擎线程
self.onmessage = async (e) => {
  const { type, id, sourceBlob, target, options = {} } = e.data || {};

  if (type === 'PLAN') {
    try {
      const excludedSet = Array.isArray(options.excludedPaths)
        ? new Set(options.excludedPaths)
        : (options.excludedPaths || new Set());

      const plan = await generatePlan(sourceBlob, target, {
        ...options,
        excludedPaths: excludedSet,
        io: zipIo,
      });

      self.postMessage({
        type: 'PLAN_DONE',
        id,
        plan,
      });
    } catch (err) {
      self.postMessage({
        type: 'ERROR',
        id,
        error: err?.message || String(err),
      });
    }
  } else if (type === 'PAUSE') {
    // 协作式暂停请求：只中止「当前这个」任务，别的 id 一律忽略
    if (id === activeId && activeController) activeController.abort();
  } else if (type === 'CONVERT') {
    const controller = new AbortController();
    activeId = id;
    activeController = controller;
    const finalizeOnAbort = options.finalizeOnAbort === true;
    // ⚠️ **必须在 try 外声明**：`catch` 里要用它取半成品，而 `const` 是块级作用域 ——
    // 写在 try 内会让 catch 里变成 `ReferenceError: targetWriter is not defined`，
    // 且因为收尾段吞错而**静默退化成「没有半成品」**（2026-09-28 实测：暂停后「跳过 0 项」，
    // 产物完整但增量失效）。同形教训本仓已有：`index.js` 的 `opfsName` 亦为此在 try 外声明。
    let targetWriter = null;
    try {
      targetWriter = new zip.BlobWriter('application/zip');
      const excludedSet = Array.isArray(options.excludedPaths)
        ? new Set(options.excludedPaths)
        : (options.excludedPaths || new Set());

      const report = await convert(sourceBlob, targetWriter, {
        ...options,
        excludedPaths: excludedSet,
        target,
        io: zipIo,
        // `signal` 必须由本线程提供：主线程送不进来（AbortSignal 不可 postMessage）
        signal: controller.signal,
        onProgress: (current, total, filename, crc32) => {
          self.postMessage({
            type: 'PROGRESS',
            id,
            current,
            total,
            filename,
            crc32: crc32 ?? null,
          });
        },
      });

      const resultBlob = await targetWriter.getData();
      self.postMessage({
        type: 'DONE',
        id,
        report: report.toJSON(),
        resultBlob,
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        // 中止（暂停）：`finalizeOnAbort` 下 `convert()` 已把已写部分 **close() 成合法 zip**，
        // 这里把半成品与它的条目清单回报主线程（由主线程落盘持久化）。
        //
        // ⚠️ 三条纪律：
        //  ① **不吞错**：拿不到半成品时必须回报原因（`partialError`）——否则主线程只知道
        //     「没有半成品」，排查者无从下手（本仓首轮就踩了：`catch {}` 让原因不可见）。
        //  ② **清单读失败不得连累半成品**：清单只是读数；为一个读数丢掉已经收好的 zip 是本末倒置。
        //  ③ 空包一律视同没有半成品（`size === 0` 没有任何可搬运的字节，留着只会误导）。
        let partialBlob = null;
        let manifest = null;
        let partialError = null;
        if (finalizeOnAbort) {
          try {
            partialBlob = await targetWriter.getData();
          } catch (dataErr) {
            partialError = `getData: ${dataErr?.message ?? dataErr}`;
            partialBlob = null;
          }
          if (partialBlob && !partialBlob.size) {
            partialError = 'empty-partial';
            partialBlob = null;
          }
          if (partialBlob) {
            try {
              manifest = await readZipEntryManifest(partialBlob);
            } catch (manifestErr) {
              manifest = null;
              partialError = `manifest: ${manifestErr?.message ?? manifestErr}`;
            }
          }
        }
        self.postMessage({ type: 'PAUSED', id, partialBlob, manifest, partialError });
      } else {
        self.postMessage({
          type: 'ERROR',
          id,
          error: err?.message || String(err),
        });
      }
    } finally {
      if (activeId === id) {
        activeId = null;
        activeController = null;
      }
    }
  }
};
