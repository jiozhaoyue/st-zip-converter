/**
 * st-zip-converter 核心控制器 (ESM)
 * 全平台跨酒馆数据包工作站：
 * 1. 宿主酒馆直接细粒度导出 (对齐 ST / Luker 分类) 与直出跨平台目标格式
 * 2. 外部数据包互转、动作规划完全扫描与单项穿透
 * 3. 闭环一键还原/写入宿主 (支持合并写入与覆盖写入)
 * 4. 底部实时抽屉式日志控制台与全屏幕/移动端极致响应式适配
 */

import { runConversionTask, runPlanTask } from './src/core/worker-client.js';
import { logger } from './src/core/logger.js';
import { setupLogConsole } from './src/ui/log-console.js';
import { escapeHtml, trustedStaticMarkup } from './src/ui/escape.js';
import {
  setupCategoryFilter,
  renderCategoryStats,
  getSelectionState,
  setSelectionState,
  getExcludedPaths,
  setExcludedPaths,
  selectAll as categorySelectAll,
  resetCategoryFilter,
} from './src/ui/category-filter.js';
import {
  saveFile,
  getFile,
  saveWorkspaceState,
  loadWorkspaceState,
  isStorageSupported,
  listStoredFiles,
} from './src/storage/db.js';
import { generateDeltaArchive } from './src/core/delta.js';
import { buildExtensionManifest } from './src/core/extension-manifest.js';
import { TaskManager, TASK_STATES } from './src/core/task-manager.js';
import { BATCH_STATUS, ITEM_STATUS, createRestoreBatch } from './src/core/restore-batch.js';
import { renderStashList, filterStashFiles } from './src/ui/stash-list.js';
import { ExportQueue, renderExportQueue } from './src/ui/export-queue.js';
import { initTaskControls } from './src/ui/task-controls.js';
import { createCheckpointAdapter } from './src/storage/authority-store.js';
import { renderUsageDashboard } from './src/ui/usage-dashboard.js';
import { resolveFilename, previewFilename, DEFAULT_FILENAME_TEMPLATE } from './src/core/filename-template.js';
import {
  detectHost,
  verifyHostPlatform,
  fetchHostBackup,
  restoreToHost,
  isRestoreInFlight,
  cancelRestoreInFlight,
  isRestoreUnsupported,
  getRestoreUnsupportedReason,
  getRestoreProbe,
  alertDialog,
  confirmDialog,
  hostSelectionCapability,
  isStorageInspectorAvailable,
  openStorageInspector,
  getHandle,
  registerMenuButton,
  mountNativeBackupButton,
  mountLukerBackupManagerButton,
  mountSettingsDrawer,
  setupDrawerToggles,
  hostLayoutCode,
  resolveTargetLayout,
  opfsHandleToFile,
  opfsTmpCleanup,
  supportsOpfs,
  FULL_SELECTION,
} from './src/ui/host-bridge.js';
import { UPLOAD_TIMEOUT_MS } from './src/ui/fetch-bounds.js';
import { setupFileDrop } from './src/ui/file-drop.js';
import { createViewController } from './src/ui/view.js';
import { getWorkbenchHtml } from './src/ui/workbench-template.js';
import { splitArchiveEntries, normalizeSplitMb } from './src/core/splitter.js';
import { zipIo } from './src/core/zip-io.js';

function formatTimestamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/* ────────────────────────── 任务类型判据（唯一） ────────────────────────── */

/**
 * 任务 id 前缀 ↔ 类型。**这是全仓唯一的任务类型判据** ——
 * 任何地方都不得再写 `id.startsWith('fetch-')` 这类硬编码（同一判据两处实现 = 立即漂移）。
 *
 * 加一条新任务路径时：只在此处加类型 + 在 `RESUMABLE_HANDLERS` 加执行体。
 * （R-16 之前只有宿主拉取接了状态机，转换/写回都是"读得到但续不了"，
 * 根因之一就是判据写成了散落的 `startsWith`。）
 */
export const TASK_KINDS = Object.freeze({
  FETCH: 'fetch',
  CONVERT: 'convert',
  CONVERT_BATCH: 'convert-batch',
  RESTORE: 'restore',
});

/** 类型 → id 前缀 */
export const TASK_PREFIX = Object.freeze({
  [TASK_KINDS.FETCH]: 'fetch-',
  [TASK_KINDS.CONVERT]: 'convert-',
  [TASK_KINDS.CONVERT_BATCH]: 'convert-batch-',
  [TASK_KINDS.RESTORE]: 'restore-',
});

/**
 * 从任务 id 反解类型。
 *
 * ⚠️ **必须按前缀长度降序匹配**：`convert-batch-` 与 `convert-` 是**前缀重叠**的，
 * 按声明顺序遍历会让 `convert-batch-<ts>` 被 `convert-` 先吃掉 ⇒ **静默降级成单包语义**
 * （断点字段读不到、恢复走错执行体，且不报错）。
 * 故此处**显式排序**，**不依赖对象字面量的插入顺序** —— 依赖插入顺序的写法
 * 会在有人重排常量时无声失效。
 *
 * @param {string} id
 * @returns {'fetch'|'convert'|'convert-batch'|'restore'|null} 未知 id 返回 null（调用方须 warn，不得静默）
 */
export function taskKindOf(id) {
  if (typeof id !== 'string') return null;
  const entries = Object.entries(TASK_PREFIX).sort((a, b) => b[1].length - a[1].length);
  for (const [kind, prefix] of entries) {
    if (id.startsWith(prefix)) return kind;
  }
  return null;
}

/* ────────────────────── 断点清单节流（单包/批量共用） ────────────────────── */

// 与 `src/core/task-manager.js:23-25` **同源**的节流窗口 —— 不另立一套数字，
// 否则「什么时候落盘」在两处会有两种答案。
const CHECKPOINT_EVERY_ENTRIES = 64;
const CHECKPOINT_EVERY_MS = 2000;

/**
 * 造一个断点清单节流器（转换路径专用）。
 *
 * **为什么必须节流**：`Object.fromEntries(doneEntries)` 是 O(n)。若每个进度回调都建一次对象，
 * n 个条目就是 O(n²) 次属性分配 + 大量短命对象（8683 条目的包 ≈ 7500 万次分配），
 * 制造 GC 压力与长任务（`L1-MR-9` 的相邻风险）。
 * **未到窗口时不建对象** —— 这是与「只在 adapter.save 处节流」的关键差别
 * （后者仍会每 tick materialize 一次）。
 *
 * ⚠️ **首次调用一定落盘**（`lastFlushAt` 初值 0 ⇒ 时间条件立刻成立）—— 这是**载荷属性，别"修掉"**：
 * `TaskManager.pause()` 落盘的是**内存里的 `task.checkpoint`**，而它只在 `onCheckpoint`
 * **被调用时**才更新 ⇒ 若首次调用被节流掉，「任务刚开始就暂停」会因 `checkpoint === null`
 * 而 `resume()` 返回 null ⇒ **无法续传**（正是 R-16 的形态）。
 * 该行为与 `src/core/task-manager.js` 自身的节流一致（其时间条件同样在首调用成立）。
 *
 * **方向纪律（不可颠倒）**：快照**只含已完成条目**。滞后窗口 ≤63 条 ⇒ 续传时这 ≤63 条被**重做**（安全）；
 * 若让快照**超前**（把未完成的条目算进去）⇒ 续传时被**错误跳过** ⇒ **产物缺条目**。
 *
 * **必须挂在 `onProgress` 上**：`runConversionTask` 的 `onEntryDone` 只在**主线程降级**分支触发，
 * Worker 路径（= 真浏览器）**永不触发**（见 `src/core/worker-client.js:89` 的 JSDoc）
 * ⇒ 只挂 `onEntryDone` 会让断点在浏览器里永不落盘、`npm test` 却全绿。
 *
 * @param {function} onCheckpoint TaskManager.start() 返回的落盘句柄
 * @param {Map<string, number>} doneEntries 已完成条目（**累积中**，本函数只读它的 size 与内容）
 * @returns {function({force?: boolean, totalEntries?: number, bytes?: number}): void}
 */
export function createCheckpointThrottle(onCheckpoint, doneEntries, {
  everyEntries = CHECKPOINT_EVERY_ENTRIES,
  everyMs = CHECKPOINT_EVERY_MS,
} = {}) {
  let lastFlushAt = 0;
  let lastFlushedSize = -1;
  return function maybeCheckpoint({ force = false, totalEntries = 0, bytes = 0 } = {}) {
    const now = Date.now();
    const due = force
      || doneEntries.size - lastFlushedSize >= everyEntries
      || now - lastFlushAt >= everyMs;
    if (!due) return;
    lastFlushedSize = doneEntries.size;
    lastFlushAt = now;
    void onCheckpoint(
      { doneEntries: Object.fromEntries(doneEntries), totalEntries },
      { bytes, force },
    );
  };
}

/* ────────────────── 续传命中的可观测面 ────────────────── */

/**
 * 「本轮沿用了断点」的提示串（`> 0` 才给，避免正常转换被噪音污染）。
 *
 * ⚠️ 字段名是 **`report.totals.resumed`**（计数；`report.resumed` 是命中条目**名单**）。
 * 仓里曾有注释与用例名写作 `resumedCount` —— **该字段从来不存在**（全仓零赋值零读取）。
 * 续传是否真的生效必须**可观测**（E2E 要断言它），故把它显式渲染进完成文案与日志。
 *
 * @param {object} report `convert()` 的 Report（或其 toJSON()）
 * @returns {string} 形如「（沿用断点跳过 2 项）」，无命中时为空串
 */
export function resumedNote(report) {
  const n = report?.totals?.resumed ?? 0;
  return n > 0 ? `（沿用断点跳过 ${n} 项）` : '';
}

/* ────────────────── 转换收尾出口的判定（单一入口） ────────────────── */

/**
 * 转换路径的**收尾出口判定**：给定错误与任务记录，决定走哪个出口。
 *
 * ⚠️ **为什么必须抽出来**：`design.md` 说这是"最容易写错的一处" ——
 * 暂停是**正常用户操作**，若误走 `fail()`，`fail` 会 `adapter.remove(id)`
 * 清掉**刚落盘的断点** ⇒ 续传能力当场失效，且 UI 显示"失败"。
 * 内联在 `main()` 的 catch 里时这段逻辑**单测够不着**（`main()` 需要 DOM），
 * 抽成纯函数后「暂停**绝不**走 fail」这条才成为可断言契约。
 *
 * 「静默」的正确含义：**不调 `fail()`、不 `logger.error`、不显示"失败"**；
 * **不是**"什么都不做" —— 暂停必须**显示暂停态**（`showPaused` + `setPausedCheckpoint`）。
 *
 * @param {object} p
 * @param {Error} p.err 执行体抛出的错误
 * @param {object|null} p.record `taskManager.get(taskId)` 的结果
 * @returns {{action: 'fail'|'paused'|'aborted'|'none'}}
 */
export function convertExitForAbort({ err, record }) {
  if (err?.name !== 'AbortError') return { action: 'fail' };
  if (record?.state === TASK_STATES.PAUSED) return { action: 'paused' };
  if (record?.state === TASK_STATES.ABORTED) return { action: 'aborted' };
  return { action: 'none' };
}

/* ────────────────── 转换路径的进度记账（单一入口） ────────────────── */

/**
 * 造「转换进度回调核」：**唯一**允许挂断点落盘的地方（单包与批量共用，避免两处漂移）。
 *
 * ⚠️ **为什么必须有这个函数**：落盘**只能**挂 `onProgress`。
 * `runConversionTask` 的 `onEntryDone` 是顶层参数，只被传进**主线程降级分支**；
 * Worker 分支走 `postMessage`，**函数过不了结构化克隆** ⇒ **真浏览器里永不触发**
 * （见 `src/core/worker-client.js:89` 的 JSDoc：*"主线程路径直通；Worker 路径由 onProgress 累积"*）。
 * 若把落盘改挂到 `onEntryDone` 上：断点在**浏览器里永不落盘** ⇒ 暂停后无法续传，
 * 而 `npm test` 全绿（Vitest 无 `Worker`，走主线程路径，`onEntryDone` 会触发）**⇒ 缺陷被测试掩盖**。
 *
 * 所以这条契约被拆成可断言的形式：本函数的单测**只调 `onProgress` 一种签名**（模拟 Worker 路径），
 * 断言断点仍然被喂到。「是否真的接在 `onProgress` 上」这一层由 **E2E（真浏览器）** 守 —— 两者缺一不可。
 *
 * @param {object} p
 * @param {Map<string, number>} p.doneEntries 已完成条目（**就地累积**，供续传时命中即跳过）
 * @param {function} p.maybeCheckpoint 断点节流器（`createCheckpointThrottle` 的产物）
 * @returns {function(number, number, string, number|undefined): void}
 */
export function attachConversionProgress({ doneEntries, maybeCheckpoint }) {
  return function trackConversionProgress(cur, total, name, crc32) {
    // 只做 Map.set + 节流判定，**不碰 DOM** —— 渲染由调用方在下一行做（已由 view 侧合帧，L1-MR-9）
    if (name && crc32 != null) doneEntries.set(name, crc32);
    maybeCheckpoint({ force: total > 0 && cur === total, totalEntries: total });
  };
}

