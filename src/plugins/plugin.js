/**
 * ST/L 平台内导出插件(共享逻辑,esbuild 打包为 IIFE)。
 *
 * - L:POST /api/users/backup 带 selection(含 secrets)→ 拉到的 zip 就是合法 L 包
 * - ST:同端点无 selection 且平台默认排除 secrets → 产物缺 secrets,转换后提示
 * - 转换走与 CLI 完全相同的 transform 核心 + zipjs-io(同构性由 test/zipjs-io.test.js 保证)
 * - 打包时通过 define 注入 __TAVERN_CONVERT_PLATFORM__('st' | 'luker')
 */

import * as zip from '@zip.js/zip.js';
import { convert, TARGETS } from '../core/transform.js';
import { zipjsIo } from '../io/zipjs-io.js';

const PLATFORM = typeof __TAVERN_CONVERT_PLATFORM__ !== 'undefined' ? __TAVERN_CONVERT_PLATFORM__ : 'luker';
const PLATFORM_LABEL = PLATFORM === 'st' ? 'SillyTavern' : 'Luker';

const FULL_SELECTION = Object.freeze({
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

const TARGET_LABELS = Object.freeze({
  st: 'ST 数据包',
  l: 'Luker 数据包',
  tt: 'TauriTavern 数据包',
  pt: 'PureTavern 数据包',
});

async function getCsrfToken() {
  const response = await fetch('/csrf-token', { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`获取 CSRF token 失败: ${response.status}`);
  const data = await response.json();
  return data.token;
}

async function getHandle() {
  const response = await fetch('/api/users/me', { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`获取当前用户失败: ${response.status}`);
  const data = await response.json();
  return data.handle;
}

/** 拉取当前平台的整包备份 zip(即平台自身的导出格式)。 */
export async function fetchBackupBlob() {
  const [token, handle] = await Promise.all([getCsrfToken(), getHandle()]);
  const body = PLATFORM === 'luker'
    ? { handle, selection: { ...FULL_SELECTION } }
    : { handle };
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
    try { detail = (await response.json()).error ?? ''; } catch { /* 忽略非 JSON 响应 */ }
    throw new Error(`备份请求失败(${response.status})${detail ? `: ${detail}` : ''}`);
  }
  return response.blob();
}

/**
 * 把平台备份 blob 转成目标平台包。
 * @returns {Promise<{ blob: Blob, warnings: string[] }>}
 */
export async function convertBackup(sourceBlob, target) {
  if (!Object.values(TARGETS).includes(target)) {
    throw new Error(`未知目标平台: ${target}`);
  }
  const blobWriter = new zip.BlobWriter('application/zip');
  const report = await convert(sourceBlob, blobWriter, { target, io: zipjsIo });
  const json = report.toJSON();
  return { blob: await blobWriter.getData(), warnings: json.warnings };
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function exportAs(target) {
  const label = TARGET_LABELS[target] ?? target;
  try {
    setStatus(`正在导出为${label}…`);
    const sourceBlob = await fetchBackupBlob();
    const { blob, warnings } = await convertBackup(sourceBlob, target);
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    download(blob, `${PLATFORM}-to-${target}-${timestamp}.zip`);
    const lines = [`已导出为${label}。`];
    if (PLATFORM === 'st') {
      lines.push('注意:SillyTavern 的备份端点不包含 secrets.json(API 密钥),请用 tavern-convert CLI 处理含密钥的完整包。');
    }
    if (warnings.length > 0) {
      lines.push('转换警告:');
      lines.push(...warnings.slice(0, 10).map((w) => `· ${w}`));
      if (warnings.length > 10) lines.push(`· …共 ${warnings.length} 条`);
    }
    setStatus(lines.join('\n'));
  } catch (error) {
    setStatus(`导出失败: ${error?.message ?? error}`);
  }
}

function setStatus(text) {
  const node = document.getElementById('tavern-convert-status');
  if (node) node.textContent = text;
}

/** 向 ST 的扩展菜单(#extensionsMenu)注入入口;找不到菜单时降级为悬浮按钮。 */
function mountUi() {
  const targets = Object.keys(TARGET_LABELS);
  const menu = document.querySelector('#extensionsMenu .list-group');
  const container = document.createElement(menu ? 'a' : 'div');
  if (menu) {
    container.className = 'list-group-item flexify-horizontal';
    container.innerHTML = '<h4>跨平台导出</h4>';
  } else {
    container.id = 'tavern-convert-fab';
    container.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99999;background:#333;color:#fff;padding:8px;border-radius:8px;';
    container.textContent = '跨平台导出';
  }

  const panel = document.createElement('div');
  panel.id = 'tavern-convert-status';
  panel.style.cssText = 'white-space:pre-wrap;font-size:0.9em;margin-top:4px;';
  for (const target of targets) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `→ ${TARGET_LABELS[target]}`;
    button.style.cssText = 'display:block;width:100%;margin:2px 0;';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      exportAs(target);
    });
    panel.appendChild(button);
  }
  container.appendChild(panel);
  if (menu) menu.appendChild(container);
  else document.body.appendChild(container);
}

// 供外部测试/控制台使用的 API 句柄
globalThis.__tavernConvert = { convertBackup, fetchBackupBlob, PLATFORM };

// 浏览器环境才挂 UI;Node 冒烟测试与构建检查不触发 DOM 逻辑
if (typeof document !== 'undefined') {
  const bootstrap = () => mountUi();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
}
