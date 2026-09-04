import { CATEGORIES, CATEGORY_LABELS } from '../core/inspect.js';

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
};

let availableCategories = new Set();
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

  badge.textContent = `已选 ${selectedAvail}/${totalAvail} 项有效类目`;
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
 * 依据 inspectArchive 结果动态渲染 10 大标准类目与资产徽标
 * @param {object} inspectResult
 */
export function renderCategoryStats(inspectResult) {
  const panel = document.getElementById('category-panel');
  const container = document.getElementById('category-checkboxes');
  if (!panel || !container || !inspectResult?.categories) return;

  container.innerHTML = '';
  availableCategories.clear();

  for (const [key, data] of Object.entries(inspectResult.categories)) {
    const isAvailable = (data.count || 0) > 0;
    if (isAvailable) {
      availableCategories.add(key);
      currentSelection[key] = true;
    } else {
      currentSelection[key] = false;
    }

    const item = document.createElement('label');
    item.className = `category-item ${isAvailable ? '' : 'disabled'}`;
    item.title = isAvailable ? `${data.label}: ${data.count} 项` : `${data.label}: 源包中未包含此资产`;

    const labelWrap = document.createElement('div');
    labelWrap.className = 'category-item-label';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.category = key;
    checkbox.checked = isAvailable;
    checkbox.disabled = !isAvailable;

    checkbox.addEventListener('change', (e) => {
      currentSelection[key] = e.target.checked;
      updateSummaryBadge();
      if (typeof onSelectionChangeCallback === 'function') {
        onSelectionChangeCallback(getSelectionState());
      }
    });

    const icon = document.createElement('span');
    icon.className = 'cat-icon';
    icon.textContent = CATEGORY_ICONS[key] || '📁';

    const text = document.createElement('span');
    text.className = 'cat-text';
    text.textContent = data.label || CATEGORY_LABELS[key] || key;

    labelWrap.appendChild(checkbox);
    labelWrap.appendChild(icon);
    labelWrap.appendChild(text);

    const badge = document.createElement('span');
    badge.className = 'cat-badge';
    badge.textContent = isAvailable ? `${data.count} 项 · ${formatBytes(data.sizeBytes)}` : '0 项 · 0 B';

    item.appendChild(labelWrap);
    item.appendChild(badge);
    container.appendChild(item);
  }

  updateSummaryBadge();
  panel.style.display = 'block';
}

/**
 * 全选所有包内存在的有效类目
 */
export function selectAll() {
  const checkboxes = document.querySelectorAll('#category-checkboxes input[type="checkbox"]');
  checkboxes.forEach((cb) => {
    if (cb.disabled) return;
    const cat = cb.dataset.category;
    cb.checked = true;
    currentSelection[cat] = true;
  });

  updateSummaryBadge();
  if (typeof onSelectionChangeCallback === 'function') {
    onSelectionChangeCallback(getSelectionState());
  }
}

/**
 * 取消所有类目的勾选
 */
export function deselectAll() {
  const checkboxes = document.querySelectorAll('#category-checkboxes input[type="checkbox"]');
  checkboxes.forEach((cb) => {
    if (cb.disabled) return;
    const cat = cb.dataset.category;
    cb.checked = false;
    currentSelection[cat] = false;
  });

  updateSummaryBadge();
  if (typeof onSelectionChangeCallback === 'function') {
    onSelectionChangeCallback(getSelectionState());
  }
}

/**
 * 反选所有包内存在的有效类目
 */
export function invertSelection() {
  const checkboxes = document.querySelectorAll('#category-checkboxes input[type="checkbox"]');
  checkboxes.forEach((cb) => {
    if (cb.disabled) return;
    const cat = cb.dataset.category;
    cb.checked = !cb.checked;
    currentSelection[cat] = cb.checked;
  });

  updateSummaryBadge();
  if (typeof onSelectionChangeCallback === 'function') {
    onSelectionChangeCallback(getSelectionState());
  }
}

/**
 * 应用辅助快捷筛选预设
 * @param {'chars'|'safe'} preset
 */
export function applyPreset(preset) {
  const checkboxes = document.querySelectorAll('#category-checkboxes input[type="checkbox"]');

  checkboxes.forEach((cb) => {
    if (cb.disabled) return;
    const cat = cb.dataset.category;

    if (preset === 'chars') {
      // 仅角色卡与素材
      cb.checked = (cat === CATEGORIES.CHARACTERS || cat === CATEGORIES.ASSETS);
    } else if (preset === 'safe') {
      // 安全脱敏：排除 secrets 和 chats
      cb.checked = (cat !== CATEGORIES.SECRETS && cat !== CATEGORIES.CHATS);
    }

    currentSelection[cat] = cb.checked;
  });

  updateSummaryBadge();
  if (typeof onSelectionChangeCallback === 'function') {
    onSelectionChangeCallback(getSelectionState());
  }
}

/**
 * 获取当前的 10 大标准类目筛选状态
 * @returns {Record<string, boolean>}
 */
export function getSelectionState() {
  return { ...currentSelection };
}

/**
 * 重置过滤器状态并隐藏面板
 */
export function resetCategoryFilter() {
  const panel = document.getElementById('category-panel');
  if (panel) panel.style.display = 'none';
  const container = document.getElementById('category-checkboxes');
  if (container) container.innerHTML = '';
  availableCategories.clear();
}
