/**
 * 工作区双文件列表管理器 (Archive Manager)
 * 分离管控【已上传/暂存源包】与【已转换生成包】，支持即时载入、重新下载与删除。
 */

import { listSourceFiles, listOutputFiles, getFile, deleteFile } from '../storage/db.js';

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

/**
 * 渲染双文件列表面板
 * @param {object} params
 * @param {HTMLElement} params.containerEl 挂载容器
 * @param {string|null} params.activeFileId 当前活跃文件 ID
 * @param {function(object): void} params.onLoadFile 载入文件回调
 * @param {function(): void} params.onListChanged 列表变更回调
 */
export async function renderArchiveManager({ containerEl, activeFileId, onLoadFile, onListChanged }) {
  if (!containerEl) return;

  const [sources, outputs] = await Promise.all([
    listSourceFiles(),
    listOutputFiles(),
  ]);

  containerEl.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'archive-manager-grid';

  // 1. 左栏：已上传源包
  const sourceCol = document.createElement('div');
  sourceCol.className = 'archive-col archive-col-sources';

  const sourceHeader = document.createElement('div');
  sourceHeader.className = 'archive-col-header';
  sourceHeader.innerHTML = `
    <span class="col-title">📥 已上传源包 (${sources.length})</span>
    <span class="col-desc">暂存的源备份包</span>
  `;
  sourceCol.appendChild(sourceHeader);

  const sourceList = document.createElement('div');
  sourceList.className = 'archive-item-list';

  if (sources.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'archive-empty';
    empty.textContent = '暂无上传的源包';
    sourceList.appendChild(empty);
  } else {
    sources.forEach((file) => {
      const item = document.createElement('div');
      const isActive = file.id === activeFileId;
      item.className = `archive-card ${isActive ? 'active' : ''}`;

      const infoWrap = document.createElement('div');
      infoWrap.className = 'archive-info';

      const nameEl = document.createElement('div');
      nameEl.className = 'archive-name';
      nameEl.textContent = file.name;
      nameEl.title = file.name;

      const metaEl = document.createElement('div');
      metaEl.className = 'archive-meta';
      metaEl.innerHTML = `
        <span class="meta-badge">${(file.layout || '未知').toUpperCase()}</span>
        <span>${formatBytes(file.size)}</span>
        <span>${formatDate(file.createdAt)}</span>
      `;

      infoWrap.appendChild(nameEl);
      infoWrap.appendChild(metaEl);

      const btnWrap = document.createElement('div');
      btnWrap.className = 'archive-buttons';

      if (!isActive) {
        const btnLoad = document.createElement('button');
        btnLoad.type = 'button';
        btnLoad.className = 'btn-archive-action load';
        btnLoad.textContent = '载入';
        btnLoad.addEventListener('click', async () => {
          const full = await getFile(file.id);
          if (full && typeof onLoadFile === 'function') {
            onLoadFile(full);
          }
        });
        btnWrap.appendChild(btnLoad);
      } else {
        const activeBadge = document.createElement('span');
        activeBadge.className = 'badge-active-file';
        activeBadge.textContent = '当前处理中';
        btnWrap.appendChild(activeBadge);
      }

      const btnDelete = document.createElement('button');
      btnDelete.type = 'button';
      btnDelete.className = 'btn-archive-action delete';
      btnDelete.textContent = '删除';
      btnDelete.addEventListener('click', async () => {
        if (confirm(`确定要从暂存中删除「${file.name}」吗？`)) {
          await deleteFile(file.id);
          if (typeof onListChanged === 'function') onListChanged();
          renderArchiveManager({ containerEl, activeFileId, onLoadFile, onListChanged });
        }
      });
      btnWrap.appendChild(btnDelete);

      item.appendChild(infoWrap);
      item.appendChild(btnWrap);
      sourceList.appendChild(item);
    });
  }
  sourceCol.appendChild(sourceList);

  // 2. 右栏：已转换生成包
  const outputCol = document.createElement('div');
  outputCol.className = 'archive-col archive-col-outputs';

  const outputHeader = document.createElement('div');
  outputHeader.className = 'archive-col-header';
  outputHeader.innerHTML = `
    <span class="col-title">📤 已转换生成包 (${outputs.length})</span>
    <span class="col-desc">暂存的转换产物</span>
  `;
  outputCol.appendChild(outputHeader);

  const outputList = document.createElement('div');
  outputList.className = 'archive-item-list';

  if (outputs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'archive-empty';
    empty.textContent = '暂未生成转换产物';
    outputList.appendChild(empty);
  } else {
    outputs.forEach((file) => {
      const item = document.createElement('div');
      item.className = 'archive-card';

      const infoWrap = document.createElement('div');
      infoWrap.className = 'archive-info';

      const nameEl = document.createElement('div');
      nameEl.className = 'archive-name';
      nameEl.textContent = file.name;
      nameEl.title = file.name;

      const metaEl = document.createElement('div');
      metaEl.className = 'archive-meta';
      metaEl.innerHTML = `
        <span class="meta-badge output">${(file.layout || '产物').toUpperCase()}</span>
        <span>${formatBytes(file.size)}</span>
        <span>${formatDate(file.createdAt)}</span>
      `;

      infoWrap.appendChild(nameEl);
      infoWrap.appendChild(metaEl);

      const btnWrap = document.createElement('div');
      btnWrap.className = 'archive-buttons';

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
          URL.revokeObjectURL(url);
        }
      });
      btnWrap.appendChild(btnDownload);

      const btnLoadAsSource = document.createElement('button');
      btnLoadAsSource.type = 'button';
      btnLoadAsSource.className = 'btn-archive-action load-source';
      btnLoadAsSource.textContent = '作为源包';
      btnLoadAsSource.title = '将该转换结果作为新的源数据包载入，进行多跳再转换';
      btnLoadAsSource.addEventListener('click', async () => {
        const full = await getFile(file.id);
        if (full && typeof onLoadFile === 'function') {
          onLoadFile(full);
        }
      });
      btnWrap.appendChild(btnLoadAsSource);

      const btnDelete = document.createElement('button');
      btnDelete.type = 'button';
      btnDelete.className = 'btn-archive-action delete';
      btnDelete.textContent = '删除';
      btnDelete.addEventListener('click', async () => {
        if (confirm(`确定要从暂存中删除产物「${file.name}」吗？`)) {
          await deleteFile(file.id);
          if (typeof onListChanged === 'function') onListChanged();
          renderArchiveManager({ containerEl, activeFileId, onLoadFile, onListChanged });
        }
      });
      btnWrap.appendChild(btnDelete);

      item.appendChild(infoWrap);
      item.appendChild(btnWrap);
      outputList.appendChild(item);
    });
  }
  outputCol.appendChild(outputList);

  grid.appendChild(sourceCol);
  grid.appendChild(outputCol);
  containerEl.appendChild(grid);
}
