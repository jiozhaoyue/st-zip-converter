import { CATEGORIES, CATEGORY_LABELS } from '../core/inspect.js';

let currentSelection = {
  characters: true,
  chats: true,
  worlds: true,
  settings: true,
  secrets: true,
  avatars: true,
  extensions: true,
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
 * 初始化类目过滤器组件与预设按钮
 * @param {object} params
 * @param {function} [params.onSelectionChange]
 */
export function setupCategoryFilter({ onSelectionChange } = {}) {
  onSelectionChangeCallback = onSelectionChange;
  const panel = document.getElementById('category-panel');
  if (!panel) return;

  const presetButtons = panel.querySelectorAll('.btn-preset');
  presetButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset;
      applyPreset(preset);
    });
  });
}

/**
 * 依据 inspectArchive 结果动态渲染类目清单与资产徽标
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

    const labelWrap = document.createElement('div');
    labelWrap.className = 'category-item-label';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.category = key;
    checkbox.checked = isAvailable;
    checkbox.disabled = !isAvailable;

    checkbox.addEventListener('change', (e) => {
      currentSelection[key] = e.target.checked;
      if (typeof onSelectionChangeCallback === 'function') {
        onSelectionChangeCallback(getSelectionState());
      }
    });

    const text = document.createElement('span');
    text.textContent = data.label || CATEGORY_LABELS[key] || key;

    labelWrap.appendChild(checkbox);
    labelWrap.appendChild(text);

    const badge = document.createElement('span');
    badge.className = 'cat-badge';
    badge.textContent = isAvailable ? `${data.count} 项 · ${formatBytes(data.sizeBytes)}` : '无';

    item.appendChild(labelWrap);
    item.appendChild(badge);
    container.appendChild(item);
  }

  panel.style.display = 'block';
}

/**
 * 应用快速脱敏与筛选预设
 * @param {'all'|'chars'|'chars-worlds'|'safe'} preset
 */
export function applyPreset(preset) {
  const checkboxes = document.querySelectorAll('#category-checkboxes input[type="checkbox"]');

  checkboxes.forEach((cb) => {
    if (cb.disabled) return;
    const cat = cb.dataset.category;

    if (preset === 'all') {
      cb.checked = true;
    } else if (preset === 'chars') {
      cb.checked = (cat === CATEGORIES.CHARACTERS || cat === CATEGORIES.AVATARS);
    } else if (preset === 'chars-worlds') {
      cb.checked = (cat === CATEGORIES.CHARACTERS || cat === CATEGORIES.AVATARS || cat === CATEGORIES.WORLDS);
    } else if (preset === 'safe') {
      // 安全脱敏：排除 secrets 和 chats
      cb.checked = (cat !== CATEGORIES.SECRETS && cat !== CATEGORIES.CHATS);
    }

    currentSelection[cat] = cb.checked;
  });

  if (typeof onSelectionChangeCallback === 'function') {
    onSelectionChangeCallback(getSelectionState());
  }
}

/**
 * 获取当前的类目筛选状态
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
