/**
 * 宿主环境桥接与增量流控模块 (SillyTavern & Luker)
 * 负责环境嗅探、CSRF Token 获取、细粒度备份拉取、增量恢复写入与多包增量合并。
 */

import { logger } from '../core/logger.js';
import { zipIo } from '../core/zip-io.js';
import * as zip from '../vendor/zip.js';
import { getWorkbenchHtml } from './workbench-template.js';

/**
 * 宿主平台代码 → 转换器布局代码映射。
 * convert() 只接受 st|l|tt|pt (src/core/transform.js TARGETS)，
 * 而 detectHost() 返回 st|luker|standalone —— 'luker' 必须映射为 'l'，
 * 否则宿主导出直出路径把 'luker' 传给 convert() 会抛
 * "convert: target 必须是 st|l|tt|pt 之一"。
 * @param {'st'|'luker'|'standalone'|string} platform detectHost() 平台代码
 * @returns {string} 转换器布局代码 (st|l) 或原样透传
 */
export function hostLayoutCode(platform) {
  if (platform === 'luker') return 'l';
  return platform;
}

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
 *
 * 判定协议（顺序不可颠倒，Luker 前端同时暴露两个全局对象）：
 * 1. Luker 专属信号 globalThis.lukerContext 存在 → luker
 * 2. globalThis.SillyTavern 存在 → st（Luker script.js:360 也暴露它，故必须后判）
 * 3. 都不存在 → standalone
 *
 * 注意 lukerContext 是惰性 getter（首次读取触发 getContext()），需 try/catch。
 * @returns {{ platform: 'st'|'luker'|'standalone', isPlugin: boolean, confidence: 'frontend'|'none' }}
 */
export function detectHost() {
  if (typeof window === 'undefined') {
    return { platform: 'standalone', isPlugin: false, confidence: 'none' };
  }

  let lukerContext = null;
  try {
    lukerContext = (typeof globalThis.lukerContext === 'object' && globalThis.lukerContext) || null;
  } catch {
    // lukerContext 惰性 getter 在宿主脚本未就绪时可能抛错，忽略并走后续判定
  }
  if (lukerContext) {
    return { platform: 'luker', isPlugin: true, confidence: 'frontend' };
  }

  const hasSTGlobal = typeof globalThis.SillyTavern !== 'undefined'
    || typeof window.SillyTavern !== 'undefined'
    || Boolean(document.querySelector('#extensionsMenu'));
  if (hasSTGlobal) {
    return { platform: 'st', isPlugin: true, confidence: 'frontend' };
  }

  return { platform: 'standalone', isPlugin: false, confidence: 'none' };
}

/**
 * 通过服务端 /version 端点二次校验宿主类型
 *
 * 实测响应形状（research/host-probe-results.md）：
 * - Luker: { agent: "Luker:2.7.0:...", stCompatVersion, pkgVersion, ... }
 * - ST:    { version: "1.18.0" }（老形状，无 agent 字段）
 *
 * @param {'st'|'luker'|'standalone'} frontendPlatform detectHost() 的前端判定结果
 * @returns {Promise<{ platform: 'st'|'luker'|'standalone', verified: boolean, version?: string }>}
 */
