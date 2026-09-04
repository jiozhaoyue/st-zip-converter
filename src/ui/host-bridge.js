/**
 * 宿主环境桥接模块 (SillyTavern & Luker)
 * 负责环境嗅探、CSRF Token 获取、备份数据拉取与菜单注入。
 */

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
  const isLuker = typeof window.luker !== 'undefined' || Boolean(document.querySelector('#luker-app'));
  const isST = typeof window.SillyTavern !== 'undefined' || Boolean(document.querySelector('#extensionsMenu'));

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
 * 从当前酒馆端点拉取全量备份 Zip Blob
 * @param {'st'|'luker'} platform
 * @returns {Promise<Blob>}
 */
export async function fetchHostBackup(platform) {
  const [token, handle] = await Promise.all([getCsrfToken(), getHandle()]);
  const body = platform === 'luker'
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
    try {
      const errJson = await response.json();
      detail = errJson.error ?? '';
    } catch {
      // 忽略非 JSON 响应
    }
    throw new Error(`备份请求失败 (${response.status})${detail ? `: ${detail}` : ''}`);
  }

  return response.blob();
}

/**
 * (Luker 专享) 直接调用恢复 API 将目标包恢复到当前用户
 * @param {Blob} zipBlob
 */
export async function restoreToLuker(zipBlob) {
  const [token, handle] = await Promise.all([getCsrfToken(), getHandle()]);
  const formData = new FormData();
  formData.append('avatar', zipBlob, 'backup.zip');
  formData.append('handle', handle);

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
    throw new Error(`恢复失败 (${response.status})${detail ? `: ${detail}` : ''}`);
  }

  return response.json().catch(() => ({ success: true }));
}

/**
 * 宿主扩展菜单按钮注入 (SillyTavern / Luker)
 * @param {() => void} onOpenModal 呼出模态弹窗回调
 */
export function registerMenuButton(onOpenModal) {
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
