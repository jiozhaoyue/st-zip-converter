/**
 * 批量恢复编排状态机（**纯逻辑**：无 DOM、无 fetch、无宿主判断）。
 *
 * 存在原因：待导出区早就有「已选 N 项 → 写回宿主」，但实现只取第一项
 * （`src/ui/export-queue.js` 的 `const first = [...selected][0]`）——勾多项只恢复一项且无提示，
 * 属**静默部分执行**。本模块把「逐项恢复 + 逐项结果 + 失败重跑 + 非原子性如实展示」做成
 * 可单测的状态机，副作用（真正发请求）经 `restoreOne` 回调注入，
 * 与 `src/core/task-manager.js` 的「纯状态机 + adapter 注缝」同形（L0-11 / L1-MR-1）。
 *
 * 诚实性约束（本模块的语义核心）：
 * - **绝不**把「部分成功」说成全成 —— 收尾态区分 `done` / `partial-failed` / `aborted`；
 * - **未确认（unconfirmed）不得当成功**，也**不得**被 `retryFailed()` 自动重跑
 *   （请求可能已落盘，重跑等于重复写入）；
 * - 单项失败不中断整批，失败原因逐项保留以便 UI 展示。
 */

/** 批次收尾态 */
export const BATCH_STATUS = Object.freeze({
  /** 尚未开始（或已重排队待跑） */
  QUEUED: 'queued',
  /** 正在逐项执行 */
  RUNNING: 'running',
  /** 全部成功 */
  DONE: 'done',
  /** 有失败或未确认项 */
  PARTIAL_FAILED: 'partial-failed',
  /** 用户中止（已完成项记录保留） */
  ABORTED: 'aborted',
});

/** 单项状态 */
export const ITEM_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  DONE: 'done',
  /** 明确失败（未写入成功） */
  FAILED: 'failed',
  /** 请求已发出但结果未确认（宿主可能仍在处理）—— **不是成功**，也不得自动重跑 */
  UNCONFIRMED: 'unconfirmed',
  /** 中止时正在执行的项 */
  ABORTED: 'aborted',
});

/**
 * 创建一批恢复编排。
 *
 * @param {object} params
 * @param {Array<{id: string, name: string}>} params.items 待恢复条目（顺序即执行顺序）
 * @param {function({id: string, name: string}): Promise<object>} params.restoreOne
 *   执行单项恢复的回调；返回值形如 `restoreToHost` 的 `{success, unconfirmed?, reason?}`；
 *   抛错即视为该项失败（`AbortError` 在中止时记为「已中止」）
 * @param {function(object): void} [params.onUpdate] 每次状态变化后的快照回调（UI 刷新用；
 *   高频刷新应由调用方自行 rAF 合帧，见 L1-MR-9）
 * @returns {{start: function(): Promise<object>, retryFailed: function(): object,
 *   abort: function(): object, getState: function(): object}}
 */
export function createRestoreBatch({ items, restoreOne, onUpdate = () => {} }) {
  const records = (items || []).map((it) => ({
    id: it.id,
    name: it.name,
    status: ITEM_STATUS.QUEUED,
    reason: '',
  }));
  let batchStatus = BATCH_STATUS.QUEUED;
  let aborted = false;
  let running = false;

  const countBy = (status) => records.filter((r) => r.status === status).length;

  /** @returns {object} 当前快照（深拷贝单项，避免调用方改到内部状态） */
  function getState() {
    return {
      status: batchStatus,
      total: records.length,
      doneCount: countBy(ITEM_STATUS.DONE),
      failedCount: countBy(ITEM_STATUS.FAILED),
      unconfirmedCount: countBy(ITEM_STATUS.UNCONFIRMED),
      pendingCount: countBy(ITEM_STATUS.QUEUED),
      /** 是否还有可继续推进的项（中止后未跑的项保持 queued，可在页面停留期间续跑） */
      canContinue: !running && countBy(ITEM_STATUS.QUEUED) > 0,
      /** 失败项是否可重跑（未确认项不在其中——重跑可能重复写入） */
      canRetryFailed: !running && countBy(ITEM_STATUS.FAILED) > 0,
      items: records.map((r) => ({ ...r })),
    };
  }

  const emit = () => onUpdate(getState());

  /** 批次收尾：中止 > 有失败/未确认 > 全成功 */
  function settle() {
    if (aborted) batchStatus = BATCH_STATUS.ABORTED;
    else if (countBy(ITEM_STATUS.FAILED) + countBy(ITEM_STATUS.UNCONFIRMED) > 0) {
      batchStatus = BATCH_STATUS.PARTIAL_FAILED;
    } else batchStatus = BATCH_STATUS.DONE;
  }

  /**
   * 逐项执行所有 `queued` 项（幂等：进行中重复调用直接返回当前快照）。
   * 中止后再次调用即「续跑未完成项」，**已成功项不会被重跑**。
   * @returns {Promise<object>} 结束时（或已在进行中时）的快照
   */
  async function start() {
    if (running) return getState();
    running = true;
    aborted = false;
    batchStatus = BATCH_STATUS.RUNNING;
    emit();

    for (const rec of records) {
      if (aborted) break;
      if (rec.status !== ITEM_STATUS.QUEUED) continue;

      rec.status = ITEM_STATUS.RUNNING;
      emit();
      try {
        const result = await restoreOne({ id: rec.id, name: rec.name });
        if (result && result.unconfirmed) {
          rec.status = ITEM_STATUS.UNCONFIRMED;
          rec.reason = String(result.reason || '请求已发出，结果未确认');
        } else if (result && result.success === false) {
          rec.status = ITEM_STATUS.FAILED;
          rec.reason = String(result.reason || '宿主未确认成功');
        } else {
          rec.status = ITEM_STATUS.DONE;
          rec.reason = '';
        }
      } catch (err) {
        if (aborted && err && err.name === 'AbortError') {
          rec.status = ITEM_STATUS.ABORTED;
          rec.reason = '已取消（宿主可能已收到部分数据）';
        } else {
          rec.status = ITEM_STATUS.FAILED;
          rec.reason = String((err && err.message) || err);
        }
      }
      emit();
    }

    settle();
    running = false;
    emit();
    return getState();
  }

  /**
   * 把**失败项**重新排队（不碰成功项、也不碰未确认项）。
   * @returns {object} 重排队后的快照；随后调用 `start()` 继续。
   */
  function retryFailed() {
    if (running) return getState();
    for (const rec of records) {
      if (rec.status === ITEM_STATUS.FAILED) {
        rec.status = ITEM_STATUS.QUEUED;
        rec.reason = '';
      }
    }
    emit();
    return getState();
  }

  /**
   * 请求中止：当前执行中的项会在 `restoreOne` settle 后记为「已中止」，未跑的项保持 `queued`。
   * 调用方应同时触发底层取消（`host-bridge.js` 的 `cancelRestoreInFlight()`），
   * 否则要等当前项自然结束才会停下。
   * @returns {object} 当前快照
   */
  function abort() {
    if (!running) return getState();
    aborted = true;
    return getState();
  }

  return { start, retryFailed, abort, getState };
}
