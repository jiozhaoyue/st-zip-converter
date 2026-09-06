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
 * @param {function(object): void} [params.onRestoreToHost] (item) => void
 * @param {function(): void} [params.onWorkspaceChanged] 工作区列表刷新回调
 */
export function renderExportQueue({ containerEl, queue, isHostAvailable = false, onRestoreToHost, onWorkspaceChanged }) {
  if (!containerEl) return;

  const render = () => {
    containerEl.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'export-queue-header';
    header.innerHTML = `<span class="eq-title"><i class="fa-solid fa-file-export"></i> 待导出 (${queue.items.length})</span>`;

    if (queue.items.length > 0) {
      const batchBar = document.createElement('div');
      batchBar.className = 'eq-batch-bar';
      const btnAll = document.createElement('button');
      btnAll.type = 'button';
      btnAll.className = 'menu_button btn-tool';
      btnAll.innerHTML = '<i class="fa-solid fa-download"></i> 全部下载';
      btnAll.addEventListener('click', () => queue.downloadAll());
      batchBar.appendChild(btnAll);

      const btnStash = document.createElement('button');
      btnStash.type = 'button';
      btnStash.className = 'menu_button btn-tool';
      btnStash.innerHTML = '<i class="fa-solid fa-box-archive"></i> 全部存入工作区';
      btnStash.addEventListener('click', async () => {
        await queue.stashAll();
        if (typeof onWorkspaceChanged === 'function') onWorkspaceChanged();
      });
      batchBar.appendChild(btnStash);

      const btnClear = document.createElement('button');
      btnClear.type = 'button';
      btnClear.className = 'menu_button btn-tool';
      btnClear.innerHTML = '<i class="fa-solid fa-trash"></i> 清空';
      btnClear.addEventListener('click', () => {
        if (confirm('确定清空待导出区吗？临时产物将一并丢弃。')) queue.clear();
      });
      batchBar.appendChild(btnClear);
      header.appendChild(batchBar);
    }
    containerEl.appendChild(header);

    if (queue.items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'export-queue-empty';
      empty.textContent = '暂无待导出产物：完成宿主导出或转换后，产物会出现在这里统一处置';
      containerEl.appendChild(empty);
      return;
    }

    const list = document.createElement('div');
    list.className = 'export-queue-list';
    for (const item of queue.items) {
      const row = document.createElement('div');
      row.className = 'export-queue-item';

      const info = document.createElement('div');
      info.className = 'eq-info';
      const originLabel = ORIGIN_LABELS[item.origin] || ORIGIN_LABELS[ORIGINS.CONVERTED];
      info.innerHTML = `
        <div class="eq-name">${item.name}</div>
        <div class="eq-meta">
          <span class="origin-badge ${originLabel.cls}">${originLabel.text}</span>
          ${item.targetLayout ? `<span class="meta-badge">${String(item.targetLayout).toUpperCase()}</span>` : ''}
          <span>${formatBytes(item.blob.size)}</span>
          ${item.storedId ? '<span class="eq-stored">已入库</span>' : '<span class="eq-ephemeral">临时</span>'}
        </div>
      `;
      row.appendChild(info);

      const btns = document.createElement('div');
      btns.className = 'eq-buttons';

      const btnDl = document.createElement('button');
      btnDl.type = 'button';
      btnDl.className = 'btn-archive-action download';
      btnDl.textContent = '下载';
      btnDl.addEventListener('click', () => queue.download(item.id));
      btns.appendChild(btnDl);

      const btnStash = document.createElement('button');
      btnStash.type = 'button';
      btnStash.className = 'btn-archive-action load-source';
      btnStash.textContent = '存工作区';
      btnStash.disabled = Boolean(item.storedId);
      btnStash.addEventListener('click', async () => {
        await queue.stash(item.id);
        if (typeof onWorkspaceChanged === 'function') onWorkspaceChanged();
      });
      btns.appendChild(btnStash);

      if (isHostAvailable && typeof onRestoreToHost === 'function') {
        const btnRestore = document.createElement('button');
        btnRestore.type = 'button';
        btnRestore.className = 'btn-archive-action restore';
        btnRestore.innerHTML = '<i class="fa-solid fa-rotate"></i> 写回宿主';
        btnRestore.addEventListener('click', () => onRestoreToHost(item));
        btns.appendChild(btnRestore);
      }

      const btnRemove = document.createElement('button');
      btnRemove.type = 'button';
      btnRemove.className = 'btn-archive-action delete';
      btnRemove.textContent = '移除';
      btnRemove.addEventListener('click', () => queue.remove(item.id));
      btns.appendChild(btnRemove);

      row.appendChild(btns);
      list.appendChild(row);
    }
    containerEl.appendChild(list);
  };

  queue.subscribe(render);
  render();
}
