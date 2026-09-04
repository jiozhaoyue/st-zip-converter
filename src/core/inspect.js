import { zipIo } from './zip-io.js';
import { detectFromReader, LAYOUTS } from './detect.js';

export const CATEGORIES = Object.freeze({
  CHARACTERS: 'characters',
  CHATS: 'chats',
  LOREBOOKS: 'lorebooks',
  PRESETS: 'presets',
  SETTINGS: 'settings',
  SECRETS: 'secrets',
  ASSETS: 'assets',
  EXTENSIONS: 'extensions',
  GLOBAL_EXTENSIONS: 'globalExtensions',
  VECTORS: 'vectors',

  // 向后兼容别名
  WORLDS: 'lorebooks',
  AVATARS: 'assets',
});

export const CATEGORY_LABELS = Object.freeze({
  [CATEGORIES.CHARACTERS]: '角色卡 (Characters)',
  [CATEGORIES.CHATS]: '聊天记录 (Chats)',
  [CATEGORIES.LOREBOOKS]: '世界书 (World Info)',
  [CATEGORIES.PRESETS]: '预设配置 (Presets & Prompts)',
  [CATEGORIES.SETTINGS]: '系统设置 (Settings)',
  [CATEGORIES.SECRETS]: 'API 密钥 (Secrets)',
  [CATEGORIES.ASSETS]: '素材与头像 (Assets & Avatars)',
  [CATEGORIES.EXTENSIONS]: '用户扩展 (User Extensions)',
  [CATEGORIES.GLOBAL_EXTENSIONS]: '第三方扩展 (3rd-party Extensions)',
  [CATEGORIES.VECTORS]: '向量数据库 (Vectors)',
});

const TT_USER_PREFIX = 'data/default-user/';
const TT_THIRD_PARTY_PREFIX = 'data/extensions/third-party/';
const TT_SOURCES_PREFIX = 'data/_tauritavern/extension-sources/';

/**
 * 判断指定 hub 路径所属的业务类目 (对齐 ST / Luker 10 大标准备份项)
 * @param {string} hubPath
 * @returns {string|null}
 */
export function categoryOfHubPath(hubPath) {
  if (hubPath === 'secrets.json') return CATEGORIES.SECRETS;
  if (
    hubPath === 'settings.json'
    || hubPath === 'tauritavern-settings.json'
    || hubPath.startsWith('backups/')
    || hubPath === 'backups'
  ) {
    return CATEGORIES.SETTINGS;
  }
  if (hubPath.startsWith('characters/') || hubPath === 'characters') return CATEGORIES.CHARACTERS;
  if (
    hubPath.startsWith('chats/')
    || hubPath === 'chats'
    || hubPath.startsWith('groups/')
    || hubPath === 'groups'
    || hubPath.startsWith('group chats/')
    || hubPath === 'group chats'
  ) {
    return CATEGORIES.CHATS;
  }
  if (hubPath.startsWith('worlds/') || hubPath === 'worlds') return CATEGORIES.LOREBOOKS;
  if (
    hubPath.startsWith('OpenAI Settings/')
    || hubPath.startsWith('NovelAI Settings/')
    || hubPath.startsWith('presets/')
    || hubPath.startsWith('instruct/')
    || hubPath.startsWith('context/')
    || hubPath.startsWith('sysprompt/')
    || hubPath.startsWith('reasoning/')
    || hubPath.startsWith('themes/')
    || hubPath.startsWith('movingUI/')
    || hubPath.startsWith('QuickReplies/')
    || hubPath.startsWith('textgen_presets/')
  ) {
    return CATEGORIES.PRESETS;
  }
  if (
    hubPath.startsWith('User Avatars/')
    || hubPath === 'User Avatars'
    || hubPath.startsWith('backgrounds/')
    || hubPath === 'backgrounds'
    || hubPath.startsWith('assets/')
    || hubPath === 'assets'
    || hubPath.startsWith('user/')
    || hubPath === 'user'
  ) {
    return CATEGORIES.ASSETS;
  }
  if (
    hubPath.startsWith('extensions/third-party/')
    || hubPath.startsWith('_tauritavern/extension-sources/')
    || hubPath.startsWith('public/scripts/extensions/third-party/')
  ) {
    return CATEGORIES.GLOBAL_EXTENSIONS;
  }
  if (hubPath.startsWith('extensions/') || hubPath === 'extensions') {
    return CATEGORIES.EXTENSIONS;
  }
  if (hubPath.startsWith('vectors/') || hubPath === 'vectors') {
    return CATEGORIES.VECTORS;
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
      return CATEGORIES.GLOBAL_EXTENSIONS;
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
  const orderedKeys = [
    CATEGORIES.CHARACTERS,
    CATEGORIES.CHATS,
    CATEGORIES.LOREBOOKS,
    CATEGORIES.PRESETS,
    CATEGORIES.SETTINGS,
    CATEGORIES.SECRETS,
    CATEGORIES.ASSETS,
    CATEGORIES.EXTENSIONS,
    CATEGORIES.GLOBAL_EXTENSIONS,
    CATEGORIES.VECTORS,
  ];
  for (const cat of orderedKeys) {
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
