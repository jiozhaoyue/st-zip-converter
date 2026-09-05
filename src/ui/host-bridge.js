/**
 * 宿主环境桥接与增量流控模块 (SillyTavern & Luker)
 * 负责环境嗅探、CSRF Token 获取、细粒度备份拉取、增量恢复写入与多包增量合并。
 */

import { logger } from '../core/logger.js';
import { zipIo } from '../core/zip-io.js';
import * as zip from '../vendor/zip.js';

export const FULL_SELECTION = Object.freeze({
  settings: true,
  secrets: true,
  characters: true,
  chats: true,
  lorebooks: true,
  presets: true,
  assets: true,
  extensions: true,
  globalExtensions: true,
  vectors: true,
});

/**
 * 检测当前运行环境
 * @returns {{ platform: 'st'|'luker'|'standalone', isPlugin: boolean }}
 */
export function detectHost() {
  const isLuker = typeof window !== 'undefined' && (typeof window.luker !== 'undefined' || Boolean(document.querySelector('#luker-app')));
  const isST = typeof window !== 'undefined' && (typeof window.SillyTavern !== 'undefined' || Boolean(document.querySelector('#extensionsMenu')));

  if (isLuker) return { platform: 'luker', isPlugin: true };
  if (isST) return { platform: 'st', isPlugin: true };
  return { platform: 'standalone', isPlugin: false };
}

/**
 * 获取宿主 CSRF Token
 */
