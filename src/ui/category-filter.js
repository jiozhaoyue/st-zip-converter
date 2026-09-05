import { CATEGORIES, CATEGORY_LABELS } from '../core/inspect.js';
import { ACTION_LABELS, SPECIAL_CATEGORIES, SPECIAL_LABELS } from '../core/plan-preview.js';
import { createCategoryDetailList } from './file-tree-picker.js';

const CATEGORY_ICONS = {
  [CATEGORIES.CHARACTERS]: '🎭',
  [CATEGORIES.CHATS]: '💬',
  [CATEGORIES.LOREBOOKS]: '📖',
  [CATEGORIES.PRESETS]: '⚙️',
  [CATEGORIES.SETTINGS]: '🛠️',
  [CATEGORIES.SECRETS]: '🔑',
  [CATEGORIES.ASSETS]: '🖼️',
  [CATEGORIES.EXTENSIONS]: '🧩',
  [CATEGORIES.GLOBAL_EXTENSIONS]: '🌐',
  [CATEGORIES.VECTORS]: '🧠',
  [SPECIAL_CATEGORIES.BACKUPS]: '📦',
  [SPECIAL_CATEGORIES.CACHE]: '⚡',
  [SPECIAL_CATEGORIES.APP_PRIVATE]: '🔒',
};

let currentSelection = {
  characters: true,
  chats: true,
  lorebooks: true,
  presets: true,
  settings: true,
  secrets: true,
  assets: true,
  extensions: true,
  globalExtensions: true,
  vectors: true,
  backups: true,
  cache: false,
  appPrivate: false,
};

let currentExcludedPaths = new Set();
let availableCategories = new Set();
let expandedCategories = new Set();
let currentPlan = null;
let onSelectionChangeCallback = null;

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * 更新类目头部摘要统计（如：已选 4/6 项）
 */
function updateSummaryBadge() {
  const badge = document.getElementById('category-summary-badge');
  if (!badge) return;

  const totalAvail = availableCategories.size;
  if (totalAvail === 0) {
    badge.textContent = '';
    return;
  }

  let selectedAvail = 0;
  for (const cat of availableCategories) {
    if (currentSelection[cat]) selectedAvail += 1;
  }

  const excludedCount = currentExcludedPaths.size;
  const excludedSuffix = excludedCount > 0 ? ` (穿透排除 ${excludedCount} 个文件)` : '';
  badge.textContent = `已选 ${selectedAvail}/${totalAvail} 类目${excludedSuffix}`;
}

/**
 * 初始化类目过滤器组件事件监听
 * @param {object} params
 * @param {function} [params.onSelectionChange]
 */
export function setupCategoryFilter({ onSelectionChange } = {}) {
  onSelectionChangeCallback = onSelectionChange;
  const panel = document.getElementById('category-panel');
  if (!panel) return;

  const btnSelectAll = document.getElementById('btn-select-all');
  if (btnSelectAll) {
    btnSelectAll.addEventListener('click', selectAll);
  }

  const btnDeselectAll = document.getElementById('btn-deselect-all');
  if (btnDeselectAll) {
    btnDeselectAll.addEventListener('click', deselectAll);
  }

  const btnInvertSelect = document.getElementById('btn-invert-select');
  if (btnInvertSelect) {
    btnInvertSelect.addEventListener('click', invertSelection);
  }

  const quickButtons = panel.querySelectorAll('.btn-quick');
  quickButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset;
      applyPreset(preset);
    });
  });
}

/**
 * 依据 inspectArchive 或 generatePlan 结果渲染细粒度类目卡片与动作预测条
 * @param {object} planOrInspectResult
 */
