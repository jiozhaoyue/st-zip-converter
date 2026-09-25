/**
 * 上传暂存区源包列表组件。
 * 渲染 origin ∈ {upload, host-export} 的 IndexedDB 源包，支持复选框多选与批操作。
 * 纯逻辑（过滤/分组）与 DOM 渲染分离以便单测。
 */

import { listStoredFiles, getFile, deleteFile } from '../storage/db.js';
import { escapeHtml, trustedStaticMarkup } from './escape.js';

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

let activeRowMenu = null;

/** 关闭已展开的行内「更多」菜单 */
function closeRowMenu() {
  if (activeRowMenu) {
    activeRowMenu.remove();
    activeRowMenu = null;
  }
}

/**
 * 打开行内「更多」菜单（自绘，不依赖宿主弹窗模块）。
 * 用户裁决：暂存区行内动作缩为「载入 + ⋯」，其余动作收进菜单，消除与批量条的双重表达。
 * @param {HTMLElement} anchor 触发按钮
 * @param {Array<{label: string, onClick: () => void|Promise<void>}>} actions
 */
function openRowMenu(anchor, actions) {
  if (typeof document === 'undefined' || !anchor) return;
  closeRowMenu();

  const menu = document.createElement('div');
  menu.className = 'stash-row-menu';
  for (const action of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'menu_button';
    btn.textContent = action.label;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeRowMenu();
      action.onClick();
    });
    menu.appendChild(btn);
  }
  anchor.parentElement.appendChild(menu);
  activeRowMenu = menu;

  // 点击菜单外部或滚动时收起
  const onOutside = (e) => {
    if (!menu.contains(e.target)) closeRowMenu();
  };
  setTimeout(() => {
    document.addEventListener('click', onOutside, { once: true });
  }, 0);
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
  confirmFn = null,
}) {
  if (!containerEl) return;
  // 删除确认走宿主原生弹窗（由调用方注入 host-bridge 的 confirmDialog），
  // 未注入时降级为 window.confirm——保持本组件可脱离宿主单测。
  const askConfirm = typeof confirmFn === 'function'
    ? confirmFn
    : (msg) => Promise.resolve(typeof window !== 'undefined' ? window.confirm(msg) : true);
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
      b.innerHTML = trustedStaticMarkup(html);
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
      if (!(await askConfirm(`确定删除选中的 ${selected.size} 个源包吗？`))) return;
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
    const activeBadge = isActive ? '<span class="badge-active-file">当前源</span>' : '';
    info.innerHTML = `
      <div class="eq-name-row">
        <input type="checkbox" class="stash-select-box" data-id="${escapeHtml(file.id)}" title="加入选择">
        <span class="archive-name">${escapeHtml(file.name)}</span>
        ${trustedStaticMarkup(activeBadge)}
      </div>
      <div class="archive-meta">
        <span class="origin-badge ${escapeHtml(label.cls)}">${escapeHtml(label.text)}</span>
        <span class="meta-badge">${escapeHtml((file.layout || '未知').toUpperCase())}</span>
        <span>${escapeHtml(formatBytes(file.size))}</span>
      </div>
    `;
    item.appendChild(info);

    // 行内只留「载入 + ⋯」：下载 / 写回宿主 / 删除 收进更多菜单，
    // 消除与批量条动作的双重表达（用户裁决 9）。
    if (!isActive) {
      btns.appendChild(mkBtn('load', '载入', '载入为当前转换源', async () => {
        const full = await getFile(file.id);
        if (full && typeof onLoadFile === 'function') onLoadFile(full);
      }));
    }
    btns.appendChild(mkBtn('more', '⋯', '更多操作', () => {
      const actions = [
        {
          label: '下载',
          onClick: async () => triggerDownload(await getFile(file.id)),
        },
      ];
      if (isHostAvailable && typeof onRestoreToHost === 'function') {
        actions.push({
          label: '写回宿主',
          onClick: async () => {
            const full = await getFile(file.id);
            if (full?.blob) onRestoreToHost(full);
          },
        });
      }
      actions.push({
        label: '删除',
        onClick: async () => {
          if (!(await askConfirm(`确定要从暂存区删除「${file.name}」吗？`))) return;
          await deleteFile(file.id);
          if (typeof onListChanged === 'function') onListChanged();
        },
      });
      openRowMenu(btns.lastElementChild, actions);
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
