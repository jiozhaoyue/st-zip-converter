/**
 * 块一顶部两行配额条：
 * ①插件 IndexedDB 用量/配额（getStorageUsage + getStorageQuota）
 * ②页面整体存储 usage/quota（navigator.storage.estimate，与 Luker 原生存储查看同源；
 *   不支持 estimate 的环境整行隐藏）
 */

import { getStorageUsage, getStorageQuota } from '../storage/db.js';

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * 渲染两行配额条（每次数据变化后重入调用）
 * @param {object} params
 * @param {HTMLElement} params.containerEl
 */
export async function renderUsageDashboard({ containerEl }) {
  if (!containerEl) return;
  containerEl.innerHTML = '';

  const [usage, quota] = await Promise.all([getStorageUsage(), getStorageQuota()]);

  // 行① 插件 IndexedDB
  const pluginSection = document.createElement('div');
  pluginSection.className = 'usage-quota-section';
  const pluginPct = quota.quota > 0 ? Math.min(100, (usage.totalBytes / quota.quota) * 100) : 0;
  pluginSection.innerHTML = `
    <div class="usage-quota-label">
      <span><i class="fa-solid fa-database"></i> 插件 IndexedDB (${usage.count} 包)</span>
      <span>${formatBytes(usage.totalBytes)}${quota.quota > 0 ? ` / ${formatBytes(quota.quota)} (${pluginPct.toFixed(1)}%)` : ''}</span>
    </div>
    <div class="usage-quota-bar"><div class="usage-quota-fill" style="width:${pluginPct.toFixed(1)}%"></div></div>
  `;
  containerEl.appendChild(pluginSection);

  // 行② 页面整体存储（不支持 estimate 的环境整行隐藏）
  if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
    try {
      const est = await navigator.storage.estimate();
      if (est && est.quota > 0) {
        const pct = Math.min(100, ((est.usage || 0) / est.quota) * 100);
        const pageSection = document.createElement('div');
        pageSection.className = 'usage-quota-section';
        pageSection.innerHTML = `
          <div class="usage-quota-label">
            <span><i class="fa-solid fa-hard-drive"></i> 页面整体存储</span>
            <span>${formatBytes(est.usage || 0)} / ${formatBytes(est.quota)} (${pct.toFixed(1)}%)</span>
          </div>
          <div class="usage-quota-bar"><div class="usage-quota-fill usage-quota-fill-page" style="width:${pct.toFixed(1)}%"></div></div>
        `;
        containerEl.appendChild(pageSection);
      }
    } catch {
      // estimate 失败静默跳过第二行
    }
  }
}