export async function verifyHostPlatform(frontendPlatform) {
  let data = null;
  try {
    const response = await fetch('/version', { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
  } catch (err) {
    logger.info(`服务端 /version 校验不可达 (${err.message})，保留前端判定: ${frontendPlatform}`);
    return { platform: frontendPlatform, verified: false };
  }

  let endpointPlatform = 'standalone';
  if (data && typeof data === 'object') {
    const agent = typeof data.agent === 'string' ? data.agent : '';
    if (agent.startsWith('Luker') || 'stCompatVersion' in data) {
      endpointPlatform = 'luker';
    } else if (agent.startsWith('SillyTavern') || ('version' in data && !('stCompatVersion' in data))) {
      endpointPlatform = 'st';
    } else if (typeof data.pkgVersion === 'string') {
      // 有 pkgVersion 但 agent 不可识别：按版本主号兜底
      endpointPlatform = data.pkgVersion.startsWith('1.') ? 'st' : 'luker';
    }
  }

  const version = data?.agent ?? data?.version ?? data?.pkgVersion ?? null;
  if (endpointPlatform !== frontendPlatform) {
    logger.warn(`宿主类型前端判定 (${frontendPlatform}) 与服务端校验 (${endpointPlatform}) 不一致，以服务端为准。版本: ${version ?? '未知'}`);
  } else {
    logger.info(`宿主类型服务端校验一致: ${endpointPlatform} (版本: ${version ?? '未知'})`);
  }
  return { platform: endpointPlatform, verified: true, version: version || undefined };
}

/**
 * 导出后软校验：按宿主类型检查数据包形状是否与预期一致
 * - Luker 导出包含 manifest.json (schemaVersion+selection)
 * - ST 导出为全量摊平包，不含 manifest.json
 * 校验失败仅告警，不阻断流程。
 * @param {Blob} blob 宿主导出的 Zip 数据包
 * @param {'st'|'luker'} platform 宿主类型
 */
export async function validateBackupShape(blob, platform) {
  try {
    const reader = await zipIo.openReader(blob);
    let hasManifest = false;
    for await (const entry of reader.entries()) {
      if (entry.fileName === 'manifest.json') {
        hasManifest = true;
        break;
      }
      // 只扫前几十个条目名即可判定，避免大包全量遍历
      if (entry.fileName.startsWith('characters/') || entry.fileName.startsWith('settings')) break;
    }
    await reader.close();

    if (platform === 'luker' && !hasManifest) {
      logger.warn('宿主类型为 Luker，但导出数据包缺少 manifest.json —— 宿主识别可能有误，请检查宿主徽标');
    } else if (platform === 'st' && hasManifest) {
      logger.warn('宿主类型为 ST，但导出数据包含 manifest.json —— 宿主识别可能有误，请检查宿主徽标');
    }
  } catch (err) {
    logger.info(`导出包形状软校验跳过: ${err.message}`);
  }
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
 * OPFS 可用性特性检测（仅浏览器；Node/Vitest 环境直接 false）
 * @returns {boolean}
 */
export function supportsOpfs() {
  try {
    return typeof navigator !== 'undefined'
      && typeof navigator.storage?.getDirectory === 'function';
  } catch {
    return false;
  }
}

/**
 * 打开 OPFS 临时目录（fetch-tmp）中的文件句柄
 * @param {string} name
 * @param {boolean} [create=true]
 * @returns {Promise<FileSystemFileHandle|null>} OPFS 不可用时返回 null
 */
export async function opfsTmpHandle(name, create = true) {
  if (!supportsOpfs()) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('fetch-tmp', { create: true });
    return await dir.getFileHandle(name, { create });
  } catch (err) {
    logger.warn(`OPFS 临时文件句柄获取失败 (${err.message})，回退内存模式`);
    return null;
  }
}

/**
 * 清理 OPFS fetch-tmp 目录下的临时文件（不存在时静默）
 * @param {string} name
 */
export async function opfsTmpCleanup(name) {
  if (!supportsOpfs()) return;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('fetch-tmp', { create: false });
    await dir.removeEntry(name);
    logger.info(`OPFS 临时包已清理: ${name}`);
  } catch {
    // 文件不存在或目录不可达：无需清理
  }
}

/**
 * OPFS 句柄 → File（供 convert/zip.js 直接消费）
 * @param {FileSystemFileHandle} handle
 * @returns {Promise<File>}
 */
export async function opfsHandleToFile(handle) {
  return handle.getFile();
}

/**
 * 从当前酒馆端点拉取细粒度或全量备份 Zip（三段式进度版）
 *
 * 阶段1 宿主生成：TTFB 前等待（宿主打包数据）
 * 阶段2 传输：response.body 流式读取，按 Content-Length 估算百分比
 * 阶段3 插件处理：由调用方 transform 阶段接管（onProgress 回调透传）
 *
 * 浏览器且有 OPFS 时直写临时文件（GB 级包零内存缓冲），返回句柄描述
 * { kind:'opfs', name, size, handle }；否则维持内存 Blob 路径。
 *
 * @param {'st'|'luker'} platform
 * @param {Record<string, boolean>} [selection] 细粒度类目选择
 * @param {object} [options]
 * @param {function(string, number, number): void} [options.onPhase] 阶段回调 (phase, received, total)
 * @param {string} [options.taskId] 任务标识（OPFS 临时文件名，默认按时间戳）
 * @param {AbortSignal} [options.signal] 中止信号（透传 fetch 与 reader 循环）
 * @returns {Promise<Blob|{kind:'opfs', name:string, size:number, handle:FileSystemFileHandle}>}
 */
export async function fetchHostBackup(platform, selection = null, { onPhase, taskId, signal } = {}) {
  logger.info(`正在连接宿主 [${platform.toUpperCase()}] 获取授权凭证...`);
  const [token, handle] = await Promise.all([getCsrfToken(), getHandle()]);

  const sel = selection ? { ...selection } : { ...FULL_SELECTION };
  const body = platform === 'luker'
    ? { handle, selection: sel }
    : { handle, selection: sel };

  logger.info(`向宿主发起数据包导出请求 (用户: ${handle})...`);
  onPhase?.('host-generating', 0, 0);

  const response = await fetch('/api/users/backup', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': token,
    },
    body: JSON.stringify(body),
    signal,
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

  // 流式读取：宿主生成耗时体现在 TTFB，传输耗时体现为 body 逐块到达
  const contentLength = Number(response.headers.get('Content-Length')) || 0;

  // OPFS 直写路径：GB 级包零内存缓冲；句柄描述返回给下游按需 getFile()
  let opfsHandle = null;
  let opfsName = '';
  if (supportsOpfs()) {
    opfsName = `${taskId || `backup_${Date.now()}`}.zip`;
    opfsHandle = await opfsTmpHandle(opfsName, true);
    if (opfsHandle) {
      logger.info(`OPFS 可用，数据包流式直写临时文件: fetch-tmp/${opfsName}`);
    }
  }

  let blob = null;
  const writable = opfsHandle ? await opfsHandle.createWritable() : null;

  try {
    if (response.body && typeof response.body.getReader === 'function') {
      onPhase?.('transferring', 0, contentLength);
      const reader = response.body.getReader();
      const chunks = writable ? null : [];
      let received = 0;
      let lastLoggedPct = -1;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (writable) {
          await writable.write(value);
        } else {
          chunks.push(value);
        }
        received += value.length;
        if (contentLength > 0) {
          const pct = Math.round((received / contentLength) * 100);
          if (pct >= lastLoggedPct + 10) {
            lastLoggedPct = pct;
            logger.info(`数据包传输中: ${pct}% (${(received / 1048576).toFixed(1)} / ${(contentLength / 1048576).toFixed(1)} MB)`);
          }
        } else if (received >= lastLoggedPct + 4194304) {
          // chunked 响应无 Content-Length：按 4MB 步进汇报
          lastLoggedPct = received - (received % 4194304);
          logger.info(`数据包传输中: 已接收 ${(received / 1048576).toFixed(1)} MB`);
        }
        onPhase?.('transferring', received, contentLength);
      }
      if (writable) {
        await writable.close();
        const file = await opfsHandle.getFile();
        blob = null;
        logger.success(`成功从宿主拉取数据包 (OPFS 直写)，大小: ${(file.size / 1024 / 1024).toFixed(2)} MB`);
        await validateBackupShape(file, platform);
        logger.success(`宿主拉取完成，数据包已落盘 OPFS 临时区`);
        return { kind: 'opfs', name: opfsName, size: file.size, handle: opfsHandle };
      }
      blob = new Blob(chunks, { type: 'application/zip' });
    } else {
      blob = await response.blob();
      if (writable) {
        // 罕见：response.body 不可流式但 OPFS 可用——落盘后统一走句柄路径
        await writable.write(blob);
        await writable.close();
        const file = await opfsHandle.getFile();
        await validateBackupShape(file, platform);
        return { kind: 'opfs', name: opfsName, size: file.size, handle: opfsHandle };
      }
    }
  } catch (err) {
    // 半成品清理：���存路径无状态；OPFS 路径删临时文件
    if (writable) {
      try { await writable.abort(err); } catch { /* 已关闭/中止 */ }
    }
    if (opfsHandle) await opfsTmpCleanup(opfsName);
    throw err;
  }

  logger.success(`成功从宿主拉取数据包，大小: ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
  await validateBackupShape(blob, platform);
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

  // 检查是否包含轻量清单 _convert/extensions-manifest.json，若包含则自动触发扩展安装器
  try {
    const reader = await zipIo.openReader(zipBlob);
    try {
      for await (const entry of reader.entries()) {
        if (entry.fileName === '_convert/extensions-manifest.json') {
          const text = new TextDecoder().decode(await entry.read());
          const manifest = JSON.parse(text);
          if (Array.isArray(manifest.extensions) && manifest.extensions.length > 0) {
            logger.info(`检测到包内包含 ${manifest.extensions.length} 个扩展清单，正在呼出扩展安装面板...`);
            renderExtensionInstallerModal(manifest.extensions);
          }
          break;
        }
      }
    } finally {
      await reader.close();
    }
  } catch (err) {
    logger.warn('检查扩展清单失败 (非阻塞):', err);
  }

  return result;
}

/**
 * 获取目标酒馆宿主当前已安装的扩展列表
 * @returns {Promise<string[]>} 已安装扩展的文件夹名列表
 */
export async function discoverHostExtensions() {
  try {
    const response = await fetch('/api/extensions/discover', { credentials: 'same-origin' });
    if (!response.ok) return [];
    const list = await response.json();
    if (!Array.isArray(list)) return [];
    return list.map((item) => {
      const raw = item?.name || '';
      return raw.startsWith('third-party/') ? raw.slice('third-party/'.length) : raw;
    }).filter(Boolean);
  } catch (err) {
    logger.warn('获取宿主扩展列表失败 (可能在独立环境运行):', err);
    return [];
  }
}

/**
 * 调用宿主 /api/extensions/install 安装单个扩展 (原生自带 depth: 1 浅克隆)
 * @param {object} params
 * @param {string} params.url 扩展 Git 仓库 URL
 * @param {string} [params.branch] 对应分支
 * @param {boolean} [params.replace=false] 是否强制覆盖已有目录
 * @returns {Promise<any>}
 */
export async function installExtensionViaHost({ url, branch, replace = false }) {
  const token = await getCsrfToken();
  const body = { url, branch, replace };
  const response = await fetch('/api/extensions/install', {
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
      detail = await response.text();
    } catch { /* 忽略 */ }
    throw new Error(`安装失败 (${response.status})${detail ? `: ${detail}` : ''}`);
  }

  return await response.json().catch(() => ({ success: true }));
}

/**
 * 针对目标平台自适应检查宿主是否存在错误的 third-party 嵌套目录
 * 规则：
 * - 若目标/宿主为 PT 或 TT：原生支持 third-party，绝不报错或提示异常
 * - 若目标/宿主为 ST 或 Luker：检查是否存在 local 级 'third-party/third-party' 文件夹
 * @param {string} [targetPlatform='l'] 目标平台类型 ('st' | 'l' | 'tt' | 'pt')
 * @returns {Promise<{ hasAnomaly: boolean, message?: string }>}
 */
export async function checkHostThirdPartyAnomaly(targetPlatform = 'l') {
  if (targetPlatform === 'tt' || targetPlatform === 'pt') {
    return { hasAnomaly: false };
  }
  try {
    const response = await fetch('/api/extensions/discover', { credentials: 'same-origin' });
    if (!response.ok) return { hasAnomaly: false };
    const list = await response.json();
    if (!Array.isArray(list)) return { hasAnomaly: false };
    const foundRogue = list.some(
      (item) => item?.type === 'local' && (item?.name === 'third-party/third-party' || item?.name === 'third-party/'),
    );
    if (foundRogue) {
      return {
        hasAnomaly: true,
        extensionName: 'third-party',
        message: '检测到宿主本地用户目录下存在错误的 third-party 嵌套文件夹 (data/<user>/extensions/third-party/)，会导致其下插件无法被酒馆正常识别。',
      };
    }
  } catch {
    // 独立环境忽略
  }
  return { hasAnomaly: false };
}

/**
 * 调用宿主接口删除指定扩展 (可用于清理错误残留的 third-party 目录)
 * @param {string} extensionName 扩展或目录名
 * @param {boolean} [isGlobal=false] 是否为全局扩展
 * @returns {Promise<boolean>}
 */
export async function deleteExtensionViaHost(extensionName, isGlobal = false) {
  const token = await getCsrfToken();
  const response = await fetch('/api/extensions/delete', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': token,
    },
    body: JSON.stringify({ extensionName, global: isGlobal }),
  });
  return response.ok;
}

/**
 * 弹出扩展清单安装器现代化面板
 * @param {Array<any>} extensions 清单中记录的扩展数组
 * @param {() => void} [onFinish] 全部安装完毕或用户关闭后的回调
 * @param {object} [options={}] 扩展选项 (如 targetPlatform)
 */
export async function renderExtensionInstallerModal(extensions, onFinish, options = {}) {
  if (typeof document === 'undefined') return;

  const existing = document.getElementById('ext-installer-modal');
  if (existing) existing.remove();

  // 1. 获取本地已安装扩展与宿主异常检查
  const targetPlatform = options.targetPlatform || 'l';
  const [installedList, anomaly] = await Promise.all([
    discoverHostExtensions(),
    checkHostThirdPartyAnomaly(targetPlatform),
  ]);
  const installedNames = new Set(installedList);

  // 2. 构造模态弹窗容器
  const modalOverlay = document.createElement('div');
  modalOverlay.id = 'ext-installer-modal';
  modalOverlay.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0, 0, 0, 0.75); backdrop-filter: blur(8px);
    z-index: 99999; display: flex; align-items: center; justify-content: center;
    padding: 20px; font-family: system-ui, -apple-system, sans-serif;
  `;

  const modalBox = document.createElement('div');
  modalBox.style.cssText = `
    background: #1e1e2e; color: #cdd6f4; border: 1px solid rgba(255,255,255,0.15);
    border-radius: 12px; width: 100%; max-width: 680px; max-height: 85vh;
    display: flex; flex-direction: column; box-shadow: 0 20px 40px rgba(0,0,0,0.6);
    overflow: hidden;
  `;

  modalBox.innerHTML = `
    <div style="padding: 16px 20px; border-bottom: 1px solid rgba(255,255,255,0.1); display: flex; justify-content: space-between; align-items: center;">
      <div>
        <h3 style="margin: 0; font-size: 1.15rem; color: #89b4fa; display: flex; align-items: center; gap: 8px;">
          <i class="fa-solid fa-puzzle-piece"></i> 扩展安装器 (轻量清单模式)
        </h3>
        <p style="margin: 4px 0 0 0; font-size: 0.85rem; color: #a6adc8;">
          数据包已恢复。以下是包内记录的扩展，酒馆将以 <strong>depth: 1</strong> 浅克隆自动拉取，杜绝 408 并保留一键更新能力。
        </p>
      </div>
      <button id="ext-modal-close" style="background: transparent; border: none; color: #a6adc8; font-size: 1.5rem; cursor: pointer; padding: 4px 8px;">&times;</button>
    </div>

    <div style="padding: 10px 20px; background: rgba(0,0,0,0.2); border-bottom: 1px solid rgba(255,255,255,0.05); display: flex; gap: 12px; align-items: center; font-size: 0.85rem;">
      <button id="ext-select-missing" class="menu_button" style="padding: 4px 10px; font-size: 0.8rem; cursor: pointer;">仅选未安装</button>
      <button id="ext-select-all" class="menu_button" style="padding: 4px 10px; font-size: 0.8rem; cursor: pointer;">全选</button>
      <button id="ext-deselect-all" class="menu_button" style="padding: 4px 10px; font-size: 0.8rem; cursor: pointer;">全不选</button>
      <div style="flex: 1;"></div>
      <label class="checkbox_label flex-container" style="cursor: pointer; color: #f38ba8;">
        <input type="checkbox" id="ext-force-replace" />
        <span>强制覆盖已有扩展</span>
      </label>
    </div>

    ${anomaly.hasAnomaly ? `
    <div id="ext-anomaly-banner" style="margin: 12px 20px 0 20px; padding: 10px 14px; background: rgba(243, 139, 168, 0.15); border: 1px solid #f38ba8; border-radius: 6px; font-size: 0.82rem; color: #f38ba8; display: flex; align-items: center; justify-content: space-between; gap: 10px;">
      <div>
        <strong><i class="fa-solid fa-triangle-exclamation"></i> 检测到错误目录残留：</strong> 本地存在旧版/错误的 <code>data/&lt;user&gt;/extensions/third-party/</code> 文件夹，会导致插件识别失效。
      </div>
      <button id="ext-btn-clean-anomaly" class="menu_button" style="padding: 4px 10px; font-size: 0.78rem; background: #f38ba8; color: #11111b; font-weight: bold; border: none; border-radius: 4px; cursor: pointer; white-space: nowrap;">一键清理残留 third-party</button>
    </div>` : ''}

    <div id="ext-list-container" style="padding: 12px 20px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 8px;">
    </div>

    <div id="ext-progress-bar-container" style="display: none; padding: 12px 20px; background: rgba(0,0,0,0.3); border-top: 1px solid rgba(255,255,255,0.05);">
      <div style="display: flex; justify-content: space-between; font-size: 0.85rem; margin-bottom: 6px;">
        <span id="ext-progress-status" style="color: #89b4fa;">准备安装...</span>
        <span id="ext-progress-num" style="color: #a6adc8;">0 / 0</span>
      </div>
      <div style="width: 100%; height: 8px; background: #313244; border-radius: 4px; overflow: hidden;">
        <div id="ext-progress-fill" style="width: 0%; height: 100%; background: #a6e3a1; transition: width 0.3s ease;"></div>
      </div>
    </div>

    <div style="padding: 14px 20px; border-top: 1px solid rgba(255,255,255,0.1); display: flex; justify-content: flex-end; gap: 10px; align-items: center;">
      <button id="ext-btn-cancel" class="menu_button" style="padding: 8px 16px; cursor: pointer;">暂不安装</button>
      <button id="ext-btn-start" class="menu_button menu_button_icon" style="padding: 8px 20px; background: #89b4fa; border: none; color: #11111b; font-weight: bold; cursor: pointer;">
        <i class="fa-solid fa-play"></i> <span>开始安装勾选项</span>
      </button>
      <button id="ext-btn-reload" class="menu_button menu_button_icon" style="display: none; padding: 8px 20px; background: #a6e3a1; border: none; color: #11111b; font-weight: bold; cursor: pointer;">
        <i class="fa-solid fa-rotate"></i> <span>刷新酒馆生效</span>
      </button>
    </div>
  `;

  modalOverlay.appendChild(modalBox);
  document.body.appendChild(modalOverlay);

  const listEl = modalBox.querySelector('#ext-list-container');
  const itemsState = [];

  extensions.forEach((ext, idx) => {
    const folder = ext.id || ext.name;
    const isInstalled = installedNames.has(folder);
    const itemEl = document.createElement('div');
    itemEl.style.cssText = `
      display: flex; align-items: center; gap: 12px; padding: 8px 12px;
      background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05);
      border-radius: 6px; font-size: 0.88rem;
    `;

    itemEl.innerHTML = `
      <input type="checkbox" id="ext-chk-${idx}" ${!isInstalled ? 'checked' : ''} style="cursor: pointer;" />
      <div style="flex: 1; min-width: 0;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <strong style="color: #cdd6f4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${ext.displayName || ext.name || folder}</strong>
          <span style="font-size: 0.75rem; color: #6c7086;">(${folder})</span>
          ${isInstalled
            ? '<span style="font-size: 0.72rem; padding: 1px 6px; background: #45475a; color: #a6adc8; border-radius: 4px;">本地已安装</span>'
            : '<span style="font-size: 0.72rem; padding: 1px 6px; background: rgba(137,180,250,0.2); color: #89b4fa; border-radius: 4px;">待安装</span>'
          }
        </div>
        <div style="font-size: 0.78rem; color: #7f849c; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          <span>${ext.url || '无远程 URL'}</span>
          ${ext.branch ? `<span style="margin-left: 8px; color: #f9e2af;">分支: ${ext.branch}</span>` : ''}
        </div>
      </div>
      <span id="ext-item-status-${idx}" style="font-size: 0.8rem; color: #6c7086;"></span>
    `;

    listEl.appendChild(itemEl);
    itemsState.push({
      ext,
      checkbox: itemEl.querySelector(`#ext-chk-${idx}`),
      statusEl: itemEl.querySelector(`#ext-item-status-${idx}`),
      isInstalled,
    });
  });

  // 按钮事件绑定
  const closeBtn = modalBox.querySelector('#ext-modal-close');
  const cancelBtn = modalBox.querySelector('#ext-btn-cancel');
  const startBtn = modalBox.querySelector('#ext-btn-start');
  const reloadBtn = modalBox.querySelector('#ext-btn-reload');
  const forceReplaceChk = modalBox.querySelector('#ext-force-replace');

  const closeModal = () => {
    modalOverlay.remove();
    if (onFinish) onFinish();
  };

  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);
  reloadBtn.addEventListener('click', () => window.location.reload());

  const cleanAnomalyBtn = modalBox.querySelector('#ext-btn-clean-anomaly');
  if (cleanAnomalyBtn) {
    cleanAnomalyBtn.addEventListener('click', async () => {
      cleanAnomalyBtn.disabled = true;
      cleanAnomalyBtn.textContent = '清理中...';
      const ok = await deleteExtensionViaHost('third-party', false);
      const banner = modalBox.querySelector('#ext-anomaly-banner');
      if (banner) {
        if (ok) {
          banner.style.background = 'rgba(166, 227, 161, 0.15)';
          banner.style.borderColor = '#a6e3a1';
          banner.style.color = '#a6e3a1';
          banner.innerHTML = '<i class="fa-solid fa-circle-check"></i> <strong>已成功清理残留 third-party 目录！</strong>';
        } else {
          cleanAnomalyBtn.disabled = false;
          cleanAnomalyBtn.textContent = '重试清理';
        }
      }
    });
  }

  modalBox.querySelector('#ext-select-missing').addEventListener('click', () => {
    itemsState.forEach((item) => {
      item.checkbox.checked = !item.isInstalled;
    });
  });

  modalBox.querySelector('#ext-select-all').addEventListener('click', () => {
    itemsState.forEach((item) => {
      item.checkbox.checked = true;
    });
  });

  modalBox.querySelector('#ext-deselect-all').addEventListener('click', () => {
    itemsState.forEach((item) => {
      item.checkbox.checked = false;
    });
  });

  startBtn.addEventListener('click', async () => {
    const selected = itemsState.filter((item) => item.checkbox.checked);
    if (selected.length === 0) {
      alert('请至少勾选一个待安装的扩展');
      return;
    }

    startBtn.disabled = true;
    startBtn.style.opacity = '0.5';
    cancelBtn.disabled = true;
    forceReplaceChk.disabled = true;
    itemsState.forEach((item) => { item.checkbox.disabled = true; });

    const progressContainer = modalBox.querySelector('#ext-progress-bar-container');
    const progressStatus = modalBox.querySelector('#ext-progress-status');
    const progressNum = modalBox.querySelector('#ext-progress-num');
    const progressFill = modalBox.querySelector('#ext-progress-fill');

    progressContainer.style.display = 'block';

    let successCount = 0;
    const failedItems = [];

    for (let i = 0; i < selected.length; i++) {
      const item = selected[i];
      const { ext, statusEl } = item;
      const progressText = `${i + 1} / ${selected.length}`;
      progressNum.textContent = progressText;
      progressFill.style.width = `${Math.round(((i + 1) / selected.length) * 100)}%`;
      progressStatus.textContent = `正在浅克隆: ${ext.displayName || ext.name} (${ext.url})...`;
      statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 克隆中...';
      statusEl.style.color = '#89b4fa';

      try {
        if (!ext.url || !/^https?:\/\//i.test(ext.url)) {
          throw new Error('缺少有效的 Git HTTP(S) URL');
        }
        await installExtensionViaHost({
          url: ext.url,
          branch: ext.branch || 'main',
          replace: forceReplaceChk.checked,
        });
        statusEl.innerHTML = '<i class="fa-solid fa-circle-check" style="color: #a6e3a1;"></i> 已安装';
        statusEl.style.color = '#a6e3a1';
        successCount++;
      } catch (err) {
        statusEl.innerHTML = `<i class="fa-solid fa-circle-xmark" style="color: #f38ba8;"></i> ${err.message || '安装失败'}`;
        statusEl.style.color = '#f38ba8';
        failedItems.push(item);
        logger.error(`扩展 ${ext.name} 安装失败:`, err);
      }
    }

    if (failedItems.length > 0) {
      progressStatus.textContent = `安装完成：${successCount} 成功，${failedItems.length} 失败`;
      progressStatus.style.color = '#f9e2af';
      startBtn.disabled = false;
      startBtn.style.opacity = '1';
      startBtn.textContent = `重试失败项 (${failedItems.length})`;
      cancelBtn.disabled = false;
      // 仅保留失败项勾选
      itemsState.forEach((item) => {
        item.checkbox.disabled = false;
        item.checkbox.checked = failedItems.includes(item);
      });
      reloadBtn.style.display = 'inline-block';
    } else {
      progressStatus.innerHTML = `<i class="fa-solid fa-circle-check" style="color: #a6e3a1;"></i> 全部 ${successCount} 个扩展安装成功！`;
      progressStatus.style.color = '#a6e3a1';
      startBtn.style.display = 'none';
      cancelBtn.style.display = 'none';
      reloadBtn.style.display = 'inline-block';
    }
  });
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
 * 递归为容器内的所有 .inline-drawer 绑定展开与折叠交互
 * @param {HTMLElement} root
 */
export function setupDrawerToggles(root) {
  if (!root) return;
  const drawers = root.querySelectorAll('.inline-drawer');
  drawers.forEach((drawer) => {
    const toggle = drawer.querySelector(':scope > .inline-drawer-toggle');
    const content = drawer.querySelector(':scope > .inline-drawer-content');
    const icon = toggle ? toggle.querySelector('.inline-drawer-icon') : null;
    if (toggle && content && !toggle.dataset.toggleBound) {
      toggle.dataset.toggleBound = 'true';
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const isHidden = content.style.display === 'none' || getComputedStyle(content).display === 'none';
        content.style.display = isHidden ? 'block' : 'none';
        if (icon) {
          icon.classList.toggle('down', !isHidden);
          icon.classList.toggle('up', isHidden);
        }
      });
    }
  });
}

