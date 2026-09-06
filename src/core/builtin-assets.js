/**
 * 酒馆原生固定资产指纹库 (Tavern Built-in Assets Fingerprint Registry)
 * 用于识别并智能剔除 SillyTavern 与 Luker 系统自带的默认背景图、默认主题与预置静态资源，
 * 杜绝在增量导出或全量备份中携带几十兆重复系统数据。
 */

/**
 * 官方预置的默认背景图片列表 (不区分大小写，规范化路径)
 */
export const BUILTIN_BACKGROUND_FILES = new Set([
  'default.png',
  'default.jpg',
  'default.webp',
  'tavern.png',
  'tavern.jpg',
  'tavern.webp',
  'space.jpg',
  'space.png',
  'mountains.jpg',
  'mountains.png',
  'city.png',
  'city.jpg',
  'alley.png',
  'alley.jpg',
  'forest.png',
  'forest.jpg',
  'house.png',
  'house.jpg',
  'room.png',
  'room.jpg',
  'cafe.png',
  'cafe.jpg',
  'library.png',
  'library.jpg',
  'office.png',
  'office.jpg',
  'classroom.png',
  'classroom.jpg',
  'cyberpunk.png',
  'cyberpunk.jpg',
  'fantasy.png',
  'fantasy.jpg',
  'nature.png',
  'nature.jpg',
]);

/**
 * 官方预置的默认主题与样式文件
 */
export const BUILTIN_THEME_FILES = new Set([
  'default.css',
  'dark.css',
  'light.css',
  'classic.css',
  'default.json',
]);

/**
 * 官方预置的默认用户头像与通用素材
 */
export const BUILTIN_AVATAR_FILES = new Set([
  'default.png',
  'user.png',
  'avatar.png',
]);

/**
 * 判断指定 hub 路径或文件名是否为酒馆原生自带的固定资产
 * @param {string} hubPath 规范化相对路径，例如 "backgrounds/tavern.png" 或 "themes/default.css"
 * @returns {boolean}
 */
export function isTavernBuiltinAsset(hubPath) {
  if (!hubPath || typeof hubPath !== 'string') return false;

  const normalized = hubPath.replace(/\\/g, '/').toLowerCase();
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return false;

  const fileName = segments[segments.length - 1];

  // 1. 背景图检查
  if (normalized.startsWith('backgrounds/') || segments.includes('backgrounds')) {
    if (BUILTIN_BACKGROUND_FILES.has(fileName)) {
      return true;
    }
  }

  // 2. 主题与样式检查
  if (normalized.startsWith('themes/') || normalized.startsWith('movingui/') || segments.includes('themes')) {
    if (BUILTIN_THEME_FILES.has(fileName)) {
      return true;
    }
  }

  // 3. 默认头像检查
  if (normalized.startsWith('user avatars/') || normalized.startsWith('user/')) {
    if (BUILTIN_AVATAR_FILES.has(fileName)) {
      return true;
    }
  }

  return false;
}