/* ────────────────── 批量转换的纯编排核（可 Node 直测） ────────────────── */

/**
 * 批量子项循环核：**纯编排**（无 DOM / 存储 / 任务管理器依赖），故可在 Node 下直测。
 * `main()` 内的接线代码够不着测试，把语义放这里才对得上「纯逻辑必须可单测」的规格要求。
 *
 * 被测试锁定的两条语义：
 * 1. **从 `startIndex` 开始**（子项游标续传：已完成的子项不重跑）；
 * 2. **`AbortError` 必须终止循环** —— 其余错误"记日志继续"是既有语义（单个坏包不该打断整批），
 *    但暂停/中止是**用户意图**，必须是"停"：否则用户点了暂停，界面显示已暂停，
 *    后台却还在往下跑后续子项，且断点游标与实际进度脱节。
 *
 * @param {object} p
 * @param {Array<*>} p.items 子项列表（**下标即游标**）
 * @param {number} [p.startIndex=0] 下一个待处理的子项下标
 * @param {function(*, number): Promise<void>} p.convertItem (item, index) => Promise
 * @param {function(Error, number): void} [p.onItemError] 非中止错误的回调（**不终止循环**）
 * @returns {Promise<{processed: number, aborted: boolean, error: Error|null}>}
 */
export async function runBatchItems({ items, startIndex = 0, convertItem, onItemError }) {
  let processed = 0;
  for (let i = startIndex; i < items.length; i += 1) {
    try {
      await convertItem(items[i], i);
      processed += 1;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        // 原样上抛中止信号：状态迁移（PAUSED / ABORTED）与 UI 由调用方完成
        return { processed, aborted: true, error: err };
      }
      if (typeof onItemError === 'function') onItemError(err, i);
    }
  }
  return { processed, aborted: false, error: null };
}

/**
 * 批量续传的**可验证前提**（R-16 / U-6）：断点说「前 k 个子项已完成」，
 * 但那 k 个产物是 `ephemeral`（只在内存 `ExportQueue.items` 里），断点却是持久化的
 * ⇒ 两者可能不一致（产物被删除、被清空、或页面重载过）。
 *
 * 判据刻意取**真正依赖的那个东西**（产物还在不在），而**不是**「会话是否同一个」这类代理量 ——
 * 代理量会在「同会话但用户手动删了产物」时误判为可续。
 *
 * @param {object} p
 * @param {number} p.expectedOutputs 断点记录的已完成产物数
 * @param {number} p.productsPresent 内存队列里该 taskId 的产物数
 * @returns {{valid: boolean, reason: string}}
 */
export function batchResumeVerdict({ expectedOutputs, productsPresent }) {
  if (expectedOutputs === productsPresent) return { valid: true, reason: '' };
  return {
    valid: false,
    reason: `断点记 ${expectedOutputs} 个已完成产物，内存队列里只有 ${productsPresent} 个`
      + '（产物已不在内存：可能被移除，或页面已重载过）',
  };
}

/**
 * 为**指定子项**播种条目级断点。
 *
 * ⚠️ 断点里的 `doneEntries` **只对断点游标指向的那个子项有效**：
 * 不同源包可能含**同名条目**（`characters/X.png`、`settings.json` 几乎必然重名），
 * 跨子项复用 crc 清单会让第二个子项**错误跳过**那些条目 ⇒ **产物缺条目**。
 *
 * @param {object} p
 * @param {object|null} p.checkpoint 断点清单
 * @param {number} p.index 当前子项下标
 * @param {number} p.startIndex 断点游标
 * @returns {Map<string, number>}
 */
export function seedEntriesFor({ checkpoint, index, startIndex }) {
  if (!checkpoint || index !== startIndex || !checkpoint.doneEntries) return new Map();
  return new Map(Object.entries(checkpoint.doneEntries));
}

/**
 * 挂载只读调试探针 `window.__stZipConverterDebug`（R-19）。
 *
 * **规格依据**：`.trellis/spec/frontend/hook-guidelines.md` 的「无全局命名空间」一节明文写着
 * 「若后续确需自动化钩子，应新增**显式命名**的接缝**并在本节登记**，**不要**恢复隐式全局对象」
 * ⇒ 本挂载走的是规格**已预留**的那条路，并已在同节完成登记。
 *
 * **三条约束**（`design.md` D3.2，违约即缺陷）：
 * 1. **只读**：命名空间对象 `Object.freeze`，且 `getRestoreProbe()` 返回的**快照**本身也冻结
 *    —— 防伪能力主要来自后者：E2E 拿到的 `capability` 改不动，断言才有判别力；
 * 2. **不覆盖已占用者**：宿主或别的扩展可能同名，已存在时**不覆盖**并 warn（静默覆盖会
 *    悄悄弄坏别人的对象）；
 * 3. **不泄漏**：只暴露**能力枚举 + 原因文案**，**不含** CSRF token / user handle / 文件路径
 *    （那些各有受控获取路径，不从这里漏出）。
 *
 * 导出面仅为了让单测能覆盖「已占用时不覆盖」这条分支（`test/restore-probe.test.js`）；
 * 生产路径由 `bootstrap()` 调用。
 */
export function mountDebugProbe() {
  if (typeof window === 'undefined') return;
  const DEBUG_KEY = '__stZipConverterDebug';
  if (Object.prototype.hasOwnProperty.call(window, DEBUG_KEY)) {
    logger.warn(`window.${DEBUG_KEY} 已被占用，跳过挂载（不覆盖既有对象）`);
    return;
  }
  window[DEBUG_KEY] = Object.freeze({
    getRestoreProbe,
  });
}

/**
 * 工作台初始化。**容器必须显式传入**（R6）。
 *
 * 原签名是 `main(appRoot = document.getElementById('app'))`：插件态下若宿主页面上存在
 * 任意第三方 `#app`，兜底会先命中它，整棵工作台挂进别人的容器。容器来源收敛为两条唯一路径：
 * 独立态 = `index.html` 的 `#app` 骨架；插件态 = `mountSettingsDrawer` 回调传入的抽屉 `#app`。
 * @param {HTMLElement|undefined} appRoot 承载工作台的容器元素
 */
