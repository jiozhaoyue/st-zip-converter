import { logger } from '../core/logger.js';

/**
 * 聊天库桥 —— 与「把聊天收进数据库的插件」（当前已知实现：ChatFilesys）打交道的**唯一落点**。
 *
 * ## 为什么需要它
 *
 * 纯数据库模式下磁盘上**没有** jsonl（存量入库后源文件被删、只在导出时生成），
 * 而转换器的聊天来源只有源包里的 `chats/**` ⇒ 打包会**静默丢掉全部聊天记录**；
 * 反向还原同样断：文件落到磁盘而纯库模式读库不读盘（见本任务 `prd.md` Goal）。
 *
 * ## 分层纪律
 *
 * 平台/插件差异一律收敛在本文件（`L0-9`），`core/` 只接纯逻辑（`pack-inject.js`）与纯 IO
 * （`zip-augment.js`）。**适配器 + 特性检测 + 静默降级**（`L0-11` / `L1-MR-1`）：
 * 没有这个 API 时，全仓行为与日志**逐字节不变**。
 *
 * ## 契约（`ChatFilesysApi` v1）
 *
 * ```js
 * globalThis.ChatFilesysApi = Object.freeze({
 *   apiVersion: 1,
 *   capabilities: { list, export, import },   // 三个布尔，能力自述
 *   mode(),                                   // 'off' | 'pure' | 'mirror'（同步、零副作用）
 *   listChats(),                              // → [{ fileName, chatName?, avatarUrl?, isGroup? }]（不含正文）
 *   exportChat({ avatarUrl, fileName }),      // → 标准 jsonl 文本
 *   importChat({ avatarUrl, fileName, jsonl, sourceLabel }), // → { ok, reason?, branchId? }
 * });
 * ```
 *
 * 供给侧硬约束（**只读 + 追加**）：`importChat` 只做指纹合并，**绝不删除任何源**；
 * 不向外部暴露任何删除/覆盖能力；失败必须可判（`{ok:false, reason}` 或 reject）。
 * 契约条文见 `.trellis/spec/frontend/chat-store-seam.md`。
 *
 * ## 有界等待（`L1-MR-7`）
 *
 * 外部插件的实现质量不可控，任何一次调用都可能**永不 settle**。故每个调用都套超时：
 * 超时 ⇒ 记 warn + 归一为失败，**绝不挂死转换主路径**。
 *
 * @module ui/chat-store-bridge
 */

/** 外部 API 的全局键（唯一探测点） */
export const CHAT_STORE_API_KEY = 'ChatFilesysApi';

/** 本消费侧支持的契约上限；供给方 `apiVersion` 更高视为「形状未知」⇒ 整体不可用 */
export const SUPPORTED_API_VERSION = 1;

/** 单次外部调用的默认上限（毫秒）。库可能很大，导出单条给得宽一些 */
export const DEFAULT_LIST_TIMEOUT_MS = 8_000;
export const DEFAULT_EXPORT_TIMEOUT_MS = 20_000;
export const DEFAULT_IMPORT_TIMEOUT_MS = 30_000;

/** 超时哨兵（与真实返回值区分；不抛异常，免得与「供给方自己 reject」混为一谈） */
const TIMED_OUT = Symbol('chat-store-timeout');

/** 上次读数快照（调试出口用；含原因文案，不含任何路径/凭据） */
const state = {
  lastReason: '',
  lastListCount: -1,
  lastExportOk: 0,
  lastExportFailed: 0,
  lastImportOk: 0,
  lastImportFailed: 0,
};

/** 记录一条原因（调试出口可见），并同步落日志 */
function note(reason, level = 'warn', message = '') {
  state.lastReason = String(reason || '');
  if (message) logger[level](message);
}

/**
 * 取外部 API 对象并做形状校验。
 * @returns {{api: object, apiVersion: number} | {api: null, apiVersion: 0}}
 */
function resolveApi() {
  let api = null;
  try {
    api = globalThis?.[CHAT_STORE_API_KEY] || null;
  } catch {
    api = null;
  }
  if (!api || typeof api !== 'object') return { api: null, apiVersion: 0 };
  let version = 0;
  try {
    version = Number(api.apiVersion);
  } catch {
    version = 0;
  }
  if (!Number.isFinite(version) || version < 1) return { api: null, apiVersion: 0 };
  if (version > SUPPORTED_API_VERSION) {
    // 高版本契约形状未知：宁可不接，也不猜
    return { api: null, apiVersion: version };
  }
  return { api, apiVersion: version };
}