/**
 * 宿主扩展设置抽屉注入 (#extensions_settings2 / #extensions_settings)
 * 直接在酒馆原生设置侧栏展开工作台，无需多余模态弹窗
 * @param {(appEl: HTMLElement) => void} [onInit] 抽屉初次挂载后初始化控制器的回调
 */
export function mountSettingsDrawer(onInit) {
  if (typeof document === 'undefined') return;
  const PANEL_ID = 'st-zip-converter-settings-panel';

  const mount = () => {
    if (document.getElementById(PANEL_ID)) return;
    const container = document.getElementById('extensions_settings2')
      || document.getElementById('extensions_settings');
    if (!container) return;

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'st-converter-drawer-wrapper';
    panel.innerHTML = `
      <div class="inline-drawer" id="st_zip_converter_settings" style="margin-bottom: 12px;">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b><i class="fa-solid fa-file-zipper" style="color: var(--SmartThemeQuoteColor, #f59e0b);"></i> <span data-i18n="ST Zip Converter">酒馆数据包互转工坊</span></b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content" style="display: none;">
          <div class="st-converter-drawer-app" id="app">
            ${getWorkbenchHtml({ isDrawer: true })}
          </div>
        </div>
      </div>
    `;

    container.appendChild(panel);

    // 绑定抽屉及内部子抽屉展开折叠
    setupDrawerToggles(panel);

    if (typeof onInit === 'function') {
      const appEl = panel.querySelector('#app');
      onInit(appEl);
    }
  };

  mount();
  const timer = setInterval(() => {
    if (document.getElementById(PANEL_ID)) {
      clearInterval(timer);
    } else {
      mount();
    }
  }, 1000);
}

