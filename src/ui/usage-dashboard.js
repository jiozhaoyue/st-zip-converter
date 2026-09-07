/**
 * 块一顶部两行配额条（2026-09-07 重定义，替换旧「插件 IndexedDB / 页面整体存储」组合）：
 * ①浏览器配额：navigator.storage.estimate()——本页面（含插件 IndexedDB / OPFS）
 *   已用字节 / 浏览器总配额；不支持 estimate 的环境整行隐藏。
 * ②用户配额：Luker 管理员分配给当前用户的存储空间配额（/api/users/storage/inspect
 *   L0 返回 quota.usedBytes/quotaBytes）；非 Luker 宿主或端点不可达时整行隐藏。
 */

import { detectHost } from './host-bridge.js';

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/** 拉取 Luker 原生用户配额（管理员分配）；不可达/非插件返回 null */
async function fetchUserQuota() {
  try {
    const host = detectHost();
    if (host.platform !== 'luker') return null;
    const token = (await (await fetch('/csrf-token', { credentials: 'same-origin' })).json()).token;
    const resp = await fetch('/api/users/storage/inspect', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify({ path: [] }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data?.quota || data.quota.usedBytes == null) return null;
    return data.quota; // { usedBytes, quotaBytes|null(unlimited), over }
  } catch {
    return null;
  }
}

/**
 * 渲染两行配额条（每次数据变化后重入调用）
 * @param {object} params
 * @param {HTMLElement} params.containerEl
 */
export async function renderUsageDashboard({ containerEl }) {
  if (!containerEl) return;
  containerEl.innerHTML = '';

  // 行① 浏览器配额（页面整体，涵盖插件 IndexedDB + OPFS 临时包）
  if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
    try {
      const est = await navigator.storage.estimate();
      if (est && est.quota > 0) {
        const pct = Math.min(100, ((est.usage || 0) / est.quota) * 100);
        const browserSection = document.createElement('div');
        browserSection.className = 'usage-quota-section';
        browserSection.innerHTML = `
          <div class="usage-quota-label">
            <span><i class="fa-solid fa-hard-drive"></i> 浏览器配额</span>
            <span>${formatBytes(est.usage || 0)} / ${formatBytes(est.quota)} (${pct.toFixed(1)}%)</span>
          </div>
          <div class="usage-quota-bar"><div class="usage-quota-fill" style="width:${pct.toFixed(1)}%"></div></div>
        `;
        containerEl.appendChild(browserSection);
      }
    } catch {
      // estimate 失败静默跳过第一行
    }
  }

  // 行② 用户配额（Luker 管理员分配；数据异步到达前占位，慢查询不阻塞首行）
  const userSection = document.createElement('div');
  userSection.className = 'usage-quota-section usage-quota-user';
  userSection.innerHTML = `
    <div class="usage-quota-label">
      <span><i class="fa-solid fa-user-shield"></i> 用户配额</span>
      <span>查询中...</span>
    </div>
    <div class="usage-quota-bar"><div class="usage-quota-fill usage-quota-fill-page" style="width:0%"></div></div>
  `;
  containerEl.appendChild(userSection);

  fetchUserQuota().then((quota) => {
    // 渲染期间容器可能已被重建，校验仍在 DOM
    if (!quota || !containerEl.isConnected || !containerEl.contains(userSection)) return;
    const { usedBytes, quotaBytes, over } = quota;
    const pct = quotaBytes > 0 ? Math.min(100, (usedBytes / quotaBytes) * 100) : 0;
    const detail = quotaBytes == null
      ? `${formatBytes(usedBytes)} / 无限制`
      : `${formatBytes(usedBytes)} / ${formatBytes(quotaBytes)} (${pct.toFixed(1)}%)`;
    userSection.innerHTML = `
      <div class="usage-quota-label">
        <span><i class="fa-solid fa-user-shield"></i> 用户配额${over ? '（已超限）' : ''}</span>
        <span>${detail}</span>
      </div>
      <div class="usage-quota-bar"><div class="usage-quota-fill ${over ? 'usage-quota-fill-page' : ''}" style="width:${over ? 100 : pct.toFixed(1)}%"></div></div>
    `;
  }).catch(() => {
    if (containerEl.isConnected && containerEl.contains(userSection)) userSection.remove();
  });
}