async function main(appRoot) {
  const root = appRoot;
  if (!root) {
    logger.warn('main() 未收到容器元素，工作台不初始化（容器来源必须显式传入，不再做裸 #app 兜底）');
    return;
  }

  const host = detectHost();
  const view = createViewController();
  setupDrawerToggles(root);

  // 初始化底部实时日志抽屉（块二底部挂载点）
  const logConsole = setupLogConsole(document.getElementById('log-console-mount') || root);
  logger.info(`应用启动，运行模式: ${host.isPlugin ? host.platform.toUpperCase() + ' 扩展插件' : '独立 Web 模式'}`);

  let currentFile = null;
  let currentFileId = null;
  let currentFileHandle = 'default-user';
  let currentHostHandle = 'default-user';
  let lastConvertedBlob = null;

  // ── 动作按钮契约（用户裁决 8 + 「怎么解耦复用按钮」）─────────────────────
  // 三枚按钮对应两条并行流程，可同时可见：
  //   · 宿主拉取 → 转换 → 恢复（插件内一站式）
  //   · 上传暂存 → 清理 → 转换 / 导出（源码 webui 模式）
  // 可见性与可用性由本组函数**唯一**求值；禁止在业务分支里散落地写
  // btnXxx.disabled / btnXxx.style.display（历史上有 14 处分散写点）。
  let workbenchBusy = false;

  /**
   * 计算三枚动作按钮的可见性与可用性（纯函数）
   * @param {{isHost: boolean, hasSource: boolean, hasArtifact: boolean,
   *          isTaskRunning: boolean, isRestoreInFlight: boolean,
   *          isRestoreUnsupported: boolean}} s
   * @returns {{fetch: {visible: boolean, enabled: boolean},
   *            convert: {visible: boolean, enabled: boolean},
   *            restore: {visible: boolean, enabled: boolean}}}
   */
  function computeActionAvailability(s) {
    return {
      fetch: { visible: s.isHost, enabled: !s.isTaskRunning },
      convert: { visible: true, enabled: s.hasSource && !s.isTaskRunning },
      // 宿主无整包恢复能力（全部候选 404）时一并禁用：不留「点了必然失败」的按钮（R1.6）
      restore: {
        visible: s.isHost && s.hasArtifact,
        enabled: !s.isTaskRunning && !s.isRestoreInFlight && !s.isRestoreUnsupported,
      },
    };
  }

  /** 从当前工作台状态收集求值输入 */
  function collectActionState() {
    return {
      isHost: host.isPlugin,
      hasSource: !!currentFile,
      hasArtifact: !!lastConvertedBlob,
      isTaskRunning: workbenchBusy,
      isRestoreInFlight: isRestoreInFlight(),
      isRestoreUnsupported: isRestoreUnsupported(),
    };
  }

  /**
   * 三枚动作按钮状态的唯一应用点。
   * 用 getElementById 动态查询而非闭包变量：btnHostFetch 在本函数之后才声明，
   * 提前绑定会踩 TDZ。
   */
  function applyActionAvailability() {
    const a = computeActionAvailability(collectActionState());
    const apply = (el, spec) => {
      if (!el) return;
      el.style.display = spec.visible ? '' : 'none';
      el.disabled = !spec.enabled;
    };
    apply(document.getElementById('btn-convert'), a.convert);
    apply(document.getElementById('btn-host-fetch'), a.fetch);
    apply(document.getElementById('btn-restore-luker'), a.restore);
    // 宿主无恢复能力时把原因显式挂在按钮上（禁用而不是静默隐藏，用户可知为何不可用）
    const restoreBtn = document.getElementById('btn-restore-luker');
    if (restoreBtn) restoreBtn.title = isRestoreUnsupported() ? getRestoreUnsupportedReason() : '';
  }
  let isPlanning = false;
  let pendingRestoreFile = null;
  /** 非 null 即批量恢复上下文（与 `pendingRestoreFile` 互斥，同一模态复用） */
  let pendingRestoreBatch = null;
  /** 当前批量恢复编排器（`createRestoreBatch` 实例） */
  let activeBatch = null;
  /** 批量恢复最近一次状态快照（供待导出区渲染） */
  let lastBatchState = null;
  let currentBaseZip = null; // { name: string, blob: Blob, size: number }

  /**
   * 把目标选择器的**原始值**解析为**布局码**（`st|l|tt|pt`）。
   *
   * `native` 的语义是「当前宿主的原生格式」，必须经 `hostLayoutCode()` 归一
   * （`luker → l`，见 `src/ui/host-bridge.js` 的 `hostLayoutCode`）。
   *
   * ⚠️ **归一必须在所有取目标处统一做** —— 这正是本函数存在的理由。
   * 修前实际状况：只有「宿主拉取」路径（`handleHostExport` 内的
   * `selectedTarget === 'native' ? hostLayoutCode(...)`）与**文件名预览**做了归一，
   * 而 `refreshPlan` / `btnConvert` / `runBatchConversion`（现 `handleBatchConvert`）/ 扩展清单的 `targetLayout`
   * **把字符串 `'native'` 直接交给了计划器与转换器**。
   * 计划器的合成分支只认 `TARGETS.L` / `TARGETS.ST`（`src/core/plan-preview.js`），
   * `native` 不匹配任何分支 ⇒ 「宿主原生格式」退化成**原样直通**：
   * 在 ST 宿主上（源本就是 ST 布局）恰好等价、用户看不出差别；
   * 在 **Luker 宿主上选「宿主原生格式」**就会拿到**未经布局转换**的结果。
   *
   * @param {string} [raw] 选择器原始值（可能是 `native`）
   * @param {string} [fallback='l'] 选择器缺失时的缺省布局码
   * @returns {string} 布局码
   */
  function resolveTarget(raw, fallback = 'l') {
    return resolveTargetLayout(raw, host.platform, fallback);
  }

  // 实时生成文件名预览（统一目标格式选择器；native 选项经 hostLayoutCode 归一）
  function updateFilenamePreview() {
    const template = filenameTemplateInput?.value || DEFAULT_FILENAME_TEMPLATE;

    const extPreviewEl = document.getElementById('filename-preview');
    if (extPreviewEl) {
      const srcName = currentFile?.name || 'archive.zip';
      const target = resolveTarget(targetSelect ? targetSelect.value : 'pt', 'pt');
      const handle = currentFileHandle || currentHostHandle || 'default-user';
      extPreviewEl.textContent = previewFilename(template, {
        sourceName: srcName,
        target,
        handle,
        part: 'part1',
        category: 'all',
        mode: 'split',
      });
    }
  }

  // DOM 元素引用
  const envBadge = document.getElementById('env-badge');
  const hostUserBadge = document.getElementById('host-user-badge');
  const btnRestoreLuker = document.getElementById('btn-restore-luker');
  const targetSelect = document.getElementById('target-select');
  const btnConvert = document.getElementById('btn-convert');

  const usageDashboardEl = document.getElementById('usage-dashboard');
  const exportQueuePanel = document.getElementById('export-queue-panel');

  const includeBackupsCheck = document.getElementById('include-backups-check');
  const includeCacheCheck = document.getElementById('include-cache-check');
  const includePrivateCheck = document.getElementById('include-private-check');

  const compressionSelect = document.getElementById('compression-select');
  const filenameTemplateInput = document.getElementById('filename-template-input');
  const splitInput = document.getElementById('split-input');

  /**
   * 读取智能分包阈值（MB）。
   * 归一化逻辑（整数/最小值/非法输入）在 `src/core/splitter.js` 的纯函数里，
   * 此处仅做 DOM 取值，便于单测覆盖。
   * @returns {number} 0 表示不分卷
   */
  function parseSplitInputMb() {
    return normalizeSplitMb(splitInput ? splitInput.value : null);
  }

  // 还原模态弹窗元素
  const restoreModalOverlay = document.getElementById('restore-modal-overlay');
  const restoreModalDesc = document.getElementById('restore-modal-desc');
  const btnCancelRestore = document.getElementById('btn-cancel-restore');
  const btnConfirmRestore = document.getElementById('btn-confirm-restore');

  function getExtensionMode() {
    const checked = document.querySelector('input[name="extension-mode"]:checked');
    return checked ? checked.value : 'manifest';
  }

  /** Git 历史策略（keep|minimal|strip）。缺省 keep——与 PRD 裁决一致，保默认行为零变化。 */
  function getGitMode() {
    const checked = document.querySelector('input[name="git-mode"]:checked');
    return checked ? checked.value : 'keep';
  }

  /** 轻量清单模式整体不打包 .git，故 Git 策略组联动禁用（各档代价说明在 label 的 title 属性）。 */
  function syncGitModeAvailability() {
    const disabled = getExtensionMode() !== 'full';
    document.querySelectorAll('input[name="git-mode"]').forEach((el) => { el.disabled = disabled; });
  }

  function getKeepDevFiles() {
    const chk = document.getElementById('keep-dev-files-check');
    return chk ? chk.checked : false;
  }

  /**
   * 刷新各折叠区的摘要读数（状态读数，非说明文案）。
   * 用户裁决：每一类都可折叠，且标题栏须能判断当前状态，不必展开。
   */
  function updateFoldSummaries() {
    // 垃圾清理：勾选 = 打包该项，未勾选 = 已清理；「剔除原生资产」勾选即为已清理
    const cleanupEl = document.getElementById('fold-summary-cleanup');
    if (cleanupEl) {
      const items = [
        { id: 'include-backups-check', clearedWhenChecked: false },
        { id: 'include-cache-check', clearedWhenChecked: false },
        { id: 'include-private-check', clearedWhenChecked: false },
        { id: 'prune-builtin-check', clearedWhenChecked: true },
      ];
      const cleared = items.filter((it) => {
        const el = document.getElementById(it.id);
        if (!el) return false;
        return it.clearedWhenChecked ? el.checked : !el.checked;
      });
      cleanupEl.textContent = cleared.length === items.length
        ? '全部已清理'
        : `已清理 ${cleared.length}/${items.length}`;
    }

    const extEl = document.getElementById('fold-summary-extension');
    if (extEl) {
      // Git 策略只在「完整离线包」下生效，摘要必须同时体现这一点，避免用户以为勾了没反应。
      const gitLabels = { keep: 'Git 原样', minimal: 'Git 瘦身', strip: 'Git 剔除' };
      extEl.textContent = getExtensionMode() === 'full'
        ? `完整离线包 · ${gitLabels[getGitMode()] || 'Git 原样'}`
        : '轻量清单（不打包 .git）';
    }

    // 增量与差量：仅「差量补丁」是生效项（原「增量合并」开关经取证确认从不生效，已于 T4 移除）。
    // 该区必选项是基准 ZIP，故状态读数必须体现基准是否已就绪——否则用户勾了也不知道能不能跑。
    const incEl = document.getElementById('fold-summary-incremental');
    if (incEl) {
      const deltaOn = document.getElementById('host-incremental-export')?.checked;
      incEl.textContent = !deltaOn ? '' : (currentBaseZip ? '差量补丁 · 基准已就绪' : '差量补丁 · 缺基准');
    }

    const fnEl = document.getElementById('fold-summary-filename');
    if (fnEl) fnEl.textContent = filenameTemplateInput?.value || '';
  }

  /**
   * 宿主原生存储面板入口（`#btn-storage-inspector`，仅抽屉态渲染）。
   *
   * T2 按用户裁决 13 移除了自绘双行配额条，只留这枚按钮的外观，**行为归本任务**。
   * 语义：宿主提供原生 Storage Inspector 才解除 `hidden`；不提供则整块保持隐藏，
   * **不出现死按钮**，也**不恢复自绘配额条**（用户裁决 13 不可回退）。
   * 唤起失败时保持静默——按钮本就不该可见，无需用户可见报错。
   */
  function setupStorageInspectorButton() {
    const btn = document.getElementById('btn-storage-inspector');
    if (!btn) return; // 独立态 / 模态态不渲染该按钮
    btn.addEventListener('click', () => { void openStorageInspector(); });
    void isStorageInspectorAvailable().then((available) => {
      if (available) btn.hidden = false;
    });
  }

  document.querySelectorAll('input[name="extension-mode"]').forEach((el) => {
    el.addEventListener('change', () => {
      // 选中态视觉由 CSS :has(input:checked) 处理，不再写内联色值（禁止硬编码颜色）
      syncGitModeAvailability();
      updateFoldSummaries();
      refreshPlan();
    });
  });

  document.querySelectorAll('input[name="git-mode"]').forEach((el) => {
    el.addEventListener('change', () => {
      updateFoldSummaries();
      refreshPlan();
    });
  });
  // 初始联动：默认选中「轻量清单」，故 Git 策略组初始就是禁用态。
  syncGitModeAvailability();

  const keepDevFilesCheck = document.getElementById('keep-dev-files-check');
  if (keepDevFilesCheck) {
    keepDevFilesCheck.addEventListener('change', () => refreshPlan());
  }

  // 初始化外部数据包类目过滤器组件
  setupCategoryFilter({
    onSelectionChange: () => {
      refreshPlan();
    },
  });

  // 统一文件树确认栏按钮（宿主拉取阶段2）
  const btnHostTreeConfirm = document.getElementById('btn-host-tree-confirm');
  const btnHostTreeCancel = document.getElementById('btn-host-tree-cancel');
  const btnHostTreeSelectAll = document.getElementById('btn-host-tree-selectall');
  if (btnHostTreeConfirm) {
    btnHostTreeConfirm.addEventListener('click', () => resolveHostTreeConfirm(true));
  }
  if (btnHostTreeCancel) {
    btnHostTreeCancel.addEventListener('click', () => resolveHostTreeConfirm(false));
  }
  if (btnHostTreeSelectAll) {
    btnHostTreeSelectAll.addEventListener('click', () => categorySelectAll());
  }

  // 批量队列转换执行逻辑（R-16 / U-5 / U-7：接入任务状态机 + 子项游标续传）
  //
  // 形态：**一个任务 + 子项游标**（不给每个子项建任务）——`taskControls` 一次只展示一个活动任务，
  // N 个控制条会让用户心智断裂。断点清单：
  //   { kind:'batch', itemIndex, outputs:[{index,name}], doneEntries, totalItems, itemIds }
  //   - `itemIndex` = **下一个待处理**子项下标（不是"已完成个数"，避免 off-by-one 歧义）
  //   - `itemIds`   = 源包在 files store 的记录 id（源包是**入库**的，故续传时可按 id 取回）
  //   - `doneEntries` **只属于 itemIndex 那个子项**（见 seedEntriesFor 的注释）
  async function handleBatchConvert({
    resumeCheckpoint = null, resumeTaskId = null, sourceRecords = null,
  } = {}) {
    const target = resolveTarget(targetSelect ? targetSelect.value : 'pt', 'pt');
    const taskId = resumeTaskId || `${TASK_PREFIX[TASK_KINDS.CONVERT_BATCH]}${Date.now()}`;

    // 续传时按 id 取回源包（列表页刷新也不影响：源包入的是 files store，产物才是内存态）
    let records = sourceRecords;
    if (!records && Array.isArray(resumeCheckpoint?.itemIds)) {
      records = [];
      for (const id of resumeCheckpoint.itemIds) {
        const full = await getFile(id);
        if (full?.blob) records.push(full);
      }
    }
    if (!records || records.length === 0) {
      logger.warn('批量转换无可处理的源包（选择为空或源包已不在工作区），未启动任务');
      return;
    }
    const itemIds = sourceRecords ? records.map((r) => r.id) : [...resumeCheckpoint.itemIds];
    const totalItems = itemIds.length;
    const startIndex = resumeCheckpoint?.itemIndex ?? 0;

    // ⚠️ 可验证前提（U-6）：产物是 ephemeral（只在内存），断点却持久化 —— 两者可能不一致。
    // 不校验就硬续 ⇒ 跳过产物已丢失的子项 ⇒ **静默产出残缺批次**。故此处**不满足即作废断点**。
    if (resumeCheckpoint) {
      const verdict = batchResumeVerdict({
        expectedOutputs: (resumeCheckpoint.outputs ?? []).length,
        productsPresent: exportQueue.items.filter((it) => it.taskId === taskId).length,
      });
      if (!verdict.valid) {
        logger.warn(`批量续传前提不成立，断点作废、将重跑整批：${verdict.reason}`);
        // 任务记录可能已随页面重载消失（TaskManager 是内存态）⇒ abort 会返回 false，
        // 此时直接清持久化断点，否则它会一直留在 adapter 里（孤儿条目，且将来若恢复
        // "暂停态展示"就会变成活缺陷）
        if (!(await taskManager.abort(taskId))) {
          try { await authorityCheckpointAdapter?.remove?.(taskId); } catch { /* 清理失败不阻断 */ }
        }
        taskControls.hide();
        await handleBatchConvert({ sourceRecords: records });
        return;
      }
    }

    const { signal, onCheckpoint } = taskManager.start(taskId, '批量转换', { resumable: true, totalBytes: 0 });
    taskControls.showRunning(taskId, { totalBytes: 0 });
    const outputs = resumeCheckpoint ? [...(resumeCheckpoint.outputs ?? [])] : [];
    // 当前子项的条目断点（每个子项**重建**，见 seedEntriesFor）
    let doneEntries = new Map();
    let maybeCheckpoint = createCheckpointThrottle(onCheckpoint, doneEntries);
    let trackProgress = attachConversionProgress({ doneEntries, maybeCheckpoint });
    const totalCount = totalItems;

    workbenchBusy = true;
    applyActionAvailability();
    view.setProgress(0, `正在开始批量转换 ${totalCount} 个数据包...`);
    logger.info(`启动批量转换队列，共 ${totalCount} 个包，目标格式: ${target.toUpperCase()}`
      + (startIndex > 0 ? `（从第 ${startIndex + 1} 个续传）` : ''));

    try {
      const run = await runBatchItems({
        items: itemIds,
        startIndex,
        onItemError: (err, i) => {
          // 单个子项失败沿用既有语义：记日志、继续（任务级 fail 只留给结构性错误）
          logger.error(`批量转换失败 [${itemIds[i]}]: ${err.message}`);
        },
        convertItem: async (itemId, i) => {
          const full = await getFile(itemId);
          if (!full?.blob) {
            logger.warn(`[${i + 1}/${totalCount}] 源包已不在工作区，跳过: ${itemId}`);
            return;
          }
          const currentBlob = full.blob;
          currentBlob.name = full.name;

          const template = filenameTemplateInput?.value || DEFAULT_FILENAME_TEMPLATE;
          const outputFilename = resolveFilename(template, {
            sourceName: currentBlob.name,
            target,
            handle: full.handle || currentHostHandle || 'default-user',
          });
          const compressionLevel = compressionSelect ? parseInt(compressionSelect.value, 10) : 5;
          const pruneBuiltinCheck = document.getElementById('prune-builtin-check');

          // 每个子项重置条目断点（跨子项复用 crc 清单会因同名条目错误跳过 ⇒ 产物缺条目）
          doneEntries = seedEntriesFor({ checkpoint: resumeCheckpoint, index: i, startIndex });
          maybeCheckpoint = createCheckpointThrottle(onCheckpoint, doneEntries);
          trackProgress = attachConversionProgress({ doneEntries, maybeCheckpoint });

          const { report, resultBlob } = await runConversionTask({
            source: currentBlob,
            target,
            // 与单包转换**同源**的参数面：类目勾选/排除/压缩等一律取当前 UI 状态，
            // 不引入第二套参数面（否则两条路径会漂移）
            options: {
              selection: getSelectionState(),
              excludedPaths: getExcludedPaths(),
              includeBackups: includeBackupsCheck ? includeBackupsCheck.checked : false,
              includeCache: includeCacheCheck ? includeCacheCheck.checked : false,
              includeAppPrivate: includePrivateCheck ? includePrivateCheck.checked : false,
              compressionLevel,
              extensionMode: getExtensionMode(),
              gitMode: getGitMode(),
              keepDevFiles: getKeepDevFiles(),
              pruneBuiltinAssets: pruneBuiltinCheck ? pruneBuiltinCheck.checked : true,
              signal,
              resumeCrcMap: doneEntries,
            },
            onProgress: (cur, tot, name, crc32) => {
              trackProgress(cur, tot, name, crc32);
              const basePct = Math.round((i / totalCount) * 100);
              const itemPct = tot > 0 ? Math.round((cur / tot) * (100 / totalCount)) : 0;
              view.setProgress(basePct + itemPct, `[${i + 1}/${totalCount}] ${currentBlob.name} -> ${name}`);
            },
          });

          exportQueue.enqueue({
            name: outputFilename,
            blob: resultBlob,
            targetLayout: target,
            origin: 'converted',
            ephemeral: true,
            taskId, // ← 失效检测的锚点：续传前按它数"产物还在不在"
          });
          outputs.push({ index: i, name: outputFilename });
          // 子项边界是**天然断点**：强制落一次（比 64 条节流更对齐语义）
          maybeCheckpoint({ force: true, totalEntries: doneEntries.size });
          view.renderReport(report);
          logger.success(`[${outputs.length}/${totalCount}] 数据包转换成功${resumedNote(report)}: ${outputFilename}`);
        },
      });

      if (run.aborted) {
        // 把中止信号交给下方 catch 统一做状态迁移（与单包路径**逐字节同构**）
        throw run.error;
      }

      view.setProgress(100, `批量队列处理完成：成功 ${outputs.length}/${totalCount} 个包`);
      await taskManager.complete(taskId);
      taskControls.hide();
    } catch (err) {
      const rec = taskManager.get(taskId);
      const { action } = convertExitForAbort({ err, record: rec });
      if (action === 'paused') {
        const pct = totalCount > 0 ? Math.min(99, Math.round((outputs.length / totalCount) * 100)) : 0;
        taskControls.showPaused(taskId, { percent: pct, receivedBytes: outputs.length, totalBytes: totalCount });
        taskControls.setPausedCheckpoint(taskId, rec?.checkpoint ?? null);
        view.setProgress(pct, `批量转换已暂停于第 ${outputs.length}/${totalCount} 个包，可从断点继续或丢弃`);
        logger.info(`批量转换已暂停：已完成 ${outputs.length}/${totalCount}`);
      } else if (action === 'aborted') {
        taskControls.hide();
        view.setProgress(100, '批量转换已中止');
      } else if (action === 'fail') {
        await taskManager.fail(taskId, true);
        taskControls.hide();
        view.setProgress(100, `批量转换出错: ${err.message}`);
        logger.error('批量转换出错', err);
      }
    } finally {
      workbenchBusy = false;
      applyActionAvailability();
      await updateWorkspaceUI();
    }
  }

  // 上传暂存区源包列表（含选中批操作）
  async function refreshArchiveManagerUI() {
    const stashListEl = document.getElementById('stash-list');
    const stashBatchBar = document.getElementById('stash-batch-bar');
    if (!stashListEl) return;
    await renderStashList({
      containerEl: stashListEl,
      batchBarEl: stashBatchBar,
      activeFileId: currentFileId,
      isHostAvailable: host.isPlugin,
      confirmFn: confirmDialog,
      onLoadFile: async (fileRecord) => {
        if (!fileRecord || !fileRecord.blob) return;
        currentFile = fileRecord.blob;
        currentFile.name = fileRecord.name;
        currentFileId = fileRecord.id;
        currentFileHandle = fileRecord.handle || 'default-user';

        applyActionAvailability();
        if (dropHandler?.setFilename) {
          dropHandler.setFilename(fileRecord.name);
        }
        view.setProgress(0, `已载入数据包：${fileRecord.name} (${formatBytes(fileRecord.size)})`);
        logger.info(`载入数据包作为当前处理源: ${fileRecord.name} (用户: ${currentFileHandle})`);
        updateFilenamePreview();
        await refreshPlan();
        await refreshArchiveManagerUI();
      },
      onListChanged: async () => {
        await updateWorkspaceUI();
      },
      onRestoreToHost: (fileRecord) => {
        openRestoreModal(fileRecord);
      },
      // U-7：批量转换入口。此前 `runBatchConversion` 是**无调用者的死代码**
      // （暂存区批量栏只有"载入为源/下载/写回宿主/删除"），而 README 承诺了"批量转换"
      // ⇒ 补上这个入口，让已有实现可达、让 README 的承诺成立。
      onBatchConvert: (records) => { void handleBatchConvert({ sourceRecords: records }); },
    });
  }

  // 用量看板（配额条 + 来源统计 + 包体积列表）
  async function refreshUsageDashboard() {
    if (!usageDashboardEl) return;
    await renderUsageDashboard({ containerEl: usageDashboardEl });
  }

  // 待导出区（所有产物统一出口）
  const exportQueue = new ExportQueue();

  // 长任务管理器（宿主拉取/转换/写回共用）+ 进度条旁任务控制条
  // 断点持久化：Authority 后端可用时走服务端 KV（跨会话/多端），否则回退默认内存 adapter
  const authorityCheckpointAdapter = await createCheckpointAdapter();
  const taskManager = new TaskManager(authorityCheckpointAdapter || undefined);

  /**
   * 可续传任务的分派表：**类型 → 执行体**（与 `TASK_KINDS` 一一对应，唯一判据见 `taskKindOf`）。
   *
   * 用箭头函数包一层是刻意的：惰性解引用，避免"表在函数声明之前求值"的时序依赖。
   * 加新任务路径时：`TASK_KINDS` / `TASK_PREFIX` 加一项 + 此处加一行 —— **不得再写第二个 `if (id.startsWith(...))`**。
   */
  const RESUMABLE_HANDLERS = Object.freeze({
    [TASK_KINDS.FETCH]: (args) => handleHostExport(args),
    [TASK_KINDS.CONVERT]: (args) => handleExternalConvert(args),
    [TASK_KINDS.CONVERT_BATCH]: (args) => handleBatchConvert(args),
  });

  const taskControls = initTaskControls({
    taskManager,
    onPause: (id) => {
      // 拉取执行体在 reader 循环内感知 signal.aborted 后自行 checkpoint+cancel；
      // 转换执行体则由 Worker 侧的 signal abort 触发 terminate（`worker-client.js:136`）。
      // 两处都只记录"暂停请求已发起"，真正的状态迁移由 TaskManager.pause 完成。
      logger.info(`暂停请求已发送: ${id}`);
    },
    onResume: (id, checkpoint) => {
      const kind = taskKindOf(id);
      const handler = RESUMABLE_HANDLERS[kind];
      if (!handler) {
        // 查不到就**说清楚**，不静默 —— 静默返回会让用户以为"点了继续但没反应"
        logger.warn(`无可续传的执行体: ${id}（识别出的类型: ${kind ?? 'null'}）`);
        return;
      }
      handler({ resumeCheckpoint: checkpoint, resumeTaskId: id });
    },
    onAbort: (id) => {
      logger.warn(`任务已中止: ${id}`);
      if (opfsCleanupId === id) {
        opfsTmpCleanup(opfsCleanupName);
        opfsCleanupId = null;
        opfsCleanupName = null;
      }
    },
    onDiscard: (id) => {
      logger.warn(`断点与半成品已丢弃: ${id}`);
      if (opfsCleanupId === id) {
        opfsTmpCleanup(opfsCleanupName);
        opfsCleanupId = null;
        opfsCleanupName = null;
      }
    },
  });
  // 当前 OPFS 半成品归属（中止/丢弃时清理）
  let opfsCleanupId = null;
  let opfsCleanupName = null;

  // 最近一次规划结果（供「仅导出扩展清单」复用扩展元数据，避免二次解析源包）
  let latestPlan = null;
  const btnExportExtManifest = document.getElementById('btn-export-ext-manifest');

  /** 无扩展可导出时禁用按钮并给出提示（含未选源包的情形）。 */
  function syncExportExtManifestButton() {
    if (!btnExportExtManifest) return;
    const count = latestPlan?.extensions?.length || 0;
    btnExportExtManifest.disabled = count === 0;
    btnExportExtManifest.title = count === 0
      ? (currentFile ? '未检测到扩展' : '请先选择源数据包')
      : `导出 ${count} 个扩展的只读清单 (JSON，不含扩展代码)`;
  }

  /**
   * 只读清单导出：产出一份 JSON 清单进待导出区，不写包、不触发安装面板。
   * 这是清单契约的「审阅/分享」入口（决策 D-2）。
   */
  async function exportExtensionManifestOnly() {
    const extensions = latestPlan?.extensions || [];
    if (extensions.length === 0) {
      logger.warn('未检测到扩展，无法导出清单');
      return;
    }
    const mode = getExtensionMode();
    const manifest = buildExtensionManifest({
      extensions,
      mode,
      generatedAt: new Date().toISOString(),
    });
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    exportQueue.enqueue({
      name: `extensions-manifest-${stamp}.json`,
      blob,
      targetLayout: resolveTarget(targetSelect ? targetSelect.value : '', ''),
      origin: 'converted',
      ephemeral: true,
    });
    refreshExportQueueUI();
    logger.success(`已生成只读扩展清单：${extensions.length} 个扩展（模式 ${mode}）——可在待导出区下载或存入工作区`);
  }

  if (btnExportExtManifest) {
    btnExportExtManifest.addEventListener('click', () => {
      exportExtensionManifestOnly();
    });
    syncExportExtManifestButton();
  }

  function refreshExportQueueUI() {
    if (!exportQueuePanel) return;
    renderExportQueue({
      containerEl: exportQueuePanel,
      queue: exportQueue,
      isHostAvailable: host.isPlugin,
      confirmFn: confirmDialog,
      restoreInFlight: isRestoreInFlight(),
      // 批量恢复状态（进行中/收尾）+ 宿主无恢复能力时的原因（禁用入口，R1.6）
      restoreBatch: lastBatchState,
      restoreUnsupportedReason: isRestoreUnsupported() ? getRestoreUnsupportedReason() : '',
      onCancelRestore: () => {
        // 先请求编排器停批（未跑的项保持 queued 可续跑），再取消在途请求
        if (activeBatch) activeBatch.abort();
        if (cancelRestoreInFlight()) {
          logger.warn('用户取消了在途恢复写入——宿主可能已收到部分数据，请稍后核对');
        }
      },
      onRestoreToHost: (item) => {
        openRestoreModal({ name: item.name, blob: item.blob, size: item.blob.size });
      },
      onRestoreBatch: (items) => {
        openBatchRestoreModal(items);
      },
      onRetryFailedBatch: async () => {
        if (!activeBatch || isRestoreInFlight()) return;
        activeBatch.retryFailed();
        lastBatchState = activeBatch.getState();
        refreshExportQueueUI();
        logger.info(`重跑失败项：${lastBatchState.items.filter((i) => i.status === ITEM_STATUS.QUEUED).length} 项`);
        const state = await activeBatch.start();
        lastBatchState = state;
        if (state.status === BATCH_STATUS.DONE) logger.success(`失败项重跑完成：全部 ${state.total} 项已恢复`);
        else logger.warn('重跑结束但仍有未成功项——请查看待导出区的逐项原因');
        refreshExportQueueUI();
      },
      onRefreshPage: () => {
        // 显式按钮：只有用户点击才刷新（不自动强刷，避免打断宿主进行中的工作）
        logger.info('用户请求刷新页面以让宿主加载已恢复的数据');
        window.location.reload();
      },
      onWorkspaceChanged: async () => {
        await updateWorkspaceUI();
      },
    });
    // 能力探测结果可能刚刚变化（首次恢复尝试后）→ 同步工作台动作按钮的可用性
    applyActionAvailability();
  }

  // 占位符 chip 与包名预设按钮已移除（用户裁决 4/6）：
  // 包名模板的可用占位符由输入框自身的 placeholder 表达，默认模板即默认值，
  // 不再提供插入按钮与三档预设——它们与输入框三重表达同一件事。

  // 1. 刷新数据包区（暂存列表/配额条/待导出区）
  async function updateWorkspaceUI() {
    if (!isStorageSupported()) return;
    try {
      await refreshArchiveManagerUI();
      await refreshUsageDashboard();
      refreshExportQueueUI();
    } catch (err) {
      console.warn('刷新工作区 UI 失败:', err);
    }
  }

  // 2. 调度完全扫描与动作预测规划
  async function refreshPlan() {
    // 折叠区摘要与「是否已有源包」无关，须在早退前刷新
    updateFoldSummaries();
    if (!currentFile || isPlanning) return;
    isPlanning = true;

    try {
      const target = resolveTarget(targetSelect ? targetSelect.value : 'l');
      const selection = getSelectionState();
      const excludedPaths = getExcludedPaths();
      const includeBackups = includeBackupsCheck ? includeBackupsCheck.checked : false;
      const includeCache = includeCacheCheck ? includeCacheCheck.checked : false;
      const includeAppPrivate = includePrivateCheck ? includePrivateCheck.checked : false;

      const plan = await runPlanTask({
        source: currentFile,
        target,
        options: {
          selection,
          excludedPaths,
          includeBackups,
          includeCache,
          includeAppPrivate,
          extensionMode: getExtensionMode(),
          gitMode: getGitMode(),
          keepDevFiles: getKeepDevFiles(),
        },
      });

      renderCategoryStats(plan);
      latestPlan = plan;
      syncExportExtManifestButton();

      // 持久化当前工作区状态
      if (currentFileId) {
        await saveWorkspaceState({
          fileId: currentFileId,
          fileName: currentFile.name,
          target,
          selection,
          excludedPaths: Array.from(excludedPaths),
          includeBackups,
          includeCache,
          includeAppPrivate,
          compressionLevel: compressionSelect ? compressionSelect.value : '5',
          filenameTemplate: filenameTemplateInput ? filenameTemplateInput.value : '',
        });
      }
    } catch (err) {
      console.warn('执行规划预测失败:', err);
    } finally {
      isPlanning = false;
    }
  }

  // 3. 宿主环境识别与 Badge 标识（单枚合并徽标：运行形态 + 宿主 + 服务端版本）
  const HOST_BADGE_STYLES = {
    st: { text: 'SillyTavern 插件', color: 'var(--accent-st)' },
    luker: { text: 'Luker 插件', color: 'var(--accent-luker)' },
    standalone: { text: '独立 Web 模式', color: '' },
  };
  const applyHostBadge = (platform, version = null) => {
    if (!envBadge) return;
    const style = HOST_BADGE_STYLES[platform] || HOST_BADGE_STYLES.standalone;
    envBadge.textContent = version && platform !== 'standalone'
      ? `${style.text} · v${version}`
      : style.text;
    if (style.color) {
      envBadge.style.color = style.color;
      envBadge.style.borderColor = style.color;
    } else {
      envBadge.style.color = '';
      envBadge.style.borderColor = '';
    }
  };
  applyHostBadge(host.platform);

  // 4. 插件态界面激活与宿主工作台初始化
  const applyPluginUi = (platform) => {
    if (!host.isPlugin) return;
    // 按钮可见性/可用性统一由 applyActionAvailability 求值——此处不再单独写 display
    // （原实现：btn-host-fetch 强制 inline-flex、btn-restore-luker 仅 luker 显示）

    // ST 宿主端点不支持 selection：在类目面板头部注入"插件内过滤"提示
    const categoryPanel = document.getElementById('category-panel');
    let hint = document.getElementById('host-selection-mode-hint');
    if (platform === 'st' && categoryPanel && !hint) {
      hint = document.createElement('small');
      hint.id = 'host-selection-mode-hint';
      hint.className = 'zone-hint';
      hint.style.display = 'block';
      hint.textContent = 'ST 宿主端点仅支持全量导出：勾选的类目将在导出后由插件内过滤生效';
      categoryPanel.insertBefore(hint, categoryPanel.firstChild);
    } else if (hint) {
      hint.style.display = platform === 'st' ? 'block' : 'none';
    }

    // 插件态下按钮可用性统一求值（含 btn-restore-luker 的可见性）
    applyActionAvailability();
    if (targetSelect) {
      // 插件模式注入"宿主原生格式"选项并默认选中（native → 执行时经 hostLayoutCode 归一）
      let nativeOpt = targetSelect.querySelector('option[value="native"]');
      if (!nativeOpt) {
        nativeOpt = document.createElement('option');
        nativeOpt.value = 'native';
        nativeOpt.textContent = `宿主原生格式 (${hostLayoutCode(platform).toUpperCase()})`;
        targetSelect.insertBefore(nativeOpt, targetSelect.firstChild);
      }
      targetSelect.value = 'native';
    }
    registerMenuButton(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    // 原生"用户数据备份"UI 旁也注入入口，与扩展设置抽屉共存；
    // 「一键拉取」复用完整 handleHostExport 流程（TaskManager/文件树确认/待导出区）
    mountNativeBackupButton(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }, {
      onQuickFetch: () => handleHostExport(),
    });
    // Luker 备份管理器弹层内也注入入口（仅 Luker 有该锚点，其余宿主无操作）
    mountLukerBackupManagerButton(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  };
  applyPluginUi(host.platform);

  // 服务端 /version 二次校验：不一致时以服务端为准并刷新 UI
  if (host.isPlugin) {
    verifyHostPlatform(host.platform)
      .then(({ platform: verifiedPlatform, version }) => {
        if (verifiedPlatform !== host.platform && verifiedPlatform !== 'standalone') {
          host.platform = verifiedPlatform;
          applyPluginUi(verifiedPlatform);
          logger.info(`宿主环境已按服务端校验结果刷新: ${verifiedPlatform.toUpperCase()}`);
        }
        if (verifiedPlatform !== 'standalone') {
          applyHostBadge(verifiedPlatform, version || null);
        }
      })
      .catch((err) => console.warn('宿主服务端校验失败:', err));
  }

  if (host.isPlugin) {
    // 获取当前用户句柄
    getHandle()
      .then((handle) => {
        currentHostHandle = handle;
        if (hostUserBadge) {
          hostUserBadge.style.display = 'inline-block';
          hostUserBadge.textContent = `用户: ${handle}`;
        }
        logger.info(`已连接宿主用户: ${handle}`);
        updateFilenamePreview();
      })
      .catch((err) => {
        logger.warn('获取当前宿主用户信息提示:', err.message);
      });
  }

  // 5. 差量补丁基准包交互（统一开关组内，宿主拉取与外部转换共用）
  const hostIncrementalCheck = document.getElementById('host-incremental-export');
  const hostBaseZipSection = document.getElementById('host-base-zip-section');
  const hostBaseZipInput = document.getElementById('host-base-zip-input');
  const btnSelectBaseZip = document.getElementById('btn-select-base-zip');
  const hostBaseArchiveSelect = document.getElementById('host-base-archive-select');
  const hostBaseZipStatus = document.getElementById('host-base-zip-status');

  async function refreshBaseArchiveOptions() {
    if (!hostBaseArchiveSelect) return;
    try {
      const storedFiles = filterStashFiles(await listStoredFiles());
      const currentVal = hostBaseArchiveSelect.value;
      hostBaseArchiveSelect.innerHTML = '<option value="">或从上传暂存区选取...</option>';
      if (storedFiles && storedFiles.length > 0) {
        storedFiles.forEach((f) => {
          const opt = document.createElement('option');
          opt.value = f.id;
          opt.textContent = `${f.name} (${formatBytes(f.size)})`;
          hostBaseArchiveSelect.appendChild(opt);
        });
      }
      if (currentVal) hostBaseArchiveSelect.value = currentVal;
    } catch {
      // 忽略
    }
  }

  function updateBaseZipStatusUI() {
    if (!hostBaseZipStatus) return;
    if (currentBaseZip) {
      hostBaseZipStatus.innerHTML = `<i class="fa-solid fa-circle-check" style="color: #10b981;"></i> 已就绪基准包: <b>${escapeHtml(currentBaseZip.name)}</b> (${escapeHtml(formatBytes(currentBaseZip.size))})`;
      hostBaseZipStatus.style.color = 'var(--SmartThemeQuoteColor, #93c5fd)';
    } else {
      hostBaseZipStatus.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> 请先选择已有基准包，否则无法生成增量差量补丁';
      hostBaseZipStatus.style.color = '#f87171';
    }
  }

  if (hostIncrementalCheck) {
    hostIncrementalCheck.addEventListener('change', () => {
      const isInc = hostIncrementalCheck.checked;
      if (hostBaseZipSection) {
        hostBaseZipSection.style.display = isInc ? 'block' : 'none';
      }
      if (isInc) {
        refreshBaseArchiveOptions();
        updateBaseZipStatusUI();
      }
      // 折叠摘要须随开关刷新（原实现漏了这一步，摘要会停留在旧值）
      updateFoldSummaries();
    });
  }

  if (btnSelectBaseZip && hostBaseZipInput) {
    btnSelectBaseZip.addEventListener('click', () => {
      hostBaseZipInput.click();
    });

    hostBaseZipInput.addEventListener('change', () => {
      const file = hostBaseZipInput.files?.[0];
      if (file) {
        currentBaseZip = {
          name: file.name,
          blob: file,
          size: file.size,
        };
        updateBaseZipStatusUI();
        logger.info(`已设定外部基准 ZIP: ${file.name} (${formatBytes(file.size)})`);
      }
    });
  }

  if (hostBaseArchiveSelect) {
    hostBaseArchiveSelect.addEventListener('change', async () => {
      const id = hostBaseArchiveSelect.value;
      if (!id) return;
      try {
        const fileRecord = await getFile(id);
        if (fileRecord && fileRecord.blob) {
          currentBaseZip = {
            name: fileRecord.name,
            blob: fileRecord.blob,
            size: fileRecord.size || fileRecord.blob.size,
          };
          updateBaseZipStatusUI();
          logger.info(`已从暂存区载入基准 ZIP: ${fileRecord.name}`);
        }
      } catch (err) {
        logger.error('载入基准包失败:', err);
      }
    });
  }

  // 6. 执行宿主拉取操作（统一选项，产物一律进待导出区）

  // 统一文件树确认栏（宿主拉取阶段2：渲染树 → 用户勾选 → 确认/取消）
  let hostTreeConfirmResolve = null;

  function waitHostTreeConfirm(taskId) {
    return new Promise((resolve) => {
      hostTreeConfirmResolve = resolve;
      const bar = document.getElementById('host-tree-confirm-bar');
      if (!bar) {
        resolve(true); // 无确认栏（测试环境/模板漂移）：维持现状行为直接继续
        return;
      }
      bar.hidden = false;
      bar.dataset.taskId = taskId;
      view.setProgress(38, `请在统一文件树勾选需要的文件/类目，确认后继续`);
    });
  }

  function resolveHostTreeConfirm(confirmed) {
    const bar = document.getElementById('host-tree-confirm-bar');
    if (bar) bar.hidden = true;
    if (hostTreeConfirmResolve) {
      const r = hostTreeConfirmResolve;
      hostTreeConfirmResolve = null;
      r(confirmed);
    }
  }

  async function handleHostExport({ resumeCheckpoint = null, resumeTaskId = null } = {}) {
    const btnHostFetch = document.getElementById('btn-host-fetch');

    // 检查差量补丁模式是否已指定基准包
    const isIncremental = hostIncrementalCheck ? hostIncrementalCheck.checked : false;
    if (isIncremental && !currentBaseZip) {
      logger.error('差量补丁模式开启，必须先选择一个已有基准 ZIP！');
      void alertDialog('【差量补丁提示】\n差量补丁模式必须选择一个已有 ZIP 作为基准包！\n请在面板中点击“选择本地基准 ZIP”或从上传暂存区选取基准包。');
      if (hostBaseZipSection) hostBaseZipSection.style.display = 'block';
      updateBaseZipStatusUI();
      return;
    }

    workbenchBusy = true;
    applyActionAvailability();

    // 统一类目勾选（与外部转换路径共用同一份 category-filter 状态）
    const selection = getSelectionState();

    const selectedTarget = targetSelect ? targetSelect.value : 'native';

    // 断点续传：携带清单重跑（Range 尽力而为，见 fetchHostBackup 内部决策）
    const taskId = resumeTaskId || `fetch-${Date.now()}`;
    let opfsName = null; // OPFS 半成品名（catch 清理需引用，须在 try 外声明避免 TDZ ReferenceError）
    const { signal, onCheckpoint } = taskManager.start(taskId, '宿主拉取', {
      resumable: true,
      totalBytes: resumeCheckpoint?.totalBytes || 0,
    });
    taskControls.showRunning(taskId, { totalBytes: resumeCheckpoint?.totalBytes || 0 });
    if (resumeCheckpoint) {
      logger.info(`续传任务 ${taskId}: 断点 ${formatBytes(resumeCheckpoint.receivedBytes || 0)}`);
    }

    try {
      view.setProgress(10, `正在向宿主 ${host.platform.toUpperCase()} 请求数据包...`);
      logger.info(`向宿主请求导出数据包，勾选类目: ${Object.keys(selection).filter((k) => selection[k]).join(', ')}`);

      // 宿主 selection 能力：由 host-bridge 的**显式声明表**求值，不在业务层推导（R4.1）。
      // ST 宿主的 /api/users/backup 端点不支持 selection（全量 glob 导出）：
      // 必须请求全量包，类目筛选由下方 needsTransform 分支在插件内过滤生效；
      // Luker 宿主端点原生支持 selection，直接透传。
      const selectionCap = hostSelectionCapability(host.platform);
      const hostSupportsSelection = selectionCap.supported;
      const endpointSelection = hostSupportsSelection
        ? selection
        : { ...FULL_SELECTION };
      if (!hostSupportsSelection) {
        logger.info(`宿主端点不做 selection 透传（${selectionCap.reason}），类目筛选将在导出后由插件内过滤执行`);
      }

      // Luker 服务端 selection.settings 会隐含打包 backups/ 目录（历史快照，
      // src/users.js getUserBackupTargets）：勾了 settings 的用户每次都在拉
      // 全部历史备份，GB 级 backups 是"慢"的主因——发请求前给出明确警示。
      const hostIncludeBackups = includeBackupsCheck ? includeBackupsCheck.checked : false;
      if (hostSupportsSelection && endpointSelection.settings && !hostIncludeBackups) {
        logger.warn('提示: 勾选「系统设置」时 Luker 服务端会隐含打包 backups/ 历史快照目录（可能数 GB）。'
          + '若拉取缓慢，请清理酒馆内历史备份快照，或在下方勾选项中取消「系统设置」。');
      }

      const rawBackup = await fetchHostBackup(host.platform, endpointSelection, {
        taskId,
        signal,
        resumeCheckpoint,
        onPhase: async (phase, received, total, opfsName, currentBps) => {
          // 实测速度直显（bytes/s → MB/s），非估算
          const speedText = currentBps ? ` ${((currentBps / 1048576)).toFixed(1)} MB/s` : '';
          const receivedText = `已接收 ${(received / 1048576).toFixed(1)}${total > 0 ? ` / ${(total / 1048576).toFixed(1)}` : ''} MB`;
          if (phase === 'host-generating') {
            view.setProgress(12, `[1/3 宿主打包中] 正在请求 /api/users/backup · 服务端正在读取磁盘并压缩打包 (deflate) · 用户: ${currentHostHandle} · 此阶段耗时取决于数据量与服务端 CPU`);
          } else if (phase === 'transferring') {
            if (total > 0) {
              const pct = 15 + Math.round((received / total) * 20);
              view.setProgress(pct, `[2/3 传输中] 正在接收宿主打包的 ZIP 流 · ${receivedText}${speedText}`);
            } else {
              view.setProgress(18, `[2/3 传输中] 正在接收宿主打包的 ZIP 流 (无 Content-Length) · ${receivedText}${speedText}`);
            }
            // 断点清单跟踪（TaskManager 节流持久化；中止/暂停时由 fetch 循环 force 落盘）
            if (opfsName) {
              await onCheckpoint({
                receivedBytes: received,
                totalBytes: total,
                opfsName,
              }, { bytes: received });
            }
          }
        },
      });

      // 统一源形态：OPFS 句柄 → File（zip.js 原生消费 File，零内存拷贝）
      const rawBackupIsOpfs = rawBackup && rawBackup.kind === 'opfs';
      opfsName = rawBackupIsOpfs ? rawBackup.name : null;
      const rawBackupBlob = rawBackupIsOpfs
        ? await opfsHandleToFile(rawBackup.handle)
        : rawBackup;

      // 记录 OPFS 半成品归属（中止/丢弃时清理）
      if (rawBackupIsOpfs) {
        opfsCleanupId = taskId;
        opfsCleanupName = opfsName;
      }

      // ===== 统一文件树：先扫描后拉取（阶段2 等待用户确认勾选）=====
      // 端点不支持文件级导出（ST/Luker 同），拉取本身全量落盘；
      // 过滤在本地 convert() 以 excludedPaths 完成，零额外网络成本。
      view.setProgress(38, `数据包已落盘，正在扫描文件树 (只读中央目录)...`);
      let hostPlan = null;
      try {
        const effectiveTargetPreview = selectedTarget === 'native'
          ? hostLayoutCode(host.platform)
          : selectedTarget;
        hostPlan = await runPlanTask({
          source: rawBackupBlob,
          target: effectiveTargetPreview,
          options: {
            selection: getSelectionState(),
            excludedPaths: getExcludedPaths(),
            includeBackups: includeBackupsCheck ? includeBackupsCheck.checked : false,
            includeCache: includeCacheCheck ? includeCacheCheck.checked : false,
            includeAppPrivate: includePrivateCheck ? includePrivateCheck.checked : false,
            extensionMode: getExtensionMode(),
            gitMode: getGitMode(),
            keepDevFiles: getKeepDevFiles(),
            pruneBuiltinAssets: document.getElementById('prune-builtin-check')?.checked ?? true,
          },
        });
      } catch (scanErr) {
        logger.warn(`统一文件树扫描失败 (${scanErr.message})，降级为按类目勾选继续`);
      }

      if (hostPlan) {
        renderCategoryStats(hostPlan);
        logger.info(`统一文件树就绪: ${hostPlan.totalSourceFiles} 个文件，可展开类目明细逐文件勾选，确认后继续转换`);
      }

      const confirmed = await waitHostTreeConfirm(taskId);
      if (!confirmed) {
        // 用户中止/丢弃：清理半成品与清单
        await taskManager.abort(taskId);
        taskControls.hide();
        if (opfsName) await opfsTmpCleanup(opfsName);
        resetCategoryFilter();
        view.setProgress(100, `宿主拉取已取消`);
        logger.info('宿主拉取在文件树确认阶段被取消，半成品已清理');
        return;
      }

      // 确认后的勾选状态即为最终过滤依据（树派生 selection/excludedPaths 已由 category-filter 维护）
      const confirmedSelection = getSelectionState();
      const confirmedExcludedPaths = getExcludedPaths();

      const template = filenameTemplateInput?.value || DEFAULT_FILENAME_TEMPLATE;
      const effectiveTarget = selectedTarget === 'native'
        ? hostLayoutCode(host.platform)
        : selectedTarget;
      let finalBlob = rawBackupBlob;
      let targetLayout = effectiveTarget;

      // 无论原生直出还是跨格式直出，统一通过 resolveFilename 依据模板解析文件名并贯通 handle
      let finalFilename = resolveFilename(template, {
        sourceName: `${host.platform}-${currentHostHandle}`,
        target: effectiveTarget,
        handle: currentHostHandle,
      });

      // 检查智能分包与原生资产过滤设置（统一控件）
      const splitMb = parseSplitInputMb();
      const shouldSplit = splitMb > 0;
      const pruneBuiltinCheck = document.getElementById('prune-builtin-check');
      const pruneBuiltinAssets = pruneBuiltinCheck ? pruneBuiltinCheck.checked : true;

      // 如果指定了跨平台直出格式 (非 native) 或启用了原生资产过滤 或 不包含备份聊天与快照
      // ST 宿主下 selection 由插件内过滤生效，因此只要勾选不全量就必须走转换过滤；
      // 统一文件树确认后的 excludedPaths（逐文件勾选差异）也强制走转换过滤
      const hasPartialSelection = hostSupportsSelection
        ? false
        : Object.keys(FULL_SELECTION).some((k) => !selection[k]);
      const hasFileExclusions = confirmedExcludedPaths.size > 0;
      const needsTransform = (selectedTarget !== 'native' && selectedTarget !== effectiveTarget)
        || pruneBuiltinAssets
        || !hostIncludeBackups
        || hasPartialSelection
        || hasFileExclusions;

      if (needsTransform) {
        targetLayout = selectedTarget === 'native'
          ? hostLayoutCode(host.platform)
          : selectedTarget;
        view.setProgress(40, `数据已拉取，正在转换处理数据包 (${targetLayout.toUpperCase()})...`);
        logger.info(`进行直出格式与资产过滤处理: ${host.platform.toUpperCase()} -> ${targetLayout.toUpperCase()} (包含备份聊天: ${hostIncludeBackups}, 逐文件排除: ${confirmedExcludedPaths.size})`);

        const compressionLevel = compressionSelect ? parseInt(compressionSelect.value, 10) : 5;
        const { report, resultBlob } = await runConversionTask({
          source: rawBackupBlob,
          target: targetLayout,
          options: {
            selection: confirmedSelection,
            excludedPaths: confirmedExcludedPaths,
            includeBackups: hostIncludeBackups,
            includeCache: includeCacheCheck ? includeCacheCheck.checked : false,
            includeAppPrivate: includePrivateCheck ? includePrivateCheck.checked : false,
            compressionLevel,
            extensionMode: getExtensionMode(),
            gitMode: getGitMode(),
            keepDevFiles: getKeepDevFiles(),
            pruneBuiltinAssets,
            signal,
          },
          onProgress: (cur, total, name) => {
            const pct = total > 0 ? 40 + Math.round((cur / total) * 50) : 60;
            view.setProgress(pct, `正在直出写入 [${cur}/${total}]: ${name}`);
          },
        });

        finalBlob = resultBlob;
        view.renderReport(report);
      } else if (hasFileExclusions || confirmedExcludedPaths.size > 0) {
        // 不转换时排除集也应同步到当前过滤器（保持树状态与产物一致）
        setExcludedPaths(confirmedExcludedPaths);
      }

      // 执行外部基准增量导出比对 (生成仅包含新增与修改项的纯增量补丁包)
      if (isIncremental && currentBaseZip) {
        view.setProgress(88, `正在与外部基准包比对差异并生成增量补丁 (基准: ${currentBaseZip.name})...`);
        logger.info(`启动外部基准增量比对: [${currentBaseZip.name}] vs 最新宿主数据`);

        const deltaResult = await generateDeltaArchive(currentBaseZip.blob, finalBlob, {
          baseName: currentBaseZip.name,
          level: compressionSelect ? parseInt(compressionSelect.value, 10) : 5,
        });

        finalBlob = deltaResult.deltaBlob;
        finalFilename = finalFilename.replace(/\.zip$/i, '') + '_delta_patch.zip';
        logger.success(`纯增量补丁包构建成功: 新增 ${deltaResult.stats.addedCount} 项, 修改 ${deltaResult.stats.modifiedCount} 项, 保持不变 ${deltaResult.stats.unchangedCount} 项 (补丁体积: ${formatBytes(finalBlob.size)})`);
      }

      // 执行智能增量分卷 (若开启)
      if (shouldSplit) {
        const thresholdMB = splitMb;
        view.setProgress(92, `正在按 ${thresholdMB} MB 阈值执行智能独立分包...`);
        logger.info(`启动智能分包引擎: 单包阈值 ${thresholdMB} MB`);

        const reader = await zipIo.openReader(finalBlob);
        const entries = [];
        for await (const e of reader.entries()) {
          if (e.isDirectory) { e.skip(); continue; }
          entries.push({ path: e.fileName, data: await e.read(), size: e.uncompressedSize });
        }
        await reader.close();

        const splitResult = await splitArchiveEntries(entries, {
          thresholdMB,
          target: effectiveTarget,
          handle: currentHostHandle,
          filenameTemplate: template,
        });

        // 分卷统一进待导出区（来源=分卷），供统一处置
        for (const p of splitResult.parts) {
          exportQueue.enqueue({
            name: p.partName,
            blob: p.blob,
            targetLayout: targetLayout,
            origin: 'split-part',
            ephemeral: true,
          });
        }
        refreshExportQueueUI();
        view.setProgress(100, `宿主数据已切分为 ${splitResult.totalParts} 个分卷，已进入待导出区统一处置！`);
        logger.success(`宿主导出分卷完成: 共 ${splitResult.totalParts} 个独立包 (${formatBytes(splitResult.totalBytes)})，可在待导出区批量下载或存入工作区`);
        if (opfsName) await opfsTmpCleanup(opfsName);
        return;
      }

      // 单包模式：统一进待导出区（增量补丁产物标记 delta 来源）
      const isDeltaPatch = /_delta_patch\.zip$/i.test(finalFilename);
      exportQueue.enqueue({
        name: finalFilename,
        blob: finalBlob,
        targetLayout: targetLayout,
        origin: isDeltaPatch ? 'delta' : 'host-export',
        ephemeral: true,
      });
      refreshExportQueueUI();

      view.setProgress(100, `宿主数据包已进入待导出区！`);
      logger.success(`宿主拉取完成: ${finalFilename} (${formatBytes(finalBlob.size)}) —— 可在待导出区下载、选位置导出、存入工作区或写回宿主`);
      await taskManager.complete(taskId);
      taskControls.hide();
      if (opfsName) await opfsTmpCleanup(opfsName);
    } catch (err) {
      if (err?.name === 'AbortError') {
        // 暂停（signal.aborted + paused 状态）与中止在 UI 层表现一致；中止路径 taskControls 已复位
        const rec = taskManager.get(taskId);
        if (rec && rec.state === TASK_STATES.PAUSED) {
          const total = rec.checkpoint?.totalBytes || rec.totalBytes || 0;
          const received = rec.receivedBytes || rec.checkpoint?.receivedBytes || 0;
          const pct = total > 0 ? Math.round((received / total) * 100) : 0;
          taskControls.showPaused(taskId, { percent: pct, receivedBytes: received, totalBytes: total });
          taskControls.setPausedCheckpoint(taskId, rec.checkpoint);
          view.setProgress(pct, `任务已暂停，可从断点继续或丢弃`);
          logger.info(`任务已暂停于 ${pct}% (${formatBytes(received)})`);
        } else if (rec && rec.state === TASK_STATES.ABORTED) {
          taskControls.hide();
          view.setProgress(100, `任务已中止`);
          if (typeof opfsName === 'string' && opfsName) await opfsTmpCleanup(opfsName);
        }
      } else {
        await taskManager.fail(taskId, Boolean(opfsName));
        taskControls.hide();
        if (typeof opfsName === 'string' && opfsName) await opfsTmpCleanup(opfsName);
        view.setProgress(100, `导出失败: ${err.message}`);
        logger.error('宿主拉取过程发生错误', err);
      }
    } finally {
      workbenchBusy = false;
      applyActionAvailability();
    }
  }

  const btnHostFetch = document.getElementById('btn-host-fetch');
  if (btnHostFetch) {
    btnHostFetch.addEventListener('click', () => handleHostExport());
  }

  // 7. 还原确认模态弹窗逻辑
  function openRestoreModal(archiveFile) {
    if (!host.isPlugin) {
      void alertDialog('还原/写入功能仅在作为 SillyTavern 或 Luker 扩展插件运行且已登录时可用。');
      return;
    }
    if (isRestoreUnsupported()) {
      void alertDialog(getRestoreUnsupportedReason());
      return;
    }
    pendingRestoreBatch = null;
    pendingRestoreFile = archiveFile;
    if (restoreModalDesc) {
      restoreModalDesc.innerHTML = `即将把数据包 <strong>「${escapeHtml(archiveFile.name)}」</strong> (${escapeHtml(formatBytes(archiveFile.size))}) 恢复写入到当前酒馆宿主 (${escapeHtml(host.platform.toUpperCase())})，请选择恢复模式：`;
    }
    if (restoreModalOverlay) {
      restoreModalOverlay.style.display = 'flex';
    }
  }

  /**
   * 批量恢复模态：**复用**同一个恢复模态，只换描述文案与语义
   * （用户 2026-09-25 裁决：开批前选一次模式，应用到全批；不新增自绘浮层，L1-MR-4）。
   * @param {Array<{id: string, name: string, blob: Blob}>} items 待恢复产物（顺序即执行顺序）
   */
  function openBatchRestoreModal(items) {
    if (!host.isPlugin) {
      void alertDialog('还原/写入功能仅在作为 SillyTavern 或 Luker 扩展插件运行且已登录时可用。');
      return;
    }
    if (isRestoreUnsupported()) {
      void alertDialog(getRestoreUnsupportedReason());
      return;
    }
    if (!items || items.length === 0) return;
    // 单项时走单条路径，避免为 1 项多一层批量语义
    if (items.length === 1) {
      openRestoreModal({ name: items[0].name, blob: items[0].blob, size: items[0].blob.size });
      return;
    }
    pendingRestoreFile = null;
    pendingRestoreBatch = items;
    const totalBytes = items.reduce((sum, it) => sum + (it.blob?.size || 0), 0);
    if (restoreModalDesc) {
      restoreModalDesc.innerHTML = `即将把 <strong>${escapeHtml(String(items.length))} 项</strong>产物`
        + ` (共 ${escapeHtml(formatBytes(totalBytes))}) 依次恢复写入到当前酒馆宿主`
        + ` (${escapeHtml(host.platform.toUpperCase())})。<br>本批统一使用所选模式；`
        + '逐项写入期间部分数据已生效，全部完成前请勿视为已结束。';
    }
    if (restoreModalOverlay) {
      restoreModalOverlay.style.display = 'flex';
    }
  }

  /**
   * 执行一批恢复：逐项写入、逐项记录结果、**单项失败不中断整批**。
   *
   * 编排逻辑在 `src/core/restore-batch.js`（纯状态机，Node 可直测）；
   * 本函数只把宿主调用与 UI 刷新接上（依赖注入式接缝，L0-11）。
   * @param {Array<{id: string, name: string, blob: Blob}>} items
   * @param {'merge'|'overwrite'} mode 本批统一模式
   */
  async function runBatchRestore(items, mode) {
    if (isRestoreInFlight()) {
      void alertDialog('已有恢复任务正在进行，请等待其完成后再试');
      return;
    }
    const targets = items.map((it) => ({ id: it.id, name: it.name, blob: it.blob }));
    activeBatch = createRestoreBatch({
      items: targets,
      restoreOne: async ({ id }) => {
        const target = targets.find((t) => t.id === id);
        try {
          const res = await restoreToHost(target.blob, {
            mode, platform: host.platform, timeoutMs: UPLOAD_TIMEOUT_MS,
          });
          // 宿主 200 但没写任何条目：不计成功（否则整批会谎报「恢复完成」）
          if (res && res.nothingRestored) {
            throw new Error('宿主未写入任何条目（该类目可能不被宿主接受）');
          }
          return res;
        } catch (err) {
          // 宿主根本没这个能力：后续每一项都会同样失败，立即停批（避免刷出 N 条相同失败）
          if (err?.code === 'RESTORE_UNSUPPORTED' && activeBatch) activeBatch.abort();
          throw err;
        }
      },
      onUpdate: (state) => {
        lastBatchState = state;
        refreshExportQueueUI();
      },
    });
    lastBatchState = activeBatch.getState();
    refreshExportQueueUI();
    logger.info(`开始批量恢复：${targets.length} 项，模式 ${mode === 'merge' ? '合并写入' : '覆盖写入'}`);

    const state = await activeBatch.start();
    const settled = state.doneCount + state.failedCount + state.unconfirmedCount;
    // 收尾文案：如实区分四种收尾，**不出现**「合并完成」类表述
    if (state.status === BATCH_STATUS.DONE) {
      view.setProgress(100, `全部 ${state.total} 项恢复完成，请刷新页面生效`);
      logger.success(`批量恢复完成：${state.doneCount}/${state.total} 项`);
    } else if (state.status === BATCH_STATUS.ABORTED) {
      view.setProgress(100, `批量恢复已中止：完成 ${settled}/${state.total}（部分数据已生效）`);
      logger.warn('批量恢复已中止——宿主可能已收到部分数据，请核对数据完整性');
    } else {
      view.setProgress(100, `批量恢复结束：完成 ${state.doneCount}/${state.total}`
        + `${state.failedCount ? `，失败 ${state.failedCount}` : ''}`
        + `${state.unconfirmedCount ? `，未确认 ${state.unconfirmedCount}` : ''}（部分数据已生效）`);
      logger.warn('批量恢复未全部成功——逐项原因见待导出区，可「重试失败项」');
    }
    if (isRestoreUnsupported()) void alertDialog(getRestoreUnsupportedReason());
    refreshExportQueueUI();
  }

  if (btnCancelRestore) {
    btnCancelRestore.addEventListener('click', () => {
      pendingRestoreFile = null;
      if (restoreModalOverlay) restoreModalOverlay.style.display = 'none';
    });
  }

  if (btnConfirmRestore) {
    btnConfirmRestore.addEventListener('click', async () => {
      const batchItems = pendingRestoreBatch;
      const fileToRestore = pendingRestoreFile;
      if (!batchItems && !fileToRestore) return;
      // 并发互斥：恢复在途时拒绝再次发起（两个事务并发写同一用户目录，宿主侧行为未定义）
      if (isRestoreInFlight()) {
        void alertDialog('已有恢复任务正在进行，请等待其完成后再试');
        return;
      }
      const modeRadio = document.querySelector('input[name="restore-mode"]:checked');
      const mode = modeRadio ? modeRadio.value : 'merge';

      pendingRestoreBatch = null;
      if (restoreModalOverlay) restoreModalOverlay.style.display = 'none';

      // 批量：整批交给编排状态机（模式在开批前选一次，逐项结果与失败原因均可见）
      if (batchItems) {
        await runBatchRestore(batchItems, mode);
        return;
      }

      try {
        btnConfirmRestore.disabled = true;
        // 单条恢复开始：清掉上一批的收尾条，避免与本次进度并存造成误读
        lastBatchState = null;
        view.setProgress(15, `正在恢复写入数据包至宿主 (${mode === 'merge' ? '合并写入' : '覆盖写入'})...`);
        logger.info(`向宿主发起数据包恢复请求: ${fileToRestore.name}, 模式: ${mode}`);

        // `restoreToHost` 的同步段会置位在途标志，故先拿到 promise 再刷新，
        // 待导出区才会渲染出「取消恢复」入口（审计 R-01：大包上传此前无法中途取消）
        const restorePromise = restoreToHost(fileToRestore.blob, {
          mode, platform: host.platform, timeoutMs: UPLOAD_TIMEOUT_MS,
        });
        refreshExportQueueUI();
        const restoreResult = await restorePromise;
        // 三态区分（审计 R-15：响应体不可解析时不得谎报成功）
        if (restoreResult && restoreResult.unconfirmed) {
          view.setProgress(100, `请求已发出，但结果未确认`);
          logger.warn(`恢复请求已发出，但响应体不可解析（${restoreResult.reason || '未知原因'}）——`
            + '宿主可能仍在处理，请稍后核对数据。');
          void alertDialog('恢复请求已发出，但未能确认结果。\n宿主可能仍在处理，请稍后核对数据。');
        } else if (restoreResult && restoreResult.nothingRestored) {
          // 宿主返回 200 但一个条目都没写：如实报告，不得说「成功」
          view.setProgress(100, '宿主未写入任何条目');
          logger.warn('宿主返回成功但 restoredCount=0——请核对包的类目是否被宿主接受');
          void alertDialog('宿主未写入任何条目。\n请核对数据包内容是否包含宿主支持的类目。');
        } else {
          view.setProgress(100, `恭喜！数据包已成功恢复写入到当前酒馆用户！`);
          logger.success(`恢复完成！宿主酒馆数据已更新。`);
        }
      } catch (err) {
        if (err?.name === 'AbortError') {
          // 取消是**请求级**的：宿主可能已收到部分数据，必须提示核对而非报「失败」
          view.setProgress(100, '恢复写入已取消');
          logger.warn('恢复写入已由用户取消——宿主可能已收到部分数据，请稍后核对');
          void alertDialog('恢复已取消。\n宿主可能仍在处理，请稍后核对数据。');
        } else {
          view.setProgress(100, `恢复写入失败: ${err.message}`);
          logger.error('恢复写入宿主过程发生错误', err);
          void alertDialog(`恢复失败: ${err.message}`);
        }
      } finally {
        btnConfirmRestore.disabled = false;
        pendingRestoreFile = null;
        refreshExportQueueUI();
      }
    });
  }

  // Luker 专用旧版快速恢复按钮联动
  if (btnRestoreLuker) {
    btnRestoreLuker.addEventListener('click', () => {
      if (lastConvertedBlob) {
        openRestoreModal({
          name: '最新转换产物.zip',
          size: lastConvertedBlob.size,
          blob: lastConvertedBlob,
        });
      }
    });
  }

  // 8. 外部 Zip 拖拽与转换交互
  const dropHandler = setupFileDrop({
    dropzoneEl: document.getElementById('dropzone'),
    fileInputEl: document.getElementById('file-input'),
    mainTextEl: document.getElementById('drop-main-text'),
    subTextEl: document.getElementById('drop-sub-text'),
    onFilesReady: async (fileItems) => {
      if (!fileItems || fileItems.length === 0) return;
      // 按钮可用性在源包入库后统一求值（下方 updateWorkspaceUI 之后）

      // 批量存入 IndexedDB
      for (const item of fileItems) {
        try {
          const itemHandle = item.detection.handle || 'default-user';
          const id = await saveFile({
            name: item.file.name,
            size: item.file.size,
            blob: item.file,
            layout: item.detection.layout,
            handle: itemHandle,
            role: 'source',
          });
          logger.info(`外部数据包入库成功: ${item.file.name} (识别类型: ${item.detection.layout.toUpperCase()})`);
          if (!currentFile) {
            currentFile = item.file;
            currentFileId = id;
            currentFileHandle = itemHandle;
            if (item.detection.layout === 'st' && targetSelect) targetSelect.value = 'l';
            if (item.detection.layout === 'tt' && targetSelect) targetSelect.value = 'pt';
          }
        } catch (err) {
          logger.warn('暂存文件到 IndexedDB 失败:', err);
        }
      }

      await updateWorkspaceUI();
      updateFilenamePreview();
      applyActionAvailability();
      if (currentFile) {
        await refreshPlan();
      }
    },
    onError: (err) => {
      applyActionAvailability();
      resetCategoryFilter();
      logger.error('文件读取失败', err);
    },
  });

  // 目标平台或高级开关改动时，动态重新生成动作规划与实时更新预览
  if (targetSelect) {
    targetSelect.addEventListener('change', () => {
      updateFilenamePreview();
      refreshPlan();
    });
  }
  if (compressionSelect) {
    compressionSelect.addEventListener('change', () => refreshPlan());
  }
  if (filenameTemplateInput) {
    filenameTemplateInput.addEventListener('input', () => {
      updateFilenamePreview();
      refreshPlan();
    });
  }
  if (includeBackupsCheck) {
    includeBackupsCheck.addEventListener('change', () => refreshPlan());
  }
  if (includeCacheCheck) {
    includeCacheCheck.addEventListener('change', () => refreshPlan());
  }
  if (includePrivateCheck) {
    includePrivateCheck.addEventListener('change', () => refreshPlan());
  }

  // 9. 开始转换外部 Zip（R-16：接入任务状态机，支持暂停/续传）
  //
  // 具名函数而非内联箭头：`RESUMABLE_HANDLERS` 要按任务类型分派到它（与 handleHostExport 同形）。
  // 函数声明会被提升，故可以安全地在定义之前的 `onResume` 里被引用。
  async function handleExternalConvert({ resumeCheckpoint = null, resumeTaskId = null } = {}) {
    if (!currentFile) return;
    const target = resolveTarget(targetSelect.value);
    const selection = getSelectionState();
    const excludedPaths = getExcludedPaths();
    const includeBackups = includeBackupsCheck ? includeBackupsCheck.checked : false;
    const includeCache = includeCacheCheck ? includeCacheCheck.checked : false;
    const includeAppPrivate = includePrivateCheck ? includePrivateCheck.checked : false;
    const compressionLevel = compressionSelect ? parseInt(compressionSelect.value, 10) : 5;

    // 检查智能分包与原生资产过滤设置
    const splitMb = parseSplitInputMb();
    const shouldSplit = splitMb > 0;
    const pruneBuiltinCheck = document.getElementById('prune-builtin-check');
    const pruneBuiltinAssets = pruneBuiltinCheck ? pruneBuiltinCheck.checked : true;

    const taskId = resumeTaskId || `${TASK_PREFIX[TASK_KINDS.CONVERT]}${Date.now()}`;
    const totalBytes = currentFile.size || 0;
    // 与宿主拉取路径同形：start 在 try **之外**（start 自身可能因"同 id 已在运行"抛错，
    // 那时还没进入 try，不会污染 catch 的失败语义）
    const { signal, onCheckpoint } = taskManager.start(taskId, '转换', { resumable: true, totalBytes });
    taskControls.showRunning(taskId, { totalBytes });
    // 断点清单**由调用方自行累积**：Worker abort 时返回值里的 doneEntries 会随 Promise 一起丢
    // （`worker-client.js:136-143` 直接 reject），故不能依赖它。
    // 续传时用断点里的清单**播种**，让已完成条目在 `transform` 层命中即跳过。
    const doneEntries = new Map(
      resumeCheckpoint?.doneEntries ? Object.entries(resumeCheckpoint.doneEntries) : [],
    );
    const maybeCheckpoint = createCheckpointThrottle(onCheckpoint, doneEntries);
    const trackProgress = attachConversionProgress({ doneEntries, maybeCheckpoint });
    if (resumeCheckpoint) {
      logger.info(`续传任务 ${taskId}: 沿用断点 ${doneEntries.size} 条已完成条目`);
    }

    try {
      workbenchBusy = true;
      applyActionAvailability();
      view.setProgress(5, '正在启动异步 Web Worker 线程处理数据包...');
      logger.info(`开始转换外部包: ${currentFile.name} -> ${target.toUpperCase()}`);

      const { report, resultBlob } = await runConversionTask({
        source: currentFile,
        target,
        options: {
          selection,
          excludedPaths,
          includeBackups,
          includeCache,
          includeAppPrivate,
          compressionLevel,
          extensionMode: getExtensionMode(),
          gitMode: getGitMode(),
          keepDevFiles: getKeepDevFiles(),
          pruneBuiltinAssets,
          signal,                 // 暂停/中止的执行面（Worker 路径经 terminate，见 L1-MR-8）
          resumeCrcMap: doneEntries, // 命中即跳过（transform 已支持，计 resumedCount）
        },
        onProgress: (cur, total, name, crc32) => {
          trackProgress(cur, total, name, crc32);
          const pct = total > 0 ? 5 + Math.round((cur / total) * 90) : 50;
          view.setProgress(pct, `正在转换写入 [${cur}/${total}]: ${name}`);
        },
      });

      lastConvertedBlob = resultBlob;
      const template = filenameTemplateInput?.value || DEFAULT_FILENAME_TEMPLATE;
      const currentHandle = currentFileHandle || currentHostHandle || 'default-user';

      // 执行智能增量分卷 (若开启)
      if (shouldSplit) {
        const thresholdMB = splitMb;
        view.setProgress(95, `正在按 ${thresholdMB} MB 阈值执行智能独立分包...`);
        logger.info(`启动智能分包引擎: 单包阈值 ${thresholdMB} MB`);

        // entries 会持有**全部条目的 data**，是分卷路径的主要内存驻留源；
        // 无论成功失败都必须在 finally 中释放（审计 S-01 / S-02）。
        const entries = [];
        try {
          const reader = await zipIo.openReader(resultBlob);
          try {
            for await (const e of reader.entries()) {
              if (e.isDirectory) { e.skip(); continue; }
              entries.push({ path: e.fileName, data: await e.read(), size: e.uncompressedSize });
            }
          } finally {
            await reader.close();
          }

          const splitResult = await splitArchiveEntries(entries, {
            thresholdMB,
            target,
            handle: currentHandle,
            filenameTemplate: template,
          });

          // 分卷统一进待导出区（来源=分卷）
          for (const p of splitResult.parts) {
            exportQueue.enqueue({
              name: p.partName,
              blob: p.blob,
              targetLayout: target,
              origin: 'split-part',
              ephemeral: true,
            });
          }
          refreshExportQueueUI();
          view.renderReport(report);

          view.setProgress(100, `外部数据已切分为 ${splitResult.totalParts} 个分卷，进入待导出区统一处置！`);
          logger.success(`外部 Zip 分卷完成: 共 ${splitResult.totalParts} 个独立包 (${formatBytes(splitResult.totalBytes)})，可在待导出区批量下载或存入工作区`);
        } finally {
          // 释放逐条目 data 引用（成功与失败路径都要走到）
          entries.length = 0;
        }
        // 分卷已接管整包（各 part 进待导出区），原始整包不再有任何消费方 → 立即释放
        lastConvertedBlob = null;
        // 分卷路径同样是一个**正常完成出口** —— 漏掉这两行会让控制条永远停在 running
        await taskManager.complete(taskId);
        taskControls.hide();
        return;
      }

      view.setProgress(100, `转换成功！共写入 ${report.totals.written} 项，已丢弃/过滤 ${report.totals.dropped + (report.totals.filtered || 0)} 项`);
      logger.success(`数据包转换成功！共写入 ${report.totals.written} 个文件`);

      // 暂存转换产物到 IndexedDB
      const outputFilename = resolveFilename(template, {
        sourceName: currentFile.name,
        target,
        handle: currentHandle,
      });

      // 统一出口：产物进入待导出区，由用户在待导出区执行 下载/存工作区/写回宿主
      exportQueue.enqueue({
        name: outputFilename,
        blob: resultBlob,
        targetLayout: target,
        origin: 'converted',
        ephemeral: true,
      });
      refreshExportQueueUI();
      view.renderReport(report);

      view.setProgress(100, `转换完成！产物已进入待导出区: ${outputFilename}`);
      logger.success(`转换成功${resumedNote(report)}: ${outputFilename} (${formatBytes(resultBlob.size)}) —— 可在待导出区下载、选位置导出、存入工作区或写回宿主`);

      await taskManager.complete(taskId);
      taskControls.hide();
    } catch (err) {
      const rec = taskManager.get(taskId);
      const { action } = convertExitForAbort({ err, record: rec });
      if (action === 'paused') {
        // 「静默」≠「什么都不做」：暂停必须显示暂停态。语义与宿主拉取路径逐字节同构。
        const total = rec?.checkpoint?.totalEntries || rec?.totalBytes || 0;
        const done = doneEntries.size;
        const pct = total > 0 ? Math.min(99, Math.round((done / total) * 100)) : 0;
        taskControls.showPaused(taskId, { percent: pct, receivedBytes: 0, totalBytes: total });
        taskControls.setPausedCheckpoint(taskId, rec?.checkpoint ?? null);
        view.setProgress(pct, '转换已暂停，可从断点继续或丢弃');
        logger.info(`转换已暂停于 ${done}/${total || '?'} 条已完成条目`);
      } else if (action === 'aborted') {
        taskControls.hide();
        view.setProgress(100, '转换已中止');
      } else if (action === 'fail') {
        await taskManager.fail(taskId, true); // keepCheckpoint=true：暂停过的任务失败后仍可续
        taskControls.hide();
        view.setProgress(100, `转换出错: ${err.message}`);
        logger.error('数据包转换出错', err);
      }
      // action === 'none'：AbortError 但任务已不在 PAUSED/ABORTED（如已被 complete）⇒ 不做事。
      // ⚠️ 本分支**绝不**出现在 action 为 paused 时调 fail() 的写法 —— 见 convertExitForAbort 的注释。
    } finally {
      workbenchBusy = false;
      applyActionAvailability();
    }
  }

  if (btnConvert) {
    btnConvert.addEventListener('click', () => { void handleExternalConvert(); });
  }

  // 10. 页面启动时无损恢复工作区状态与初始化文件名预览
  updateFilenamePreview();
  updateFoldSummaries();
  setupStorageInspectorButton();

  if (isStorageSupported()) {
    try {
      await updateWorkspaceUI();
      const savedState = await loadWorkspaceState();
      if (savedState && savedState.fileId) {
        const fileRecord = await getFile(savedState.fileId);
        if (fileRecord && fileRecord.blob) {
          currentFile = fileRecord.blob;
          currentFile.name = fileRecord.name;
          currentFileId = fileRecord.id;
          currentFileHandle = fileRecord.handle || 'default-user';

          if (savedState.target && targetSelect) {
            targetSelect.value = savedState.target;
          }
          if (savedState.compressionLevel && compressionSelect) {
            compressionSelect.value = savedState.compressionLevel;
          }
          if (savedState.filenameTemplate && filenameTemplateInput) {
            filenameTemplateInput.value = savedState.filenameTemplate;
          }
          if (typeof savedState.includeBackups === 'boolean' && includeBackupsCheck) {
            includeBackupsCheck.checked = savedState.includeBackups;
          }
          if (typeof savedState.includeCache === 'boolean' && includeCacheCheck) {
            includeCacheCheck.checked = savedState.includeCache;
          }
          if (typeof savedState.includeAppPrivate === 'boolean' && includePrivateCheck) {
            includePrivateCheck.checked = savedState.includeAppPrivate;
          }
          if (savedState.selection) {
            setSelectionState(savedState.selection);
          }
          if (savedState.excludedPaths) {
            setExcludedPaths(savedState.excludedPaths);
          }
          updateFilenamePreview();

          applyActionAvailability();
          if (dropHandler?.setFilename) {
            dropHandler.setFilename(fileRecord.name);
          }

          view.setProgress(0, `已恢复上次工作区：${fileRecord.name} (${formatBytes(fileRecord.size)})`);
          await refreshPlan();
        }
      }
    } catch (err) {
      console.warn('恢复工作区失败:', err);
    }
  }
}

let isWorkbenchInitialized = false;

/**
 * 呼出模态数据包工作台 (供宿主插件环境使用)
 */
export function openConverterModal() {
  if (typeof document === 'undefined') return;

  let modalOverlay = document.getElementById('st-converter-modal-overlay');
  if (!modalOverlay) {
    modalOverlay = document.createElement('div');
    modalOverlay.id = 'st-converter-modal-overlay';
    modalOverlay.className = 'st-converter-modal-overlay';

    const appContainer = document.createElement('div');
    appContainer.className = 'app-container';
    appContainer.id = 'app';
    appContainer.innerHTML = trustedStaticMarkup(getWorkbenchHtml({ isModal: true }));

    modalOverlay.appendChild(appContainer);
    document.body.appendChild(modalOverlay); // dom-scope:allow 自绘模态覆盖层必须挂 body 才能全页覆盖（放进扩展抽屉会被其 overflow/transform 裁剪）

    const closeBtn = appContainer.querySelector('#btn-close-converter-modal');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        modalOverlay.style.display = 'none';
      });
    }

    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) {
        modalOverlay.style.display = 'none';
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modalOverlay && modalOverlay.style.display !== 'none') {
        modalOverlay.style.display = 'none';
      }
    });

    if (!isWorkbenchInitialized) {
      isWorkbenchInitialized = true;
      main(appContainer);
    }
  } else {
    modalOverlay.style.display = 'flex';
  }
}