export function renderCategoryStats(planOrInspectResult) {
  const panel = document.getElementById('category-panel');
  const container = document.getElementById('category-checkboxes');
  const planSummaryBar = document.getElementById('plan-summary-bar');
  const actionBadgesEl = document.getElementById('action-stats-badges');
  const outputEstimateEl = document.getElementById('output-estimate-text');

  if (!panel || !container || !planOrInspectResult?.categories) return;

  currentPlan = planOrInspectResult;

  // 1. 渲染完全扫描动作预测汇总条
  if (planSummaryBar && planOrInspectResult.actionStats) {
    planSummaryBar.style.display = 'flex';
    if (actionBadgesEl) {
      actionBadgesEl.innerHTML = '';
      for (const [actionKey, count] of Object.entries(planOrInspectResult.actionStats)) {
        if (count > 0) {
          const info = ACTION_LABELS[actionKey] || { label: actionKey, color: '#9ca3af' };
          const badge = document.createElement('span');
          badge.className = `action-summary-pill pill-${actionKey.toLowerCase()}`;
          badge.textContent = `${info.label} ${count}`;
          badge.style.borderColor = info.color;
          badge.style.color = info.color;
          actionBadgesEl.appendChild(badge);
        }
      }
    }
    if (outputEstimateEl) {
      const outFiles = planOrInspectResult.expectedOutputFiles ?? 0;
      const outBytes = planOrInspectResult.expectedOutputBytes ?? 0;
      outputEstimateEl.textContent = `预计产物: ${outFiles} 个文件 · ${formatBytes(outBytes)}`;
    }
  }

  // 2. 渲染类目卡片与穿透明细
  container.innerHTML = '';
  availableCategories.clear();

  for (const [key, data] of Object.entries(planOrInspectResult.categories)) {
    const isAvailable = (data.count || 0) > 0;
    if (isAvailable) {
      availableCategories.add(key);
      if (typeof currentSelection[key] === 'undefined') {
        currentSelection[key] = (key !== SPECIAL_CATEGORIES.CACHE);
      }
    } else {
      currentSelection[key] = false;
    }

    const card = document.createElement('div');
    card.className = `category-card ${isAvailable ? '' : 'disabled'}`;
    card.dataset.category = key;

    const header = document.createElement('div');
    header.className = 'category-card-header';

    const labelWrap = document.createElement('label');
    labelWrap.className = 'category-item-label';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.category = key;
    checkbox.disabled = !isAvailable;

    // 检查该分类下是否部分被单项排除
    const items = data.items || [];
    let excludedInThisCat = 0;
    items.forEach((it) => {
      if (currentExcludedPaths.has(it.sourcePath) || currentExcludedPaths.has(it.hubPath)) {
        excludedInThisCat += 1;
      }
    });

    if (!isAvailable) {
      checkbox.checked = false;
    } else if (currentSelection[key] === false) {
      checkbox.checked = false;
      checkbox.indeterminate = false;
    } else if (excludedInThisCat === 0) {
      checkbox.checked = true;
      checkbox.indeterminate = false;
    } else if (excludedInThisCat >= items.length) {
      checkbox.checked = false;
      checkbox.indeterminate = false;
    } else {
      checkbox.checked = false;
      checkbox.indeterminate = true;
    }

    checkbox.addEventListener('change', (e) => {
      const isChecked = e.target.checked;
      currentSelection[key] = isChecked;
      checkbox.indeterminate = false;

      // 如果勾选整个类目，清除属于该类目的单项排除
      if (isChecked) {
        items.forEach((it) => {
          currentExcludedPaths.delete(it.sourcePath);
          currentExcludedPaths.delete(it.hubPath);
        });
      } else {
        // 如果取消整个类目，清除单项排除避免冗余记录
        items.forEach((it) => {
          currentExcludedPaths.delete(it.sourcePath);
          currentExcludedPaths.delete(it.hubPath);
        });
      }

      updateSummaryBadge();
      notifySelectionChanged();
    });

    const icon = document.createElement('span');
    icon.className = 'cat-icon';
    icon.textContent = CATEGORY_ICONS[key] || '📁';

    const text = document.createElement('span');
    text.className = 'cat-text';
    text.textContent = data.label || CATEGORY_LABELS[key] || SPECIAL_LABELS[key] || key;

    labelWrap.appendChild(checkbox);
    labelWrap.appendChild(icon);
    labelWrap.appendChild(text);

    const rightGroup = document.createElement('div');
    rightGroup.className = 'category-right-group';

    const badge = document.createElement('span');
    badge.className = 'cat-badge';
    badge.textContent = isAvailable ? `${data.count} 项 · ${formatBytes(data.sizeBytes)}` : '0 项 · 0 B';

    rightGroup.appendChild(badge);

    // 如果包含单文件详情，渲染展开/收起按钮
    if (items.length > 0) {
      const isExpanded = expandedCategories.has(key);
      const btnExpand = document.createElement('button');
      btnExpand.type = 'button';
      btnExpand.className = 'btn-expand-detail';
      btnExpand.textContent = isExpanded ? '收起 ▴' : '明细 ▾';
      btnExpand.title = isExpanded ? '收起单项文件明细' : '展开查看该类目下的每个文件与动作，支持穿透反选';

      btnExpand.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (expandedCategories.has(key)) {
          expandedCategories.delete(key);
        } else {
          expandedCategories.add(key);
        }
        renderCategoryStats(currentPlan);
      });

      rightGroup.appendChild(btnExpand);
    }

    header.appendChild(labelWrap);
    header.appendChild(rightGroup);
    card.appendChild(header);

    // 展开的内容区域
    if (items.length > 0 && expandedCategories.has(key)) {
      const detailView = createCategoryDetailList({
        categoryKey: key,
        items,
        excludedPaths: currentExcludedPaths,
        onItemToggle: (sourcePath, checked) => {
          if (checked) {
            currentExcludedPaths.delete(sourcePath);
          } else {
            currentExcludedPaths.add(sourcePath);
          }
          renderCategoryStats(currentPlan);
          notifySelectionChanged();
        },
      });
      card.appendChild(detailView);
    }

    container.appendChild(card);
  }

  updateSummaryBadge();
  panel.style.display = 'block';
}

