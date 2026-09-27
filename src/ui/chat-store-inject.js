import { logger } from '../core/logger.js';
import { zipIo } from '../core/zip-io.js';
import {
  collectSourceChatFileNames, describePlan, HIDDEN_LIBRARY_PREFIX, isChatLikePath, planInjection,
} from '../core/pack-inject.js';
import { isBackupChatOrSnapshot } from '../core/inspect.js';
import { augmentZip } from '../core/zip-augment.js';
import { runConversionTask } from '../core/worker-client.js';
import {
  importChatsToLibrary, listLibraryChats, probeChatStore, readLibraryChatAsJsonl,
} from './chat-store-bridge.js';

/**
 * 编排：把「聊天库里的聊天」补进源包（`chat-store-bridge` + `pack-inject` + `zip-augment`）
 *
 * 放在 `ui/` 而非 `core/`：它要触达外部插件与 OPFS，两者都是宿主侧能力（`L0-9`）。
 * 决策（补哪些）与 IO（怎么补）各自在 `core/` 里，本文件只做串接与降级。
 *
 * ## 降级阶梯（任一档不满足即原样透传，**主路径不受影响**）
 *
 * | 档位 | 条件 | 行为 |
 * | --- | --- | --- |
 * | 0 | 未检测到 `ChatFilesysApi` | **一个字节不动、一行日志不打**（默认路径零变化） |
 * | 1 | 有 API 但缺 `list`/`export` 能力 | 记一条 info（说明为何没补），透传 |
 * | 2 | 计划为空（源包已齐 / 类目关掉） | 记一条 info，透传 |
 * | 3 | 逐条取正文**全失败** | 记一条 warn，透传（不产出「只多了一堆空条目」的包） |
 * | 4 | 有可补条目 | 产出增强包（内存 Blob，与既有管线同形态） |
 *
 * @module ui/chat-store-inject
 */

/** 源包字节数（日志用；拿不到按 0 处理） */
function sizeOf(source) {
  try {
    return typeof source?.size === 'number' ? source.size : 0;
  } catch {
    return 0;
  }
}

/** 取源包的全部条目名（仅读中央目录，不解压任何条目） */
async function collectEntryNames(source, io) {
  const reader = await io.openReader(source);
  const names = [];
  try {
    for await (const entry of reader.entries()) {
      if (entry.isDirectory) { entry.skip?.(); continue; }
      names.push(entry.fileName);
      entry.skip?.();
    }
  } finally {
    try { await reader.close(); } catch { /* 关闭失败不改变结论 */ }
  }
  return names;
}

/**
 * 申请增强包的落点。
 *
 * **取舍（已实测权衡）**：一律落内存 Blob，**不用 OPFS**。理由不是省事，而是**生命周期**：
 * 增强包在 `needsTransform=false` 的分支会**原样进待导出区**（成为用户手上的产物），
 * 此时它必须持续可用；而 OPFS 临时包要在「消费完毕」后清理，那个时点在两条分支里不一致，
 * 漏清就泄漏磁盘、早清就毁掉产物。落内存 Blob 与既有管线**同形态**——
 * `exportQueue` 本来就持有内存 Blob（`index.js:1653` 的 `finalBlob`），故这是**一致的**取舍。
 *
 * 代价：纯库且库很大的场景，峰值多一份包体积。已登记为残留（可选优化：OPFS + 引用计数清理）。
 * @returns {Promise<{target: undefined, cleanup: null, route: string}>}
 */
async function openAugmentTarget() {
  return { target: undefined, cleanup: null, route: 'blob' };
}

/**
 * 把聊天库里的聊天补进源包。
 *
 * **调用方契约**：`cleanup` 非 null 时必须在转换结束后调用（当前实现恒为 null，
 * 保留该接缝是为了将来换成 OPFS 落点时不改动调用方）。
 *
 * @param {Blob|File|string} source 源包
 * @param {object} [options]
 * @param {Record<string, boolean>|null} [options.selection] 类目选择（`chats === false` ⇒ 不补）
 * @param {boolean} [options.includeBackups=false]
 * @param {number} [options.compressionLevel=5]
 * @param {AbortSignal} [options.signal]
 * @param {function(number, number): void} [options.onProgress]
 * @param {object} [options.io=zipIo]
 * @returns {Promise<{
 *   source: Blob|File|string,
 *   injected: number,
 *   attempted: number,
 *   failed: Array<{fileName: string, reason: string}>,
 *   plan: object|null,
 *   probe: object,
 *   cleanup: Function|null,
 *   skippedReason: string
 * }>}
 */
