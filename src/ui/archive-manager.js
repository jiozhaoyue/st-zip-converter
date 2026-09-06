/**
 * 工作区统一单列表管理器 (Archive Manager · v2)
 * 唯一工作区列表：每个条目带来源徽标（上传/宿主导出/转换生成/增量补丁/分卷），
 * 支持来源筛选与跨条目统一操作（载入为转换任务/下载/写回宿主/删除）。
 */

import { listStoredFiles, getFile, deleteFile, ORIGINS } from '../storage/db.js';

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatDate(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const ORIGIN_LABELS = {
  [ORIGINS.UPLOAD]: { text: '上传', cls: 'origin-upload' },
  [ORIGINS.HOST_EXPORT]: { text: '宿主导出', cls: 'origin-host' },
  [ORIGINS.CONVERTED]: { text: '转换生成', cls: 'origin-converted' },
  [ORIGINS.DELTA]: { text: '增量补丁', cls: 'origin-delta' },
  [ORIGINS.SPLIT_PART]: { text: '分卷', cls: 'origin-split' },
};

const FILTERS = [
  { value: '', label: '全部', icon: 'fa-border-all' },
  { value: ORIGINS.UPLOAD, label: '上传', icon: 'fa-cloud-arrow-up' },
  { value: ORIGINS.HOST_EXPORT, label: '宿主导出', icon: 'fa-server' },
  { value: ORIGINS.CONVERTED, label: '转换生成', icon: 'fa-box-archive' },
  { value: ORIGINS.DELTA, label: '增量补丁', icon: 'fa-file-diff' },
  { value: ORIGINS.SPLIT_PART, label: '分卷', icon: 'fa-layer-group' },
];

/**
 * 渲染统一工作区单列表
 * @param {object} params
 * @param {HTMLElement} params.containerEl 挂载容器
 * @param {string|null} params.activeFileId 当前活跃文件 ID
 * @param {string} [params.originFilter] 当前来源筛选
 * @param {function(object): void} params.onLoadFile 载入文件回调
 * @param {function(): void} params.onListChanged 列表变更回调
 * @param {function(string): void} [params.onFilterChanged] 筛选变更回调 (origin)
 * @param {function(object): void} [params.onRestoreToHost] 恢复写入宿主回调
 * @param {boolean} [params.isHostAvailable] 是否处于宿主插件环境
 */
export async function renderArchiveManager({
  containerEl,
  activeFileId,
  originFilter = '',
  onLoadFile,
  onListChanged,
  onFilterChanged,
  onRestoreToHost,
  isHostAvailable = false,
}) {
  if (!containerEl) return;

  const files = await listStoredFiles();
  const filtered = originFilter ? files.filter((f) => f.origin === originFilter) : files;

  containerEl.innerHTML = '';

  // 筛选条
  const filterBar = document.createElement('div');
  filterBar.className = 'archive-filter-bar';
  for (const f of FILTERS) {
    const count = f.value ? files.filter((x) => x.origin === f.value).length : files.length;
    if (f.value && count === 0) continue; // 无数据的来源类别不显示
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `archive-filter-chip ${originFilter === f.value ? 'active' : ''}`;
    chip.innerHTML = `<i class="fa-solid ${f.icon}"></i> ${f.label} (${count})`;
    chip.addEventListener('click', () => {
      if (typeof onFilterChanged === 'function') onFilterChanged(f.value);
    });
    filterBar.appendChild(chip);
  }
  containerEl.appendChild(filterBar);

  // 空状态
  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'archive-empty';
    empty.textContent = files.length === 0
      ? '工作区暂无数据包：上传 Zip、从宿主导出或转换后，数据包会统一出现在这里'
      : '该来源下暂无数据包';
    containerEl.appendChild(empty);
    return;
  }

  // 统一单列表
  const list = document.createElement('div');
  list.className = 'archive-item-list archive-unified-list';
  for (const file of filtered) {
    const item = document.createElement('div');
    const isActive = file.id === activeFileId;
    item.className = `archive-card ${isActive ? 'active' : ''}`;

    const infoWrap = document.createElement('div');
    infoWrap.className = 'archive-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'archive-name';
    nameEl.textContent = file.name;
    nameEl.title = file.name;

    const label = ORIGIN_LABELS[file.origin] || { text: file.origin || '上传', cls: 'origin-upload' };
    const metaEl = document.createElement('div');
    metaEl.className = 'archive-meta';
    metaEl.innerHTML = `
      <span class="origin-badge ${label.cls}">${label.text}</span>
      <span class="meta-badge">${(file.layout || '未知').toUpperCase()}</span>
      <span>${formatBytes(file.size)}</span>
      <span>${formatDate(file.createdAt)}</span>
    `;

    infoWrap.appendChild(nameEl);
    infoWrap.appendChild(metaEl);

    const btnWrap = document.createElement('div');
    btnWrap.className = 'archive-buttons';

    if (isActive) {
      const activeBadge = document.createElement('span');
      activeBadge.className = 'badge-active-file';
      activeBadge.textContent = '当前处理中';
      btnWrap.appendChild(activeBadge);
    } else {
      const btnLoad = document.createElement('button');
      btnLoad.type = 'button';
      btnLoad.className = 'btn-archive-action load';
      btnLoad.textContent = '载入';
      btnLoad.title = '载入为当前转换任务的数据源';
      btnLoad.addEventListener('click', async () => {
        const full = await getFile(file.id);
        if (full && typeof onLoadFile === 'function') {
          onLoadFile(full);
        }
      });
      btnWrap.appendChild(btnLoad);
    }

    const btnDownload = document.createElement('button');
    btnDownload.type = 'button';
    btnDownload.className = 'btn-archive-action download';
    btnDownload.textContent = '下载';
    btnDownload.addEventListener('click', async () => {
      const full = await getFile(file.id);
      if (full?.blob) {
        const url = URL.createObjectURL(full.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = full.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    });
    btnWrap.appendChild(btnDownload);

    if (isHostAvailable && typeof onRestoreToHost === 'function') {
      const btnRestore = document.createElement('button');
      btnRestore.type = 'button';
      btnRestore.className = 'btn-archive-action restore';
      btnRestore.innerHTML = '<i class="fa-solid fa-rotate"></i> 写回宿主';
      btnRestore.title = '将该包一键恢复/写入到当前酒馆宿主';
      btnRestore.addEventListener('click', async () => {
        const full = await getFile(file.id);
        if (full?.blob) {
          onRestoreToHost(full);
        }
      });
      btnWrap.appendChild(btnRestore);
    }

    const btnDelete = document.createElement('button');
    btnDelete.type = 'button';
    btnDelete.className = 'btn-archive-action delete';
    btnDelete.textContent = '删除';
    btnDelete.addEventListener('click', async () => {
      if (confirm(`确定要从工作区删除「${file.name}」吗？`)) {
        await deleteFile(file.id);
        if (typeof onListChanged === 'function') onListChanged();
      }
    });
    btnWrap.appendChild(btnDelete);

    item.appendChild(infoWrap);
    item.appendChild(btnWrap);
    list.appendChild(item);
  }
  containerEl.appendChild(list);
}