/**
 * 自适应启动入口：检测独立 Web 模式 vs 酒馆插件模式
 *
 * **判定顺序（R6，2026-09-25 修正）**：先判宿主，再找容器。
 * 原实现反过来——只看 `document.getElementById('app')` 存不存在就决定走独立态：
 * 插件态下只要宿主页面上有**任意**第三方 `#app`，就会走进独立态分支，
 * 把整棵工作台 `innerHTML` 写进那个**别人的容器**，并且永远不挂宿主抽屉。
 * 实测 Luker 全仓无 `#app`（`grep -rn 'id="app"' public/` 零命中），所以今天没炸；
 * 但这是"当前没炸"而非"不会炸"，判定顺序必须按语义来。
 */
function bootstrap() {
  // 只读调试探针最先挂：**两种形态都要有**（插件态的工作台挂在抽屉里、且抽屉默认是关的，
  // 若把挂载放进 main() 就会让「抽屉未打开」时的探针不可用）
  mountDebugProbe();

  const host = detectHost();

  if (host.isPlugin) {
    // 宿主扩展模式 (SillyTavern / Luker)
    // 仅在扩展设置抽屉中展开工作台，遵循“只在插件页面做，不在魔法棒做”
    mountSettingsDrawer((drawerApp) => {
      if (!isWorkbenchInitialized && drawerApp) {
        isWorkbenchInitialized = true;
        main(drawerApp);
      }
    });
    logger.info(`st-zip-converter 扩展设置抽屉已就绪 (${host.platform.toUpperCase()} 模式)`);
    return;
  }

  // 独立 Web 模式：index.html 仅为空骨架，工作台内容由同一模板函数产出
  // （单一模板源 · L1-MR-10：与插件抽屉态、模态态共用 getWorkbenchHtml）
  const existingApp = document.getElementById('app');
  if (!existingApp) {
    logger.warn('独立态未找到 #app 骨架容器，工作台不初始化（index.html 应提供该容器）');
    return;
  }
  if (!existingApp.hasChildNodes()) {
    existingApp.innerHTML = trustedStaticMarkup(getWorkbenchHtml({ isStandalone: true }));
  }
  if (!isWorkbenchInitialized) {
    isWorkbenchInitialized = true;
    main(existingApp);
  }
}

// 启动应用
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
}