/** 读一个能力位（缺省视为 false；能力自述不可信时以成员存在性兜底） */
function capabilityOf(api, key, memberName) {
  let declared = false;
  try {
    declared = api?.capabilities?.[key] === true;
  } catch {
    declared = false;
  }
  const hasMember = typeof api?.[memberName] === 'function';
  return declared && hasMember;
}

/** 读模式（同步、零副作用；抛异常 ⇒ 'unknown'） */
function modeOf(api) {
  if (typeof api?.mode !== 'function') return 'unknown';
  try {
    const m = api.mode();
    return typeof m === 'string' && m ? m : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 特性检测（**同步、零 IO、永不抛**）。
 * @returns {{present: boolean, apiVersion: number, mode: string, canList: boolean, canExport: boolean, canImport: boolean, reason: string}}
 */
export function probeChatStore() {
  const { api, apiVersion } = resolveApi();
  if (!api) {
    const reason = apiVersion > SUPPORTED_API_VERSION
      ? `契约版本 ${apiVersion} 高于本端支持的 ${SUPPORTED_API_VERSION}（形状未知）`
      : '未检测到聊天库接入 API';
    return Object.freeze({
      present: false, apiVersion, mode: 'unknown',
      canList: false, canExport: false, canImport: false, reason,
    });
  }
  return Object.freeze({
    present: true,
    apiVersion,
    mode: modeOf(api),
    canList: capabilityOf(api, 'list', 'listChats'),
    canExport: capabilityOf(api, 'export', 'exportChat'),
    canImport: capabilityOf(api, 'import', 'importChat'),
    reason: '',
  });
}

/**
 * 有界等待一个可能永不 settle 的调用。
 * @param {Promise<any>} promise
 * @param {number} timeoutMs
 * @returns {Promise<any|symbol>} 超时返回 `TIMED_OUT`
 */
async function withTimeout(promise, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs); }),
    ]);
  } finally {
    // 必须清掉：否则一个 8s 的定时器会把 Node 测试进程钉在事件循环里
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * 列出库中聊天索引（不含正文）。
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ok: boolean, chats: Array<object>, reason: string}>}
 */
export async function listLibraryChats({ timeoutMs = DEFAULT_LIST_TIMEOUT_MS, signal } = {}) {
  const probe = probeChatStore();
  if (!probe.present || !probe.canList) {
    return { ok: false, chats: [], reason: probe.reason || 'list 能力不可用' };
  }
  if (signal?.aborted) return { ok: false, chats: [], reason: 'aborted' };

  const { api } = resolveApi();
  try {
    const res = await withTimeout(Promise.resolve().then(() => api.listChats()), timeoutMs);
    if (res === TIMED_OUT) {
      note('listChats 超时', 'warn', `聊天库 listChats 超时（${timeoutMs}ms），本次按「不可用」处理`);
      return { ok: false, chats: [], reason: `timeout(${timeoutMs}ms)` };
    }
    const chats = Array.isArray(res) ? res : (Array.isArray(res?.chats) ? res.chats : []);
    state.lastListCount = chats.length;
    state.lastReason = '';
    return { ok: true, chats, reason: '' };
  } catch (err) {
    const reason = err?.message || String(err);
    note(reason, 'warn', `聊天库 listChats 调用失败：${reason}`);
    return { ok: false, chats: [], reason };
  }
}

/**
 * 取一条聊天的标准 jsonl 文本。
 * @param {object} ref 库索引项（至少含 `fileName`）
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ok: boolean, text: string, reason: string}>}
 */
export async function readLibraryChatAsJsonl(ref, {
  timeoutMs = DEFAULT_EXPORT_TIMEOUT_MS, signal,
} = {}) {
  const probe = probeChatStore();
  if (!probe.present || !probe.canExport) {
    return { ok: false, text: '', reason: probe.reason || 'export 能力不可用' };
  }
  if (signal?.aborted) return { ok: false, text: '', reason: 'aborted' };
  const fileName = ref?.fileName ?? ref?.file_name ?? ref?.name;
  if (typeof fileName !== 'string' || !fileName.trim()) {
    return { ok: false, text: '', reason: '索引项缺 fileName' };
  }

  const { api } = resolveApi();
  try {
    const arg = { avatarUrl: ref?.avatarUrl ?? null, fileName: fileName.trim() };
    const res = await withTimeout(Promise.resolve().then(() => api.exportChat(arg)), timeoutMs);
    if (res === TIMED_OUT) {
      state.lastExportFailed += 1;
      note('exportChat 超时', 'warn', `聊天库导出「${fileName}」超时（${timeoutMs}ms），跳过该条`);
      return { ok: false, text: '', reason: `timeout(${timeoutMs}ms)` };
    }
    const text = typeof res === 'string' ? res : (typeof res?.jsonl === 'string' ? res.jsonl : '');
    if (!text) {
      state.lastExportFailed += 1;
      note('exportChat 返回空', 'warn', `聊天库导出「${fileName}」返回空内容，跳过该条`);
      return { ok: false, text: '', reason: 'empty' };
    }
    state.lastExportOk += 1;
    return { ok: true, text, reason: '' };
  } catch (err) {
    const reason = err?.message || String(err);
    state.lastExportFailed += 1;
    note(reason, 'warn', `聊天库导出「${fileName}」失败：${reason}`);
    return { ok: false, text: '', reason };
  }
}

