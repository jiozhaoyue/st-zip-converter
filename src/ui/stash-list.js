/**
 * 上传暂存区源包列表组件。
 * 渲染 origin ∈ {upload, host-export} 的 IndexedDB 源包，支持复选框多选与批操作。
 * 纯逻辑（过滤/分组）与 DOM 渲染分离以便单测。
 */

import { listStoredFiles, getFile, deleteFile } from '../storage/db.js';

export const STASH_ORIGINS = Object.freeze(['upload', 'host-export']);

/**
 * 从全部文件记录中筛出暂存区源包（纯函数）
 * @param {Array<{origin?: string}>} files
 * @returns {Array} origin ∈ upload|host-export 的记录
 */
export function filterStashFiles(files) {
  const set = new Set(STASH_ORIGINS);
  return (files || []).filter((f) => set.has(f.origin));
}

/**
 * 计算批操作可用性（纯函数）
 * @param {Set<string>} selectedIds
 * @param {boolean} [isHostAvailable]
 * @returns {{ canLoad: boolean, canDownload: boolean, canRestore: boolean, canDelete: boolean }}
 */
export function stashBatchCapability(selectedIds, isHostAvailable = false) {
  const n = selectedIds ? selectedIds.size : 0;
  return {
    canLoad: n === 1,               // 载入为源：单选语义
    canDownload: n > 0,
    canRestore: n > 0 && isHostAvailable,
    canDelete: n > 0,
  };
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

const ORIGIN_LABELS = {
  upload: { text: '上传', cls: 'origin-upload' },
  'host-export': { text: '宿主导出', cls: 'origin-host' },
};

function triggerDownload(full) {
  if (!full?.blob || typeof document === 'undefined') return;
  const url = URL.createObjectURL(full.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = full.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * 渲染上传暂存区列表
 * @param {object} params
 * @param {HTMLElement} params.containerEl #stash-list
 * @param {HTMLElement|null} [params.batchBarEl] #stash-batch-bar
 * @param {string|null} [params.activeFileId] 当前载入为源的文件 id
 * @param {boolean} [params.isHostAvailable]
 * @param {function(object): void} params.onLoadFile (fileRecord) => void
 * @param {function(): void} [params.onListChanged]
 * @param {function(object): void} [params.onRestoreToHost]
 */
export async function renderStashList({
  containerEl,
  batchBarEl = null,
  activeFileId = null,
  isHostAvailable = false,
  onLoadFile,
  onListChanged,
  onRestoreToHost,
}) {
  if (!containerEl) return;
  const all = await listStoredFiles();
  const files = filterStashFiles(all);
  const selected = new Set();

  containerEl.innerHTML = '';
  if (batchBarEl) batchBarEl.innerHTML = '';

  if (files.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'archive-empty';
    empty.textContent = '暂无源包：拖入或上传 Zip 后出现在这里';
    containerEl.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'archive-item-list stash-list';

  const refreshBatchBar = () => {
    if (!batchBarEl) return;
    batchBarEl.innerHTML = '';
    batchBarEl.hidden = selected.size === 0;
    if (selected.size === 0) return;
    const cap = stashBatchCapability(selected, isHostAvailable);
    const label = document.createElement('span');
    label.className = 'eq-selected-label';
    label.textContent = `已选 ${selected.size} 项:`;
    batchBarEl.appendChild(label);
    const mkBtn = (html, title, enabled, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'menu_button btn-tool';
      b.innerHTML = html;
      if (title) b.title = title;
      b.disabled = !enabled;
      b.addEventListener('click', onClick);
      return b;
    };
    batchBarEl.appendChild(mkBtn('<i class="fa-solid fa-folder-open"></i> 载入为源', '将选中的第一个包设为当前转换源', cap.canLoad, async () => {
      const firstId = [...selected][0];
      const full = await getFile(firstId);
      if (full && typeof onLoadFile === 'function') onLoadFile(full);
    }));
    batchBarEl.appendChild(mkBtn('<i class="fa-solid fa-download"></i> 下载', '', cap.canDownload, async () => {
      for (const id of selected) {
        triggerDownload(await getFile(id));
      }
    }));
    if (cap.canRestore && typeof onRestoreToHost === 'function') {
      batchBarEl.appendChild(mkBtn('<i class="fa-solid fa-rotate"></i> 写回宿主', '', true, async () => {
        const firstId = [...selected][0];
        const full = await getFile(firstId);
        if (full?.blob) onRestoreToHost(full);
      }));
    }
    batchBarEl.appendChild(mkBtn('<i class="fa-solid fa-trash"></i> 删除', '', cap.canDelete, async () => {
      if (!confirm(`确定删除选中的 ${selected.size} 个源包吗？`)) return;
      for (const id of [...selected]) {
        selected.delete(id);
        await deleteFile(id);
      }
      if (typeof onListChanged === 'function') onListChanged();
    }));
  };

  for (const file of files) {
    const isActive = file.id === activeFileId;
    const item = document.createElement('div');
    item.className = `archive-card ${isActive ? 'active' : ''}`;

    const info = document.createElement('div');
    info.className = 'archive-info';
    const label = ORIGIN_LABELS[file.origin] || { text: file.origin || '上传', cls: 'origin-upload' };
    info.innerHTML = `
      <div class="eq-name-row">
        <input type="checkbox" class="stash-select-box" data-id="${file.id}" title="加入选择">
        <span class="archive-name">${file.name}</span>
        ${isActive ? '<span class="badge-active-file">当前源</span>' : ''}
      </div>
      <div class="archive-meta">
        <span class="origin-badge ${label.cls}">${label.text}</span>
        <span class="meta-badge">${(file.layout || '未知').toUpperCase()}</span>
        <span>${formatBytes(file.size)}</span>
      </div>
    `;
    item.appendChild(info);

    const btns = document.createElement('div');
    btns.className = 'archive-buttons';
    const mkBtn = (cls, text, title, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn-archive-action ${cls}`;
      b.textContent = text;
      if (title) b.title = title;
      b.addEventListener('click', onClick);
      return b;
    };
    if (!isActive) {
      btns.appendChild(mkBtn('load', '载入', '载入为当前转换源', async () => {
        const full = await getFile(file.id);
        if (full && typeof onLoadFile === 'function') onLoadFile(full);
      }));
    }
    btns.appendChild(mkBtn('download', '下载', '', async () => {
      triggerDownload(await getFile(file.id));
    }));
    if (isHostAvailable && typeof onRestoreToHost === 'function') {
      btns.appendChild(mkBtn('restore', '写回宿主', '', async () => {
        const full = await getFile(file.id);
        if (full?.blob) onRestoreToHost(full);
      }));
    }
    btns.appendChild(mkBtn('delete', '删除', '', async () => {
      if (!confirm(`确定要从暂存区删除「${file.name}」吗？`)) return;
      await deleteFile(file.id);
      if (typeof onListChanged === 'function') onListChanged();
    }));
    item.appendChild(btns);
    list.appendChild(item);
  }
  containerEl.appendChild(list);

  list.addEventListener('change', (e) => {
    const box = e.target.closest('.stash-select-box');
    if (!box) return;
    if (box.checked) selected.add(box.dataset.id);
    else selected.delete(box.dataset.id);
    refreshBatchBar();
  });
}
