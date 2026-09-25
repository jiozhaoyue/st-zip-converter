/**
 * 待导出区组件 (Export Queue)
 * 统一出口：所有产物（宿主直出/转换生成/增量补丁/分卷）先进待导出区，
 * 由用户统一处置：下载 / 存入工作区 / 写回宿主 / 移除，支持批量。
 *
 * 状态机说明：
 * - 队列条目 { id, name, blob, targetLayout, origin, ephemeral, autoDownload }
 *   ephemeral=true 表示"仅下载不入库"的临时产物（下载动作时才写入 files store）；
 * - stash() 将 ephemeral 条目永久入库；remove() 连带清理 ephemeral 记录；
 * - autoDownload 保留"完成后自动下载"习惯路径。
 */

import { saveFile, deleteFile, getFile } from '../storage/db.js';
import { ORIGINS } from '../storage/db.js';
import { mirrorArtifact } from '../storage/authority-store.js';
import { escapeHtml, trustedStaticMarkup } from './escape.js';

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function triggerBlobDownload(blob, name) {
  // Node/Vitest 降级：无 DOM 时跳过浏览器下载动作（状态机路径仍被单测覆盖）
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * 通过 File System Access API 选择位置写出文件；不支持或用户取消时回退普通下载。
 * @param {Blob} blob
 * @param {string} name
 */
export async function exportToLocation(blob, name) {
  if (typeof window === 'undefined' || !window.showSaveFilePicker) {
    triggerBlobDownload(blob, name);
    return;
  }
  try {
    const handle = await window.showSaveFilePicker({ suggestedName: name });
    const writable = await handle.createWritable();
    await blob.stream().pipeTo(writable);
  } catch (err) {
    if (err && err.name === 'AbortError') return; // 用户取消
    triggerBlobDownload(blob, name); // FS Access 写入异常兜底
  }
}

/**
 * 供拖出 (drag-out) 使用：Chromium 支持 DownloadURL 数据类型。
 * @param {DataTransfer} dataTransfer
 * @param {Blob} blob
 * @param {string} name
 * @returns {boolean} 是否注册成功
 */
export function setDragOutPayload(dataTransfer, blob, name) {
  if (typeof DataTransfer === 'undefined' || typeof URL === 'undefined') return false;
  try {
    const probe = new DataTransfer();
    if (!probe.types || !probe.types.includes('DownloadURL')) return false;
  } catch {
    return false;
  }
  const url = URL.createObjectURL(blob);
  dataTransfer.setData('DownloadURL', `application/zip:${name}:${url}`);
  setTimeout(() => URL.revokeObjectURL(url), 120_000); // 拖放过程可能很长
  return true;
}

const ORIGIN_LABELS = {
  [ORIGINS.UPLOAD]: { text: '上传', cls: 'origin-upload' },
  [ORIGINS.HOST_EXPORT]: { text: '宿主导出', cls: 'origin-host' },
  [ORIGINS.CONVERTED]: { text: '转换生成', cls: 'origin-converted' },
  [ORIGINS.DELTA]: { text: '增量补丁', cls: 'origin-delta' },
  [ORIGINS.SPLIT_PART]: { text: '分卷', cls: 'origin-split' },
};

let seq = 0;

export class ExportQueue {
  constructor() {
    /** @type {Array<{id,name,blob,targetLayout,origin,ephemeral,autoDownload,storedId?}>} */
    this.items = [];
    /** @type {Set<function(): void>} */
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify() {
    for (const fn of this.listeners) fn();
  }

  /**
   * 产物入队
   * @param {object} item
   * @param {Blob} item.blob
   * @param {string} item.name
   * @param {string} [item.targetLayout]
   * @param {string} [item.origin] ORIGINS 枚举，默认 converted
   * @param {boolean} [item.ephemeral=true] 临时产物（不入库直到 stash/下载）
   * @param {boolean} [item.autoDownload=false] 入队即下载
   */
  enqueue({ blob, name, targetLayout = '', origin = ORIGINS.CONVERTED, ephemeral = true, autoDownload = false }) {
    const item = { id: `eq_${Date.now()}_${++seq}`, name, blob, targetLayout, origin, ephemeral, autoDownload, storedId: null };
    this.items.push(item);
    if (autoDownload) {
      triggerBlobDownload(blob, name);
    }
    this.notify();
    return item;
  }

  remove(id) {
    const idx = this.items.findIndex((it) => it.id === id);
    if (idx === -1) return;
    const [item] = this.items.splice(idx, 1);
    if (item.storedId) {
      deleteFile(item.storedId).catch(() => {});
    }
    this.notify();
  }

  clear() {
    for (const item of this.items) {
      if (item.storedId) deleteFile(item.storedId).catch(() => {});
    }
    this.items = [];
    this.notify();
  }

  async download(id) {
    const item = this.items.find((it) => it.id === id);
    if (!item) return;
    triggerBlobDownload(item.blob, item.name);
    // 临时产物下载时顺带入库，避免丢失
    if (item.ephemeral) {
      await this.stash(id);
    }
  }

  async downloadAll() {
    for (const item of [...this.items]) {
      await this.download(item.id);
    }
  }

  /**
   * 产物持久归档镜像：Authority 后端可用时把入库产物镜像到服务端
   * （fire-and-forget，失败/不可用只告警，绝不阻断本地入库路径）
   */
  _mirrorToAuthority(item) {
    if (!item?.blob) return;
    mirrorArtifact(item.name, item.blob).catch(() => {});
  }

  /**
   * 永久存入工作区（ephemeral 产物首次入库；已入库的空操作）
   */
  async stash(id) {
    const item = this.items.find((it) => it.id === id);
    if (!item) return;
    if (!item.storedId) {
      const storedId = await saveFile({
        name: item.name,
        size: item.blob.size,
        blob: item.blob,
        layout: item.targetLayout || 'unknown',
        role: 'output',
        origin: item.origin,
      });
      // saveFile 返回 null = 存储不可用（Node 降级），此时保持 ephemeral 状态
      if (storedId) {
        item.storedId = storedId;
        item.ephemeral = false;
        this._mirrorToAuthority(item);
      }
      this.notify();
    }
  }

  async stashAll() {
    for (const item of [...this.items]) {
      await this.stash(item.id);
    }
  }

  /**
   * 临时产物首次入库（stash 首次会 saveFile），返回存储 id —— 供"下载"路径复用
   */
  async ensureStored(id) {
    const item = this.items.find((it) => it.id === id);
    if (!item) return null;
    if (!item.storedId) {
      item.storedId = await saveFile({
        name: item.name,
        size: item.blob.size,
        blob: item.blob,
        layout: item.targetLayout || 'unknown',
        role: 'output',
        origin: item.origin,
      });
      if (item.storedId) this._mirrorToAuthority(item);
      this.notify();
    }
    return item.storedId;
  }
}

/**
 * 渲染待导出区面板
 * @param {object} params
 * @param {HTMLElement} params.containerEl
 * @param {ExportQueue} params.queue
 * @param {boolean} [params.isHostAvailable]
 * @param {boolean} [params.restoreInFlight] 是否有恢复事务在途（在途时禁用全部「写回宿主」入口）
 * @param {object|null} [params.restoreBatch] 批量恢复状态快照（`createRestoreBatch().getState()`）——
 *   传 `null`（缺省）时行为与既有单条恢复完全一致
 * @param {string} [params.restoreUnsupportedReason] 宿主无整包恢复能力时的原因文案；
 *   非空即禁用全部恢复入口并把它作为 `title`（R1.6 死按钮规则）
 * @param {function(): void} [params.onCancelRestore] 取消在途恢复（批量与单条共用）
 * @param {function(object): void} [params.onRestoreToHost] (item) => void（单条目入口）
 * @param {function(Array<object>): void} [params.onRestoreBatch] (items) => void 批量入口；
 *   未注入时「已选 N 项 → 写回宿主」退化为只处理第一项（**仅兼容旧调用方**，产品内不得依赖）
 * @param {function(): void} [params.onRetryFailedBatch] 重跑本批失败项（只重跑 failed）
 * @param {function(): void} [params.onRefreshPage] 用户点击「刷新页面生效」（由调用方决定是否 reload）
 * @param {function(): void} [params.onWorkspaceChanged] 工作区列表刷新回调
 */
export function renderExportQueue({
  containerEl, queue, isHostAvailable = false, restoreInFlight = false,
  restoreBatch = null, restoreUnsupportedReason = '',
  onCancelRestore, onRestoreToHost, onRestoreBatch, onRetryFailedBatch, onRefreshPage,
  onWorkspaceChanged, confirmFn = null,
}) {
  if (!containerEl) return;
  // 破坏性操作确认走宿主原生弹窗（由调用方注入 host-bridge 的 confirmDialog），
  // 未注入时降级为 window.confirm——保持本组件可脱离宿主单测。
  const askConfirm = typeof confirmFn === 'function'
    ? confirmFn
    : (msg) => Promise.resolve(typeof window !== 'undefined' ? window.confirm(msg) : true);
  /** 宿主无恢复能力：禁用全部恢复入口（含单条目），并把原因作为 title */
  const restoreBlocked = Boolean(restoreUnsupportedReason);
  const restoreBlockedTitle = restoreUnsupportedReason || '已有恢复任务正在进行，请等待其完成';
  const selected = new Set();

  const render = () => {
    containerEl.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'export-queue-header';
    header.innerHTML = `<span class="eq-title"><i class="fa-solid fa-file-export"></i> 待导出 (${escapeHtml(queue.items.length)})</span>`;

    if (queue.items.length > 0) {
      const batchBar = document.createElement('div');
      batchBar.className = 'eq-batch-bar';
      const mkBtn = (html, title, onClick) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'menu_button btn-tool';
        b.innerHTML = trustedStaticMarkup(html);
        if (title) b.title = title;
        b.addEventListener('click', onClick);
        return b;
      };
      batchBar.appendChild(mkBtn('<i class="fa-solid fa-download"></i> 全部下载', '', () => queue.downloadAll()));
      batchBar.appendChild(mkBtn('<i class="fa-solid fa-box-archive"></i> 全部存入工作区', '', async () => {
        await queue.stashAll();
        if (typeof onWorkspaceChanged === 'function') onWorkspaceChanged();
      }));
      batchBar.appendChild(mkBtn('<i class="fa-solid fa-trash"></i> 清空', '', async () => {
        if (await askConfirm('确定清空待导出区吗？临时产物将一并丢弃。')) queue.clear();
      }));
      header.appendChild(batchBar);
    }
    containerEl.appendChild(header);

    // 恢复条：批量进度 / 收尾引导 / 取消入口。
    // - 批量（restoreBatch 非空）：进行中显示「已完成 x/N（部分数据已生效）」，
    //   收尾显示逐项结果 + 「重试失败项」/「刷新页面生效」；绝不显示「合并完成」类表述。
    // - 单条（restoreInFlight 且无批次）：保留原有取消入口（审计 R-01）。
    // - 空队列时同样要出现，故置于空状态提前返回之前。
    if (restoreBatch || (restoreInFlight && typeof onCancelRestore === 'function')) {
      const bar = document.createElement('div');
      bar.className = 'eq-batch-bar eq-restore-bar';
      const mkBarBtn = (html, title, onClick) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'menu_button btn-tool';
        b.innerHTML = trustedStaticMarkup(html);
        if (title) b.title = title;
        b.addEventListener('click', onClick);
        return b;
      };
      const askCancel = () => askConfirm(
        '确定取消正在进行的恢复写入吗？\n宿主可能已收到部分数据，取消后请核对数据完整性。',
      );
      const hint = document.createElement('span');
      hint.className = 'eq-selected-label';

      if (restoreBatch) {
        const { status, total, doneCount, failedCount, unconfirmedCount } = restoreBatch;
        const settled = doneCount + failedCount + unconfirmedCount;
        if (status === 'running') {
          // 非原子性如实展示：逐项恢复期间部分数据已生效
          hint.textContent = `已完成 ${settled}/${total}（部分数据已生效）`;
          if (typeof onCancelRestore === 'function') {
            bar.appendChild(mkBarBtn(
              '<i class="fa-solid fa-ban"></i> 取消批量恢复',
              '中止本批恢复（宿主可能已收到部分数据，取消后请核对）',
              async () => { if (await askCancel()) onCancelRestore(); },
            ));
          }
        } else {
          const parts = [];
          if (status === 'done') parts.push(`全部 ${total} 项恢复完成`);
          else if (status === 'aborted') parts.push(`已中止：完成 ${doneCount}/${total}（部分数据已生效）`);
          else {
            parts.push(`完成 ${doneCount}/${total}`);
            if (failedCount) parts.push(`${failedCount} 项失败`);
            if (unconfirmedCount) parts.push(`${unconfirmedCount} 项结果未确认`);
            parts.push('部分数据已生效');
          }
          hint.textContent = parts.join('，');
          if (restoreBatch.canRetryFailed && typeof onRetryFailedBatch === 'function') {
            bar.appendChild(mkBarBtn(
              '<i class="fa-solid fa-rotate-right"></i> 重试失败项',
              '只重跑失败项；结果未确认的项不重跑（请求可能已落盘，重跑会重复写入）',
              onRetryFailedBatch,
            ));
          }
          if (settled > 0 && typeof onRefreshPage === 'function') {
            bar.appendChild(mkBarBtn(
              '<i class="fa-solid fa-rotate"></i> 刷新页面生效',
              '点击后才刷新页面，让宿主重新加载已恢复的数据',
              onRefreshPage,
            ));
          }
        }
        bar.appendChild(hint);

        // 逐项失败/未确认原因（纯文本，避免注入面）
        const bad = restoreBatch.items.filter((i) => i.status === 'failed' || i.status === 'unconfirmed');
        if (bad.length > 0) {
          const detail = document.createElement('span');
          detail.className = 'eq-selected-label';
          detail.textContent = bad
            .map((i) => `${i.name}: ${i.status === 'unconfirmed' ? '结果未确认' : (i.reason || '失败')}`)
            .join('；');
          bar.appendChild(detail);
        }
      } else {
        bar.appendChild(mkBarBtn(
          '<i class="fa-solid fa-ban"></i> 取消恢复',
          '中止正在进行的恢复写入（宿主可能已收到部分数据，取消后请核对）',
          async () => { if (await askCancel()) onCancelRestore(); },
        ));
        hint.textContent = '恢复写入进行中…';
        bar.appendChild(hint);
      }
      containerEl.appendChild(bar);
    }

    if (queue.items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'export-queue-empty';
      empty.textContent = '暂无待导出产物：完成宿主拉取或转换后，产物会出现在这里统一处置';
      containerEl.appendChild(empty);
      return;
    }

    // 选中批操作条（勾选 ≥1 时出现）
    const selBar = document.createElement('div');
    selBar.className = 'eq-batch-bar eq-selected-bar';
    const refreshSelBar = () => {
      selBar.innerHTML = '';
      if (selected.size === 0) return;
      const mkSelBtn = (html, title, onClick) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'menu_button btn-tool';
        b.innerHTML = trustedStaticMarkup(html);
        if (title) b.title = title;
        b.addEventListener('click', onClick);
        return b;
      };
      const label = document.createElement('span');
      label.className = 'eq-selected-label';
      label.textContent = `已选 ${selected.size} 项:`;
      selBar.appendChild(label);
      selBar.appendChild(mkSelBtn('<i class="fa-solid fa-download"></i> 下载', '', () => {
        for (const id of selected) queue.download(id);
      }));
      selBar.appendChild(mkSelBtn('<i class="fa-solid fa-folder-open"></i> 选位置导出', '逐个弹出保存位置 (浏览器不支持时普通下载)', async () => {
        for (const id of selected) {
          const item = queue.items.find((it) => it.id === id);
          if (item) await exportToLocation(item.blob, item.name);
        }
      }));
      selBar.appendChild(mkSelBtn('<i class="fa-solid fa-box-archive"></i> 存工作区', '', async () => {
        for (const id of selected) await queue.stash(id);
        if (typeof onWorkspaceChanged === 'function') onWorkspaceChanged();
      }));
      if (isHostAvailable && typeof onRestoreToHost === 'function') {
        // 批量入口：把「已选 N 项」**整批**交给调用方。
        // 此前实现是 `const first = [...selected][0]`——勾 3 项只恢复 1 项且无任何提示
        // （静默部分执行），本任务将其修正为整批编排。
        const btnRestore = mkSelBtn('<i class="fa-solid fa-rotate"></i> 写回宿主', '', () => {
          const items = [...selected]
            .map((id) => queue.items.find((it) => it.id === id))
            .filter(Boolean);
          if (items.length === 0) return;
          if (typeof onRestoreBatch === 'function') onRestoreBatch(items);
          // 兼容旧调用方（产品内恒注入 onRestoreBatch）
          else onRestoreToHost(items[0]);
        });
        if (restoreInFlight || restoreBlocked) {
          btnRestore.disabled = true;
          btnRestore.title = restoreBlockedTitle;
        }
        selBar.appendChild(btnRestore);
      }
      selBar.appendChild(mkSelBtn('<i class="fa-solid fa-trash"></i> 移除', '', () => {
        for (const id of [...selected]) { selected.delete(id); queue.remove(id); }
      }));
    };
    refreshSelBar();
    containerEl.appendChild(selBar);

    const list = document.createElement('div');
    list.className = 'export-queue-list';
    for (const item of queue.items) {
      const row = document.createElement('div');
      row.className = 'export-queue-item';
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        setDragOutPayload(e.dataTransfer, item.blob, item.name);
      });

      const info = document.createElement('div');
      info.className = 'eq-info';
      const originLabel = ORIGIN_LABELS[item.origin] || ORIGIN_LABELS[ORIGINS.CONVERTED];
      const layoutBadge = item.targetLayout
        ? `<span class="meta-badge">${escapeHtml(String(item.targetLayout).toUpperCase())}</span>`
        : '';
      const storedBadge = item.storedId
        ? '<span class="eq-stored">已入库</span>'
        : '<span class="eq-ephemeral">临时</span>';
      info.innerHTML = `
        <div class="eq-name-row">
          <input type="checkbox" class="eq-select-box" data-id="${escapeHtml(item.id)}" ${trustedStaticMarkup(selected.has(item.id) ? 'checked' : '')}>
          <span class="eq-name">${escapeHtml(item.name)}</span>
        </div>
        <div class="eq-meta">
          <span class="origin-badge ${escapeHtml(originLabel.cls)}">${escapeHtml(originLabel.text)}</span>
          ${trustedStaticMarkup(layoutBadge)}
          <span>${escapeHtml(formatBytes(item.blob.size))}</span>
          ${trustedStaticMarkup(storedBadge)}
        </div>
      `;
      row.appendChild(info);

      const btns = document.createElement('div');
      btns.className = 'eq-buttons';
      const mkBtn = (cls, html, title, onClick) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `btn-archive-action ${cls}`;
        b.innerHTML = trustedStaticMarkup(html);
        if (title) b.title = title;
        b.addEventListener('click', onClick);
        return b;
      };
      btns.appendChild(mkBtn('download', '下载', '', () => queue.download(item.id)));
      btns.appendChild(mkBtn('load-source', '选位置导出', '选择保存位置写出该文件', () => exportToLocation(item.blob, item.name)));
      const btnStash = mkBtn('load-source', '存工作区', '', async () => {
        await queue.stash(item.id);
        if (typeof onWorkspaceChanged === 'function') onWorkspaceChanged();
      });
      btnStash.disabled = Boolean(item.storedId);
      btns.appendChild(btnStash);
      if (isHostAvailable && typeof onRestoreToHost === 'function') {
        const btnRestoreRow = mkBtn('restore', '<i class="fa-solid fa-rotate"></i> 写回宿主', '', () => onRestoreToHost(item));
        if (restoreInFlight || restoreBlocked) {
          btnRestoreRow.disabled = true;
          btnRestoreRow.title = restoreBlockedTitle;
        }
        btns.appendChild(btnRestoreRow);
      }
      btns.appendChild(mkBtn('delete', '移除', '', () => { selected.delete(item.id); queue.remove(item.id); }));
      row.appendChild(btns);
      list.appendChild(row);
    }
    containerEl.appendChild(list);

    // 复选框事件委托（列表重渲染后仍生效）
    list.addEventListener('change', (e) => {
      const box = e.target.closest('.eq-select-box');
      if (!box) return;
      if (box.checked) selected.add(box.dataset.id);
      else selected.delete(box.dataset.id);
      refreshSelBar();
    });
  };

  // 渲染合帧：批量转换时 notify 高频触发，整表 innerHTML 重建按帧合并
  // （与 view.js 进度条 rAF 合帧同款策略），避免每条产物一次全量重绘
  let renderScheduled = false;
  const renderCoalesced = () => {
    if (renderScheduled) return;
    renderScheduled = true;
    const run = () => {
      renderScheduled = false;
      render();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 0);
  };

  queue.subscribe(renderCoalesced);
  render();
}