/**
 * 把标准 jsonl 收进库（**只合并、不删源**；供给方契约要求幂等）。
 *
 * 单条失败**不阻断**其余条目（与 ChatFilesys 导入旅程的失败安全同向）。
 *
 * @param {Array<{fileName: string, jsonl: string, avatarUrl?: string, isGroup?: boolean}>} items
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @param {function(number, number, string): void} [options.onProgress] (已完成, 总数, 当前落盘名)
 * @returns {Promise<{ok: boolean, imported: number, failed: Array<{fileName: string, reason: string}>, unsupported: boolean, reason: string}>}
 */
export async function importChatsToLibrary(items, {
  timeoutMs = DEFAULT_IMPORT_TIMEOUT_MS, signal, onProgress,
} = {}) {
  const list = Array.isArray(items) ? items : [];
  const probe = probeChatStore();
  if (!probe.present || !probe.canImport) {
    return {
      ok: false, imported: 0, failed: [], unsupported: true,
      reason: probe.reason || 'import 能力不可用',
    };
  }

  const { api } = resolveApi();
  const failed = [];
  let imported = 0;
  let done = 0;
  for (const item of list) {
    if (signal?.aborted) {
      failed.push({ fileName: item?.fileName || '', reason: 'aborted' });
      break;
    }
    const fileName = item?.fileName;
    if (typeof fileName !== 'string' || !fileName.trim()) {
      failed.push({ fileName: '', reason: '缺 fileName' });
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop —— 逐条串行是刻意的：库写入有锁与快照语义
      const res = await withTimeout(
        Promise.resolve().then(() => api.importChat({
          avatarUrl: item.avatarUrl ?? null,
          fileName: fileName.trim(),
          jsonl: item.jsonl,
          sourceLabel: item.sourceLabel || 'st-zip-converter',
        })),
        timeoutMs,
      );
      if (res === TIMED_OUT) {
        failed.push({ fileName, reason: `timeout(${timeoutMs}ms)` });
      } else if (res && res.ok === false) {
        failed.push({ fileName, reason: res.reason || 'unknown' });
      } else {
        imported += 1;
      }
    } catch (err) {
      failed.push({ fileName, reason: err?.message || String(err) });
    }
    done += 1;
    onProgress?.(done, list.length, fileName);
  }

  state.lastImportOk += imported;
  state.lastImportFailed += failed.length;
  if (failed.length > 0) {
    note(`importChat 失败 ${failed.length} 条`, 'warn',
      `聊天入库：成功 ${imported} 条，失败 ${failed.length} 条（首因：${failed[0]?.reason}）`);
  } else if (imported > 0) {
    logger.success(`聊天入库：成功 ${imported} 条`);
    state.lastReason = '';
  }
  return { ok: failed.length === 0, imported, failed, unsupported: false, reason: '' };
}

/**
 * 只读探针快照（**冻结**；供 E2E 断言与诊断）。
 *
 * 只含**能力枚举 + 计数 + 原因文案**：不含 CSRF token / user handle / 任何文件路径
 * （与 `getRestoreProbe` 同一纪律，见 `index.js:344` 的三条约束）。
 * @returns {Readonly<object>}
 */
export function getChatStoreProbe() {
  const probe = probeChatStore();
  return Object.freeze({
    present: probe.present,
    apiVersion: probe.apiVersion,
    mode: probe.mode,
    canList: probe.canList,
    canExport: probe.canExport,
    canImport: probe.canImport,
    lastReason: state.lastReason,
    lastListCount: state.lastListCount,
    lastExportOk: state.lastExportOk,
    lastExportFailed: state.lastExportFailed,
    lastImportOk: state.lastImportOk,
    lastImportFailed: state.lastImportFailed,
  });
}

/** 仅供单测：重置内部读数（生产路径不调用） */
export function __resetChatStoreStateForTest() {
  state.lastReason = '';
  state.lastListCount = -1;
  state.lastExportOk = 0;
  state.lastExportFailed = 0;
  state.lastImportOk = 0;
  state.lastImportFailed = 0;
}
