/**
 * 可穿透单项文件树与动作预览选择器 (File Tree Picker)
 * 允许用户穿透展开任意类目，查看每一个文件的目标归宿与计划动作 (直通/路由/迁移/合成/丢弃)，
 * 并支持单文件精确反选、即时模糊搜索、动作筛选联动、体积排序与大文件醒目标注。
 */

import { ACTION_LABELS, ACTIONS } from '../core/plan-preview.js';

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * 渲染单个类目的文件明细列表
 * @param {object} params
 * @param {string} params.categoryKey 类目标识
 * @param {Array<object>} params.items 条目列表
 * @param {Set<string>} params.excludedPaths 排除集合
 * @param {string|null} [params.actionFilter] 动作过滤类型 (如 'ROUTE')
 * @param {function(string, boolean): void} params.onItemToggle
 * @returns {HTMLElement}
 */
export function createCategoryDetailList({ categoryKey, items, excludedPaths, actionFilter = null, onItemToggle }) {
  const container = document.createElement('div');
  container.className = 'category-detail-container';
  container.id = `detail-${categoryKey}`;

  if (!items || items.length === 0) {
    const emptyNotice = document.createElement('div');
    emptyNotice.className = 'detail-empty';
    emptyNotice.textContent = '此分类下暂无文件';
    container.appendChild(emptyNotice);
    return container;
  }

  // 工具行：搜索 + 排序
  const toolRow = document.createElement('div');
  toolRow.className = 'detail-tool-row';

  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = `搜索此分类 ${items.length} 个文件...`;
  searchInput.className = 'detail-search-input';

  const sortSelect = document.createElement('select');
  sortSelect.className = 'detail-sort-select';
  sortSelect.innerHTML = `
    <option value="default">默认顺序</option>
    <option value="size-desc">体积降序 (大文件优先)</option>
    <option value="name-asc">文件名 A-Z</option>
  `;

  toolRow.appendChild(searchInput);
  toolRow.appendChild(sortSelect);
  container.appendChild(toolRow);

  // 文件列表
  const listEl = document.createElement('div');
  listEl.className = 'detail-file-list';

  let currentSort = 'default';

  function renderList(filterQuery = '') {
    listEl.innerHTML = '';
    const q = filterQuery.trim().toLowerCase();

    let processed = items;

    // 1. 动作过滤联动
    if (actionFilter) {
      processed = processed.filter((it) => it.action === actionFilter);
    }

    // 2. 文本搜索过滤
    if (q) {
      processed = processed.filter((it) =>
        it.sourcePath.toLowerCase().includes(q)
        || (it.targetPath && it.targetPath.toLowerCase().includes(q))
        || (it.reason && it.reason.toLowerCase().includes(q)),
      );
    }

    // 3. 排序
    if (currentSort === 'size-desc') {
      processed = [...processed].sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));
    } else if (currentSort === 'name-asc') {
      processed = [...processed].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
    }

    if (processed.length === 0) {
      const noMatch = document.createElement('div');
      noMatch.className = 'detail-empty';
      noMatch.textContent = actionFilter
        ? `未找到动作为 [${ACTION_LABELS[actionFilter]?.label || actionFilter}] 的匹配文件`
        : '未找到匹配文件';
      listEl.appendChild(noMatch);
      return;
    }

    processed.forEach((item) => {
      const row = document.createElement('div');
      const isLargeHeavy = (item.sizeBytes || 0) >= 5 * 1024 * 1024;
      const isLargeWarn = !isLargeHeavy && (item.sizeBytes || 0) >= 1 * 1024 * 1024;

      row.className = `file-detail-row ${item.action.toLowerCase()} ${isLargeHeavy ? 'large-heavy' : ''} ${isLargeWarn ? 'large-warn' : ''}`;

      const isExcluded = excludedPaths.has(item.sourcePath) || excludedPaths.has(item.hubPath);
      const isDrop = item.rawAction === ACTIONS.DROP;

      // 复选框
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !isExcluded && !isDrop;
      cb.disabled = isDrop;
      cb.className = 'file-item-checkbox';

      cb.addEventListener('change', (e) => {
        const checked = e.target.checked;
        if (typeof onItemToggle === 'function') {
          onItemToggle(item.sourcePath, checked);
        }
      });

      // 路径信息
      const pathWrap = document.createElement('div');
      pathWrap.className = 'file-path-wrap';

      const srcPathEl = document.createElement('span');
      srcPathEl.className = 'file-src-path';
      srcPathEl.textContent = item.sourcePath;
      srcPathEl.title = item.sourcePath;

      pathWrap.appendChild(srcPathEl);

      if (item.targetPath && item.targetPath !== item.sourcePath) {
        const arrow = document.createElement('span');
        arrow.className = 'file-path-arrow';
        arrow.textContent = '→';

        const tgtPathEl = document.createElement('span');
        tgtPathEl.className = 'file-tgt-path';
        tgtPathEl.textContent = item.targetPath;
        tgtPathEl.title = item.targetPath;

        pathWrap.appendChild(arrow);
        pathWrap.appendChild(tgtPathEl);
      }

      if (item.reason) {
        const reasonEl = document.createElement('span');
        reasonEl.className = 'file-action-reason';
        reasonEl.textContent = `(${item.reason})`;
        pathWrap.appendChild(reasonEl);
      }

      // 动作 Badge 与大文件警示
      const metaWrap = document.createElement('div');
      metaWrap.className = 'file-meta-wrap';

      if (isLargeHeavy) {
        const heavyBadge = document.createElement('span');
        heavyBadge.className = 'badge-large-file heavy';
        heavyBadge.innerHTML = '<i class="fa-solid fa-fire"></i> >5MB';
        heavyBadge.title = '超大文件：请注意备份包总下载体积';
        metaWrap.appendChild(heavyBadge);
      } else if (isLargeWarn) {
        const warnBadge = document.createElement('span');
        warnBadge.className = 'badge-large-file warn';
        warnBadge.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> >1MB';
        warnBadge.title = '较大文件';
        metaWrap.appendChild(warnBadge);
      }

      const actionInfo = ACTION_LABELS[item.action] || { label: item.action, color: '#6b7280' };
      const actionPill = document.createElement('span');
      actionPill.className = `action-pill pill-${item.action.toLowerCase()}`;
      actionPill.textContent = actionInfo.label;
      actionPill.title = actionInfo.desc || item.action;
      actionPill.style.borderColor = actionInfo.color;
      actionPill.style.color = actionInfo.color;

      const sizeSpan = document.createElement('span');
      sizeSpan.className = 'file-size-span';
      sizeSpan.textContent = formatBytes(item.sizeBytes);

      metaWrap.appendChild(actionPill);
      metaWrap.appendChild(sizeSpan);

      row.appendChild(cb);
      row.appendChild(pathWrap);
      row.appendChild(metaWrap);
      listEl.appendChild(row);
    });
  }

  searchInput.addEventListener('input', (e) => {
    renderList(e.target.value);
  });

  sortSelect.addEventListener('change', (e) => {
    currentSort = e.target.value;
    renderList(searchInput.value);
  });

  renderList();
  container.appendChild(listEl);
  return container;
}