function notifySelectionChanged() {
  if (typeof onSelectionChangeCallback === 'function') {
    onSelectionChangeCallback({
      selection: getSelectionState(),
      excludedPaths: getExcludedPaths(),
    });
  }
}

/**
 * 全选所有包内存在的有效类目并清空单项排除
 */
export function selectAll() {
  availableCategories.forEach((cat) => {
    currentSelection[cat] = true;
  });
  currentExcludedPaths.clear();

  if (currentPlan) renderCategoryStats(currentPlan);
  updateSummaryBadge();
  notifySelectionChanged();
}

/**
 * 取消所有类目的勾选
 */
export function deselectAll() {
  availableCategories.forEach((cat) => {
    currentSelection[cat] = false;
  });
  currentExcludedPaths.clear();

  if (currentPlan) renderCategoryStats(currentPlan);
  updateSummaryBadge();
  notifySelectionChanged();
}

/**
 * 反选所有包内存在的有效类目
 */
export function invertSelection() {
  availableCategories.forEach((cat) => {
    currentSelection[cat] = !currentSelection[cat];
  });
  currentExcludedPaths.clear();

  if (currentPlan) renderCategoryStats(currentPlan);
  updateSummaryBadge();
  notifySelectionChanged();
}

/**
 * 应用辅助快捷筛选预设
 * @param {'chars'|'safe'} preset
 */
export function applyPreset(preset) {
  currentExcludedPaths.clear();

  availableCategories.forEach((cat) => {
    if (preset === 'chars') {
      currentSelection[cat] = (cat === CATEGORIES.CHARACTERS || cat === CATEGORIES.ASSETS);
    } else if (preset === 'safe') {
      currentSelection[cat] = (cat !== CATEGORIES.SECRETS && cat !== CATEGORIES.CHATS);
    }
  });

  if (currentPlan) renderCategoryStats(currentPlan);
  updateSummaryBadge();
  notifySelectionChanged();
}

/**
 * 获取当前的 10 大标准类目筛选状态
 * @returns {Record<string, boolean>}
 */
export function getSelectionState() {
  return { ...currentSelection };
}

/**
 * 设置类目筛选状态
 * @param {Record<string, boolean>} selection
 */
export function setSelectionState(selection) {
  currentSelection = { ...currentSelection, ...selection };
}

/**
 * 获取单项穿透排除集合
 * @returns {Set<string>}
 */
export function getExcludedPaths() {
  return new Set(currentExcludedPaths);
}

/**
 * 设置单项穿透排除集合
 * @param {Set<string>|Array<string>} paths
 */
export function setExcludedPaths(paths) {
  currentExcludedPaths = new Set(paths || []);
}

/**
 * 重置过滤器状态并隐藏面板
 */
export function resetCategoryFilter() {
  const panel = document.getElementById('category-panel');
  if (panel) panel.style.display = 'none';
  const container = document.getElementById('category-checkboxes');
  if (container) container.innerHTML = '';
  const planSummaryBar = document.getElementById('plan-summary-bar');
  if (planSummaryBar) planSummaryBar.style.display = 'none';

  availableCategories.clear();
  currentExcludedPaths.clear();
  expandedCategories.clear();
  currentPlan = null;
}
