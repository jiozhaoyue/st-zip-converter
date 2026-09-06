/**
 * 工作区用量看板 (Usage Dashboard)
 * 可视化展示：IndexedDB 配额条 + 按来源分组的包统计 + 包体积列表。
 */

import { getStorageUsage, getStorageQuota, listStoredFiles } from '../storage/db.js';
import { ORIGINS } from '../storage/db.js';

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

const ORIGIN_LABELS = {
  [ORIGINS.UPLOAD]: { text: '上传', cls: 'origin-upload' },
  [ORIGINS.HOST_EXPORT]: { text: '宿主导出', cls: 'origin-host' },
  [ORIGINS.CONVERTED]: { text: '转换生成', cls: 'origin-converted' },
  [ORIGINS.DELTA]: { text: '增量补丁', cls: 'origin-delta' },
  [ORIGINS.SPLIT_PART]: { text: '分卷', cls: 'origin-split' },
};

/**
 * 渲染用量看板（每次数据变化后重入调用）
 * @param {object} params
 * @param {HTMLElement} params.containerEl
 */
export async function renderUsageDashboard({ containerEl }) {
  if (!containerEl) return;

  const [usage, quota] = await Promise.all([getStorageUsage(), getStorageQuota()]);

  containerEl.innerHTML = '';

  // 配额条
  const quotaSection = document.createElement('div');
  quotaSection.className = 'usage-quota-section';
  const pct = quota.quota > 0 ? Math.min(100, (quota.usage / quota.quota) * 100) : 0;
  quotaSection.innerHTML = `
    <div class="usage-quota-label">
      <span><i class="fa-solid fa-database"></i> IndexedDB 用量</span>
      <span>${formatBytes(quota.usage)}${quota.quota > 0 ? ` / ${formatBytes(quota.quota)} (${pct.toFixed(1)}%)` : ''}</span>
    </div>
    <div class="usage-quota-bar"><div class="usage-quota-fill" style="width:${pct.toFixed(1)}%"></div></div>
  `;
  containerEl.appendChild(quotaSection);

  // 按来源分组统计
  const originSection = document.createElement('div');
  originSection.className = 'usage-origin-section';
  const originEntries = Object.entries(usage.byOrigin || {});
  if (originEntries.length > 0) {
    const chips = document.createElement('div');
    chips.className = 'usage-origin-chips';
    for (const [origin, stat] of originEntries) {
      const label = ORIGIN_LABELS[origin] || { text: origin, cls: 'origin-upload' };
      const chip = document.createElement('span');
      chip.className = `usage-origin-chip ${label.cls}`;
      chip.innerHTML = `<span class="origin-badge ${label.cls}">${label.text}</span> ${stat.count} 个 · ${formatBytes(stat.totalBytes)}`;
      chips.appendChild(chip);
    }
    originSection.appendChild(chips);
  } else {
    const empty = document.createElement('div');
    empty.className = 'usage-empty';
    empty.textContent = '工作区暂无数据包';
    originSection.appendChild(empty);
  }
  containerEl.appendChild(originSection);
}

/**
 * 渲染包体积列表（名字/大小/来源/时间，按体积降序）
 * @param {object} params
 * @param {HTMLElement} params.containerEl
 */
export async function renderPackageSizeList({ containerEl }) {
  if (!containerEl) return;
  const files = await listStoredFiles();
  const sorted = [...files].sort((a, b) => (b.size || 0) - (a.size || 0));

  containerEl.innerHTML = '';
  if (sorted.length === 0) {
    containerEl.innerHTML = '<div class="usage-empty">暂无包体积数据</div>';
    return;
  }

  const list = document.createElement('div');
  list.className = 'usage-size-list';
  for (const file of sorted) {
    const label = ORIGIN_LABELS[file.origin] || { text: file.origin, cls: 'origin-upload' };
    const row = document.createElement('div');
    row.className = 'usage-size-row';
    row.innerHTML = `
      <span class="usage-size-name" title="${file.name}">${file.name}</span>
      <span class="origin-badge ${label.cls}">${label.text}</span>
      <span class="usage-size-bytes">${formatBytes(file.size)}</span>
    `;
    list.appendChild(row);
  }
  containerEl.appendChild(list);
}