/**
 * 宿主扩展菜单按钮注入 (保留向下兼容)
 * @param {() => void} [onOpen]
 */
export function registerMenuButton(onOpen) {
  if (typeof document === 'undefined') return;

  const addBtn = () => {
    if (document.getElementById('st-zip-converter-menu-item')) return;
    const menuList = document.querySelector('#extensionsMenu .list-group')
      || document.querySelector('#extensionsMenu')
      || document.querySelector('#options');
    if (!menuList) return;

    const item = document.createElement('div');
    item.id = 'st-zip-converter-menu-item';
    item.className = 'list-group-item flexify-horizontal interactable';
    item.style.cursor = 'pointer';
    item.innerHTML = '<i class="fa-solid fa-file-zipper extensionsMenuExtensionButton" style="margin-right: 8px; color: var(--SmartThemeQuoteColor, #f59e0b);"></i><span style="font-weight: 500;">数据包互转工坊</span>';

    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      // 展开并平滑滚动到抽屉
      const drawer = document.getElementById('st_zip_converter_settings');
      if (drawer) {
        const content = drawer.querySelector(':scope > .inline-drawer-content');
        const icon = drawer.querySelector(':scope > .inline-drawer-toggle .inline-drawer-icon');
        if (content) {
          content.style.display = 'block';
          if (icon) {
            icon.classList.remove('down');
            icon.classList.add('up');
          }
        }
        drawer.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }

      if (typeof onOpen === 'function') {
        onOpen();
      }
    });

    menuList.appendChild(item);
  };

  addBtn();
  const timer = setInterval(() => {
    if (document.getElementById('st-zip-converter-menu-item')) {
      clearInterval(timer);
    } else {
      addBtn();
    }
  }, 1000);
}
