import { zipIo } from './zip-io.js';
import { detectFromReader, LAYOUTS } from './detect.js';

export const CATEGORIES = Object.freeze({
  CHARACTERS: 'characters',
  CHATS: 'chats',
  WORLDS: 'worlds',
  SETTINGS: 'settings',
  SECRETS: 'secrets',
  AVATARS: 'avatars',
  EXTENSIONS: 'extensions',
});

export const CATEGORY_LABELS = Object.freeze({
  [CATEGORIES.CHARACTERS]: '角色卡',
  [CATEGORIES.CHATS]: '聊天记录',
  [CATEGORIES.WORLDS]: '世界书',
  [CATEGORIES.SETTINGS]: '配置预设',
  [CATEGORIES.SECRETS]: 'API 密钥',
  [CATEGORIES.AVATARS]: '用户头像',
  [CATEGORIES.EXTENSIONS]: '第三方扩展',
});

const TT_USER_PREFIX = 'data/default-user/';
const TT_THIRD_PARTY_PREFIX = 'data/extensions/third-party/';
const TT_SOURCES_PREFIX = 'data/_tauritavern/extension-sources/';

/**
 * 判断指定 hub 路径所属的业务类目
 * @param {string} hubPath
 * @returns {string|null}
 */
export function categoryOfHubPath(hubPath) {
  if (hubPath === 'secrets.json') return CATEGORIES.SECRETS;
  if (
    hubPath === 'settings.json'
    || hubPath.startsWith('OpenAI Settings/')
    || hubPath.startsWith('presets/')
    || hubPath === 'tauritavern-settings.json'
  ) {
    return CATEGORIES.SETTINGS;
  }
  if (hubPath.startsWith('characters/') || hubPath === 'characters') return CATEGORIES.CHARACTERS;
  if (hubPath.startsWith('chats/') || hubPath === 'chats') return CATEGORIES.CHATS;
  if (hubPath.startsWith('worlds/') || hubPath === 'worlds') return CATEGORIES.WORLDS;
  if (hubPath.startsWith('User Avatars/') || hubPath === 'User Avatars') return CATEGORIES.AVATARS;
  if (
    hubPath.startsWith('extensions/third-party/')
    || hubPath.startsWith('extensions/')
    || hubPath.startsWith('_tauritavern/extension-sources/')
  ) {
    return CATEGORIES.EXTENSIONS;
  }
  return null;
}

/**
 * 从原始 zip 条目名与所属布局识别类目
 * @param {string} entryName
 * @param {string} layout
 * @returns {string|null}
 */
export function categoryOfEntry(entryName, layout) {
  if (layout === LAYOUTS.TT) {
    if (entryName.startsWith(TT_USER_PREFIX)) {
      return categoryOfHubPath(entryName.slice(TT_USER_PREFIX.length));
    }
    if (entryName.startsWith(TT_THIRD_PARTY_PREFIX) || entryName.startsWith(TT_SOURCES_PREFIX)) {
      return CATEGORIES.EXTENSIONS;
    }
    return null;
  }
  return categoryOfHubPath(entryName);
}

/**
 * 零拷贝预检 Zip 包中央目录并按业务资产分类统计
 * @param {Blob|File|string} source
 * @param {object} [options]
 * @param {object} [options.io]
 * @returns {Promise<{
 *   layout: string,
 *   evidence: string,
 *   totalFiles: number,
 *   totalBytes: number,
 *   categories: Record<string, { count: number, sizeBytes: number, label: string }>
 * }>}
 */
export async function inspectArchive(source, { io = zipIo } = {}) {
  const reader = await io.openReader(source);
  let detection;
  try {
    detection = await detectFromReader(reader);
  } finally {
    await reader.close();
  }

  // 重新打开遍历条目统计（开销极低，仅读中央目录）
  const scanner = await io.openReader(source);
  const categories = {};
  for (const cat of Object.values(CATEGORIES)) {
    categories[cat] = {
      count: 0,
      sizeBytes: 0,
      label: CATEGORY_LABELS[cat] || cat,
    };
  }

  let totalFiles = 0;
  let totalBytes = 0;

  try {
    for await (const entry of scanner.entries()) {
      if (entry.isDirectory) {
        entry.skip();
        continue;
      }
      totalFiles += 1;
      const size = entry.uncompressedSize || 0;
      totalBytes += size;

      const cat = categoryOfEntry(entry.fileName, detection.layout);
      if (cat && categories[cat]) {
        categories[cat].count += 1;
        categories[cat].sizeBytes += size;
      }
      entry.skip();
    }
  } finally {
    await scanner.close();
  }

  return {
    layout: detection.layout,
    evidence: detection.evidence,
    totalFiles,
    totalBytes,
    categories,
  };
}