export async function injectLibraryChatsIntoSource(source, {
  selection = null,
  includeBackups = false,
  compressionLevel = 5,
  signal,
  onProgress,
  io = zipIo,
} = {}) {
  const probe = probeChatStore();
  const base = {
    source, injected: 0, attempted: 0, failed: [], plan: null, probe, cleanup: null, skippedReason: '',
  };

  // 档 0：没有聊天库插件 —— 静默透传（这是绝大多数用户的常态路径）
  if (!probe.present) return base;

  // 档 1：有插件但接缝能力不足
  if (!probe.canList || !probe.canExport) {
    const why = !probe.canList ? '未提供聊天索引能力(list)' : '未提供聊天导出能力(export)';
    base.skippedReason = why;
    logger.info(`检测到聊天库（模式 ${probe.mode}）但${why} ⇒ 本次不补聊天（若为纯库模式，请在插件弹窗手动导出）`);
    return base;
  }

  const listed = await listLibraryChats({ signal });
  if (!listed.ok) {
    base.skippedReason = listed.reason;
    logger.warn(`聊天库索引不可用（${listed.reason}）⇒ 本次不补聊天`);
    return base;
  }

  let sourceChatNames;
  try {
    sourceChatNames = collectSourceChatFileNames(await collectEntryNames(source, io));
  } catch (err) {
    base.skippedReason = `源包条目枚举失败：${err.message}`;
    logger.warn(`源包条目枚举失败（${err.message}）⇒ 本次不补聊天`);
    return base;
  }

  const plan = planInjection({ libraryChats: listed.chats, sourceChatNames, selection, includeBackups });
  base.plan = plan;

  // 档 2：无需补
  if (plan.inject.length === 0) {
    base.skippedReason = '源包已含全部库中聊天';
    logger.info(`聊天库检查完毕：${describePlan(plan)} ⇒ 无需补齐`);
    return base;
  }

  logger.info(`聊天库检测到 ${plan.inject.length} 条源包缺失的聊天，开始导出：${describePlan(plan)}`);

  // 逐条取正文（内存纪律：一条一条来）
  const entries = [];
  for (const item of plan.inject) {
    if (signal?.aborted) {
      base.skippedReason = 'aborted';
      throw new DOMException('聊天补齐已被中止/暂停', 'AbortError');
    }
    base.attempted += 1;
    // eslint-disable-next-line no-await-in-loop —— 逐条串行是刻意的：单条可能很大，且要能随时中止
    const read = await readLibraryChatAsJsonl(item.ref, { signal });
    if (read.ok) entries.push({ name: item.hubPath, data: read.text });
    else base.failed.push({ fileName: item.fileName, reason: read.reason });
  }

  // 档 3：一条都没取到 ⇒ 不产出「只多了一堆空条目」的包
  if (entries.length === 0) {
    base.skippedReason = '全部条目导出失败';
    logger.warn(`聊天库 ${base.attempted} 条全部导出失败（首因：${base.failed[0]?.reason}）⇒ 本次不补聊天`);
    return base;
  }

  const { target, cleanup, route } = await openAugmentTarget();
  let augmented;
  try {
    logger.info(`正在重写源包以并入聊天（源包 ${(sizeOf(source) / 1048576).toFixed(1)} MB，落点 ${route}）...`);
    augmented = await augmentZip(source, entries, {
      target, io, compressionLevel, signal, onProgress,
    });
  } catch (err) {
    if (cleanup) await cleanup();
    if (err?.name === 'AbortError') throw err;
    base.skippedReason = `增强失败：${err.message}`;
    logger.error(`聊天补齐失败（${err.message}）⇒ 本次用原源包继续转换`);
    return base;
  }

  base.source = augmented;
  base.injected = entries.length;
  base.cleanup = cleanup;
  logger.success(`已把 ${entries.length} 条库中聊天补入源包（落点 ${route}）`
    + (base.failed.length ? `；另有 ${base.failed.length} 条导出失败` : ''));
  return base;
}