export async function getCsrfToken() {
  const response = await fetch('/csrf-token', { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`获取 CSRF token 失败: ${response.status}`);
  const data = await response.json();
  return data.token;
}

/**
 * 获取当前登录用户句柄
 */
export async function getHandle() {
  const response = await fetch('/api/users/me', { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`获取当前用户失败: ${response.status}`);
  const data = await response.json();
  return data.handle;
}

/**
 * 从当前酒馆端点拉取细粒度或全量备份 Zip Blob
 * @param {'st'|'luker'} platform
 * @param {Record<string, boolean>} [selection] 细粒度类目选择
 * @returns {Promise<Blob>}
 */
export async function fetchHostBackup(platform, selection = null) {
  logger.info(`正在连接宿主 [${platform.toUpperCase()}] 获取授权凭证...`);
  const [token, handle] = await Promise.all([getCsrfToken(), getHandle()]);

  const sel = selection ? { ...selection } : { ...FULL_SELECTION };
  const body = platform === 'luker'
    ? { handle, selection: sel }
    : { handle, selection: sel };

  logger.info(`向宿主发起数据包导出请求 (用户: ${handle})...`);

  const response = await fetch('/api/users/backup', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': token,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let detail = '';
    try {
      const errJson = await response.json();
      detail = errJson.error ?? '';
    } catch {
      // 忽略非 JSON 响应
    }
    const err = new Error(`备份请求失败 (${response.status})${detail ? `: ${detail}` : ''}`);
    logger.error('宿主数据包导出失败', err);
    throw err;
  }

  const blob = await response.blob();
  logger.success(`成功从宿主拉取数据包，大小: ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
  return blob;
}

/**
 * 直接调用恢复 API 将目标包恢复/写入到当前酒馆宿主
 * 支持增量合并 (mode: 'merge') 与全量覆盖 (mode: 'overwrite')
 * @param {Blob} zipBlob
 * @param {object} [options]
 * @param {'merge'|'overwrite'} [options.mode='merge'] 恢复模式
 * @param {string} [options.platform='st'] 宿主类型
 */
export async function restoreToHost(zipBlob, { mode = 'merge', platform = 'st' } = {}) {
  logger.info(`准备向宿主 [${platform.toUpperCase()}] 恢复写入数据包 (模式: ${mode === 'merge' ? '增量合并' : '全量覆盖'})...`);
  const [token, handle] = await Promise.all([getCsrfToken(), getHandle()]);

  const formData = new FormData();
  formData.append('avatar', zipBlob, 'backup.zip');
  formData.append('handle', handle);
  formData.append('mode', mode);
  formData.append('incremental', mode === 'merge' ? 'true' : 'false');

  const response = await fetch('/api/users/restore', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'X-CSRF-Token': token,
    },
    body: formData,
  });

  if (!response.ok) {
    let detail = '';
    try {
      const errJson = await response.json();
      detail = errJson.error ?? '';
    } catch {
      // 忽略非 JSON
    }
    const err = new Error(`恢复失败 (${response.status})${detail ? `: ${detail}` : ''}`);
    logger.error('恢复数据包至宿主酒馆失败', err);
    throw err;
  }

  const result = await response.json().catch(() => ({ success: true }));
  logger.success(`数据包恢复至当前用户 (${handle}) 成功！模式: ${mode === 'merge' ? '增量合并' : '全量覆盖'}`);
  return result;
}

/**
 * 兼容旧版命名
 */
export async function restoreToLuker(zipBlob, options = {}) {
  return restoreToHost(zipBlob, { ...options, platform: 'luker' });
}

/**
 * 对两个 Zip 数据包执行增量合并 (Incremental Archive Merge)
 * 尤其适合 TauriTavern / SillyTavern 数据包的差量累加与历史补丁融合
 * @param {Blob|File|string} baseArchive 基准包 (原有包)
 * @param {Blob|File|string} incomingArchive 增量包 (新数据包)
 * @param {object} [options]
 * @param {(current: number, total: number, filename: string) => void} [options.onProgress]
 * @returns {Promise<{ resultBlob: Blob, updatedCount: number, preservedCount: number, totalCount: number }>}
 */
export async function incrementalMergeArchives(baseArchive, incomingArchive, { onProgress } = {}) {
  logger.info('启动数据包增量合并 (Incremental Archive Merge)...');

  const incomingReader = await zipIo.openReader(incomingArchive);
  const baseReader = await zipIo.openReader(baseArchive);

  // 1. 扫描增量包中所有的文件清单
  const incomingMap = new Map();
  for await (const entry of incomingReader.entries()) {
    incomingMap.set(entry.fileName, entry);
  }

  const writerTarget = new zip.BlobWriter('application/zip');
  const writer = await zipIo.createWriter(writerTarget, { level: 5 });

  let updatedCount = 0;
  let preservedCount = 0;
  const processedIncoming = new Set();

  // 2. 遍历基准包中的每个文件
  for await (const baseEntry of baseReader.entries()) {
    const filename = baseEntry.fileName;
    if (incomingMap.has(filename)) {
      // 冲突项：采用增量包更新版本
      const incEntry = incomingMap.get(filename);
      const incData = await incEntry.read();
      await writer.add(filename, incData);
      processedIncoming.add(filename);
      updatedCount++;
      if (onProgress) onProgress(updatedCount, incomingMap.size, filename);
    } else {
      // 基准包独有项：完整保留
      const baseData = await baseEntry.read();
      await writer.add(filename, baseData);
      preservedCount++;
    }
  }

  // 3. 将增量包中独有的新增文件全部写入
  for (const [filename, incEntry] of incomingMap.entries()) {
    if (!processedIncoming.has(filename)) {
      const incData = await incEntry.read();
      await writer.add(filename, incData);
      updatedCount++;
      if (onProgress) onProgress(updatedCount, incomingMap.size, filename);
    }
  }

  await baseReader.close();
  await incomingReader.close();
  await writer.close();

  const resultBlob = await writerTarget.getData();
  const totalCount = updatedCount + preservedCount;
  logger.success(`数据包增量合并完成: 共计 ${totalCount} 个文件 (保留原有 ${preservedCount} 项，新增/更新 ${updatedCount} 项)`);

  return {
    resultBlob,
    updatedCount,
    preservedCount,
    totalCount,
  };
}

/**
 * 宿主扩展菜单按钮注入 (SillyTavern / Luker)
 * @param {() => void} onOpenModal 呼出模态工作台回调
 */
export function registerMenuButton(onOpenModal) {
  if (typeof document === 'undefined') return;
  const menuList = document.querySelector('#extensionsMenu .list-group');
  if (!menuList) return;

  const existing = document.getElementById('st-zip-converter-menu-item');
  if (existing) existing.remove();

  const item = document.createElement('a');
  item.id = 'st-zip-converter-menu-item';
  item.className = 'list-group-item flexify-horizontal';
  item.style.cursor = 'pointer';
  item.innerHTML = '<h4>📦 酒馆数据包互转器</h4>';

  item.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onOpenModal();
  });

  menuList.appendChild(item);
}
