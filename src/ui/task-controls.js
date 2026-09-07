/**
 * 任务控制条 UI：进度条旁的 暂停/中止/继续/丢弃 控件。
 *
 * 与 TaskManager（core 纯状态机）配合：
 * - running → 显示【暂停】【中止】
 * - paused  → 显示【继续】【丢弃】+ 状态文案（"已暂停于 45%（1.2GB/2.7GB）"）
 * - 任务结束 → 隐藏控制条
 *
 * 写回宿主（服务端单请求）仅支持【中止】。
 */

import { logger } from '../core/logger.js';

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
}

/**
 * @param {object} deps
 * @param {import('../core/task-manager.js').TaskManager} deps.taskManager
 * @param {function(string): void} [deps.onPause] 任务被暂停后的额外回调（接线层停止执行体）
 * @param {function(string, object|null): void} [deps.onResume] 继续回调 (taskId, checkpoint 清单)
 * @param {function(string): void} [deps.onAbort] 中止回调（接线层清理半成品）
 * @param {function(string): void} [deps.onDiscard] 丢弃回调（暂停态清理半成品与清单）
 */
export function initTaskControls({
  taskManager,
  onPause,
  onResume,
  onAbort,
  onDiscard,
}) {
  const root = document.getElementById('task-controls');
  if (!root) {
    return {
      showRunning() {}, showPaused() {}, hide() {}, setWritable() {}, get activeTaskId() { return null; },
    };
  }
  const btnPause = root.querySelector('#tc-pause');
  const btnAbort = root.querySelector('#tc-abort');
  const btnResume = root.querySelector('#tc-resume');
  const btnDiscard = root.querySelector('#tc-discard');

  let activeTaskId = null;
  let pausedInfo = null;
  /** 写回宿主等单请求任务只允许中止 */
  let abortOnly = false;

  function render() {
    root.hidden = !activeTaskId;
    const isPaused = Boolean(pausedInfo);
    btnPause.hidden = isPaused || abortOnly;
    btnAbort.hidden = isPaused;
    btnResume.hidden = !isPaused;
    btnDiscard.hidden = !isPaused;
  }

  btnPause?.addEventListener('click', async () => {
    if (!activeTaskId) return;
    const ok = await taskManager.pause(activeTaskId);
    if (ok) {
      logger.info(`任务已请求暂停: ${activeTaskId}`);
      onPause?.(activeTaskId);
    }
  });

  btnAbort?.addEventListener('click', async () => {
    if (!activeTaskId) return;
    const id = activeTaskId;
    const ok = await taskManager.abort(id);
    if (ok) {
      activeTaskId = null;
      pausedInfo = null;
      render();
      onAbort?.(id);
    }
  });

  btnResume?.addEventListener('click', () => {
    if (!activeTaskId || !pausedInfo) return;
    const { checkpoint } = pausedInfo;
    pausedInfo = null;
    render();
    onResume?.(activeTaskId, checkpoint);
  });

  btnDiscard?.addEventListener('click', async () => {
    if (!activeTaskId) return;
    const id = activeTaskId;
    await taskManager.abort(id);
    activeTaskId = null;
    pausedInfo = null;
    render();
    onDiscard?.(id);
  });

  return {
    /** 任务开始：running 态控制条 */
    showRunning(taskId, { totalBytes = 0, abortOnly: abortOnlyMode = false } = {}) {
      activeTaskId = taskId;
      pausedInfo = null;
      abortOnly = abortOnlyMode;
      render();
    },
    /** 任务进入暂停态：更新文案并切按钮组 */
    showPaused(taskId, { percent = 0, receivedBytes = 0, totalBytes = 0 } = {}) {
      if (activeTaskId !== taskId) return;
      pausedInfo = { checkpoint: taskManager.get(taskId)?.checkpoint ?? null };
      const label = document.getElementById('status-label');
      if (label) {
        const pctText = totalBytes > 0
          ? `已暂停于 ${percent}%（${formatBytes(receivedBytes)}/${formatBytes(totalBytes)}）`
          : `已暂停于 ${percent}%（${formatBytes(receivedBytes)}）`;
        label.textContent = pctText;
      }
      render();
    },
    /** 任务结束（完成/失败）：隐藏控制条 */
    hide() {
      activeTaskId = null;
      pausedInfo = null;
      render();
    },
    /** 暂停态下把 checkpoint 注入（接线层在 pause 回调后补充最新清单） */
    setPausedCheckpoint(taskId, checkpoint) {
      if (activeTaskId === taskId && pausedInfo) pausedInfo.checkpoint = checkpoint;
    },
    get activeTaskId() {
      return activeTaskId;
    },
  };
}