/**
 * 从**聊天库**直接产出一个数据包（不需要源包）—— 纯库模式下的「导出聊天记录」。
 *
 * 为什么需要它：纯库模式里磁盘上没有 jsonl，用户想「把我的聊天拷出来」时，
 * 宿主拉取会连整份用户数据一起拉（GB 级），而这里只要**库里的聊天**这一件事。
 *
 * 做法（复用既有管线，不另造一套转换）：造一个**最小 ST 摊平源包**
 * （注入的聊天 + `settings.json` 骨架，后者用于让 `detectFromReader` 认出布局），
 * 然后交给 `runConversionTask` 走**与普通转换完全相同**的那条路 —— 于是目标落位、
 * 类目过滤、压缩策略、Worker 并发全部免费继承。
 *
 * 与「打包时并入」的分工：那条补的是**已有包**缺的聊天；这条是**只有库**时的出口。
 *
 * @param {object} [options]
 * @param {string} [options.target='st'] 目标平台
 * @param {Record<string, boolean>|null} [options.selection] 类目选择（`chats === false` ⇒ 不导出）
 * @param {number} [options.compressionLevel=5]
 * @param {AbortSignal} [options.signal]
 * @param {function(number, number): void} [options.onProgress]
 * @param {object} [options.io=zipIo]
 * @returns {Promise<{ok: boolean, blob: Blob|null, count: number, failed: Array<{fileName: string, reason: string}>, reason: string}>}
 */
export async function exportLibraryToPack({
  target = 'st',
  selection = null,
  compressionLevel = 5,
  signal,
  onProgress,
  io = zipIo,
} = {}) {
  const probe = probeChatStore();
  if (!probe.present) {
    return { ok: false, blob: null, count: 0, failed: [], reason: '未检测到聊天库' };
  }
  if (!probe.canList || !probe.canExport) {
    return {
      ok: false, blob: null, count: 0, failed: [],
      reason: !probe.canList ? '聊天库未提供索引能力(list)' : '聊天库未提供导出能力(export)',
    };
  }

  const listed = await listLibraryChats({ signal });
  if (!listed.ok) {
    return { ok: false, blob: null, count: 0, failed: [], reason: `库索引不可用：${listed.reason}` };
  }

  // 空源包 ⇒ 库里每一条都是「缺失项」，于是复用同一套判定（含类目关断、隐藏容器、备份特征）
  const plan = planInjection({ libraryChats: listed.chats, sourceChatNames: [], selection });
  if (plan.inject.length === 0) {
    return {
      ok: false, blob: null, count: 0, failed: [], reason: '库中没有可导出的聊天（或聊天类目已关闭）',
    };
  }
  logger.info(`聊天库导出：${describePlan(plan)}`);

  // 边读边写：把整库先读进内存再打包，会在 GB 级库上炸 —— 一条一条来，峰值只有单条聊天那么大
  const failed = [];
  let written = 0;
  const writer = await io.createWriter(undefined, { level: compressionLevel });
  await writer.add('settings.json', '{}'); // 最小 ST 摊平源包的布局锚点（ST 判据之一）
  for (const item of plan.inject) {
    if (signal?.aborted) {
      try { await writer.abort?.(); } catch { /* 收尾失败不改变结论 */ }
      return { ok: false, blob: null, count: written, failed, reason: 'aborted' };
    }
    // eslint-disable-next-line no-await-in-loop —— 逐条串行是刻意的（单条可能很大，且要能随时中止）
    const read = await readLibraryChatAsJsonl(item.ref, { signal });
    if (read.ok) {
      await writer.add(item.hubPath, read.text);
      written += 1;
      onProgress?.(written, plan.inject.length);
    } else {
      failed.push({ fileName: item.fileName, reason: read.reason });
    }
  }
  if (written === 0) {
    try { await writer.abort?.(); } catch { /* 已在失败路径 */ }
    return {
      ok: false, blob: null, count: 0, failed,
      reason: `全部 ${plan.inject.length} 条导出失败（首因：${failed[0]?.reason}）`,
    };
  }

  const dest = await writer.close();
  const baseBlob = await dest.getData();

  const { resultBlob } = await runConversionTask({
    source: baseBlob,
    target,
    options: { compressionLevel, selection },
  });

  logger.success(`聊天库导出完成：${written} 条聊天 → ${target.toUpperCase()} 目标包`
    + (failed.length ? `（另有 ${failed.length} 条导出失败）` : ''));
  return { ok: true, blob: resultBlob, count: written, failed, reason: '' };
}

/** 从包里挑出「该入库的聊天条目」的名字（排除备份特征与隐藏容器） */
function pickChatEntries(entryNames) {
  const picked = [];
  for (const raw of entryNames || []) {
    if (!raw || typeof raw !== 'string') continue;
    const norm = raw.replace(/\\/g, '/');
    if (!isChatLikePath(norm)) continue;
    if (!/\.jsonl$/i.test(norm)) continue; // 伴生文件（.luker-state.chat_sync.json 等）不是聊天
    if (isBackupChatOrSnapshot(norm)) continue;
    const base = norm.slice(norm.lastIndexOf('/') + 1);
    if (base.startsWith(HIDDEN_LIBRARY_PREFIX)) continue;
    picked.push({ entryName: norm, fileName: base });
  }
  return picked;
}

/**
 * 还原**之后**：把包里的聊天录入库。
 *
 * 为什么需要这一步：纯库模式**读库不读盘**，还原只把 jsonl 写到磁盘 ⇒ 用户在酒馆里
 * 一条都看不到，而「恢复完成」的读数是绿的（静默假成功）。
 *
 * 纪律：
 *  - 未检测到聊天库 ⇒ 完全静默（默认路径零变化）；
 *  - 有库但未提供 `import` 能力 ⇒ **一条可操作提示**（引导用户走插件弹窗的「转库」），
 *    且只在**包内确有聊天**时才提示，不刷无意义的噪音；
 *  - 单条失败不阻断其余，最终给出「成功 N / 失败 M」读数；
 *  - **不删除任何东西**（契约要求供给侧只做合并）。
 *
 * @param {Blob|File|string} zipBlob 刚还原过的包
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {function(number, number, string): void} [options.onProgress]
 * @param {object} [options.io=zipIo]
 * @returns {Promise<{skipped: string, attempted: number, imported: number, failed: Array<{fileName: string, reason: string}>}>}
 */
export async function importRestoredChatsIntoLibrary(zipBlob, {
  signal, onProgress, io = zipIo,
} = {}) {
  const result = { skipped: '', attempted: 0, imported: 0, failed: [] };
  const probe = probeChatStore();
  // 没装聊天库 ⇒ 静默（这是默认路径）
  if (!probe.present) { result.skipped = 'no-chat-store'; return result; }

  // 先看包里有没有聊天：没有就什么都不做（不为空包刷提示）
  const reader = await io.openReader(zipBlob);
  const picked = [];
  try {
    for await (const entry of reader.entries()) {
      if (entry.isDirectory) { entry.skip?.(); continue; }
      const hit = pickChatEntries([entry.fileName])[0];
      if (hit) picked.push({ ...hit, read: () => entry.read() });
      else entry.skip?.();
    }
    if (picked.length === 0) { result.skipped = 'no-chats-in-pack'; return result; }
    result.attempted = picked.length;

    if (!probe.canImport) {
      result.skipped = 'import-unsupported';
      logger.warn(`包内有 ${picked.length} 条聊天，但聊天库（模式 ${probe.mode}）未提供入库接入 API ⇒ `
        + '这些聊天已落到磁盘；若处于纯库模式，请在插件弹窗用「转库」把它们录入数据库');
      return result;
    }

    // 逐条「读一条 → 入一条」：整包读进内存会在 GB 级包上炸（恢复的包可能就是那么大）
    let done = 0;
    for (const item of picked) {
      if (signal?.aborted) { result.skipped = 'aborted'; return result; }
      // eslint-disable-next-line no-await-in-loop —— 逐条是刻意的：单条可能很大，且要能随时中止
      const bytes = await item.read();
      const one = await importChatsToLibrary(
        [{ fileName: item.fileName, jsonl: new TextDecoder('utf-8').decode(bytes) }],
        { signal },
      );
      result.imported += one.imported;
      result.failed.push(...one.failed);
      done += 1;
      onProgress?.(done, picked.length, item.fileName);
    }
    return result;
  } finally {
    try { await reader.close(); } catch { /* 关闭失败不改变结论 */ }
  }
}
