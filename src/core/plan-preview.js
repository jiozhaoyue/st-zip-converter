/**
 * 完全扫描与转换动作预测引擎 (Plan Preview)
 * 零拷贝预读 Zip 中央目录，在真正转换前预测每一个文件的归宿与操作。
 */

import { zipIo } from './zip-io.js';
import { detectFromReader, LAYOUTS } from './detect.js';
import { CATEGORIES, CATEGORY_LABELS, categoryOfHubPath, isBackupChatOrSnapshot } from './inspect.js';
import { routeSource, targetEntryPath, TARGETS, isJunkOrDevFile, EXTENSION_MODES } from './transform.js';
import { isTavernBuiltinAsset } from './builtin-assets.js';

export const ACTIONS = Object.freeze({
  COPY: 'COPY',             // 原位或同名直通复制
  ROUTE: 'ROUTE',           // 跨平台目录路由映射
  MIGRATE: 'MIGRATE',       // 结构迁移 (如用户级扩展 -> third-party)
  SYNTHESIZE: 'SYNTHESIZE', // 目标平台元数据/清单动态合成
  DROP: 'DROP',             // 依平台规范安全丢弃 (派生缓存/不兼容配置)
  FILTER: 'FILTER',         // 用户手动反选排除
});

export const ACTION_LABELS = Object.freeze({
  [ACTIONS.COPY]: { label: '直通', color: '#10b981', desc: '原样复制到目标包' },
  [ACTIONS.ROUTE]: { label: '路由', color: '#3b82f6', desc: '路径映射至目标布局' },
  [ACTIONS.MIGRATE]: { label: '迁移', color: '#8b5cf6', desc: '适配目标平台的结构迁移' },
  [ACTIONS.SYNTHESIZE]: { label: '合成', color: '#f59e0b', desc: '由互转引擎全新合成' },
  [ACTIONS.DROP]: { label: '丢弃', color: '#ef4444', desc: '不兼容或冗余缓存，安全剔除' },
  [ACTIONS.FILTER]: { label: '排除', color: '#6b7280', desc: '用户手动取消勾选' },
});

// 扩展特殊类目：缓存、备份快照与应用私有
export const SPECIAL_CATEGORIES = Object.freeze({
  CACHE: 'cache',
  BACKUPS: 'backups',
  APP_PRIVATE: 'appPrivate',
});

export const SPECIAL_LABELS = Object.freeze({
  [SPECIAL_CATEGORIES.CACHE]: '派生缓存 (Thumbnails & Cache)',
  [SPECIAL_CATEGORIES.BACKUPS]: '历史备份与聊天备份 (Backups & Snapshots)',
  [SPECIAL_CATEGORIES.APP_PRIVATE]: '应用私有配置 (App Private)',
});

/**
 * 判断条目细分类目
 * @param {string} hubPath
 * @param {string} kind
 * @returns {string}
 */
export function classifyItemCategory(hubPath, kind) {
  if (hubPath.startsWith('thumbnails/') || hubPath.startsWith('_cache/') || hubPath.startsWith('_css/') || hubPath.startsWith('_errors/')) {
    return SPECIAL_CATEGORIES.CACHE;
  }
  if (isBackupChatOrSnapshot(hubPath)) {
    return SPECIAL_CATEGORIES.BACKUPS;
  }
  if (kind === 'tt-app-private' || kind === 'engine-dump' || hubPath.startsWith('_tauritavern/')) {
    return SPECIAL_CATEGORIES.APP_PRIVATE;
  }

  const standardCat = categoryOfHubPath(hubPath);
  return standardCat || 'other';
}

/**
 * 零拷贝深度预检并生成转换预测规划
 * @param {Blob|File|string} source
 * @param {string} target 目标平台 (st|l|tt|pt)
 * @param {object} [options]
 * @param {object} [options.io]
 * @param {Record<string, boolean>} [options.selection]
 * @param {Set<string>} [options.excludedPaths]
 * @param {boolean} [options.includeCache]
 * @param {boolean} [options.includeBackups]
 * @param {boolean} [options.includeAppPrivate]
 * @param {boolean} [options.keepAll]
 * @returns {Promise<object>}
 */
export async function generatePlan(source, target, {
  io = zipIo,
  selection = {},
  excludedPaths = new Set(),
  includeCache = false,
  includeBackups = false,
  includeAppPrivate = false,
  keepAll = false,
  extensionMode = EXTENSION_MODES.FULL,
  keepDevFiles = false,
  pruneBuiltinAssets = false,
} = {}) {
  const detector = await io.openReader(source);
  let detection;
  try {
    detection = await detectFromReader(detector);
  } finally {
    await detector.close();
  }

  const scanner = await io.openReader(source);

  const categories = {};
  const allCategoryKeys = [
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
    SPECIAL_CATEGORIES.BACKUPS,
    SPECIAL_CATEGORIES.CACHE,
    SPECIAL_CATEGORIES.APP_PRIVATE,
  ];

  for (const cat of allCategoryKeys) {
    categories[cat] = {
      label: CATEGORY_LABELS[cat] || SPECIAL_LABELS[cat] || cat,
      count: 0,
      sizeBytes: 0,
      selectedCount: 0,
      selectedSizeBytes: 0,
      items: [],
    };
  }

  const actionStats = {
    [ACTIONS.COPY]: 0,
    [ACTIONS.ROUTE]: 0,
    [ACTIONS.MIGRATE]: 0,
    [ACTIONS.SYNTHESIZE]: 0,
    [ACTIONS.DROP]: 0,
    [ACTIONS.FILTER]: 0,
  };

  let totalSourceFiles = 0;
  let totalSourceBytes = 0;
  let expectedOutputFiles = 0;
  let expectedOutputBytes = 0;

  const synthesizedItems = [];

  try {
    for await (const entry of scanner.entries()) {
      if (entry.isDirectory) {
        entry.skip();
        continue;
      }
      totalSourceFiles += 1;
      const size = entry.uncompressedSize || 0;
      totalSourceBytes += size;

      const routed = routeSource(entry.fileName, detection.layout);
      const category = classifyItemCategory(routed.hubPath, routed.kind);

      let action = ACTIONS.ROUTE;
      let targetPath = null;
      let reason = '';

      // 1. 判断原生处置动作与目标路径
      if (pruneBuiltinAssets && isTavernBuiltinAsset(routed.hubPath)) {
        action = ACTIONS.DROP;
        reason = '酒馆原生固定资产(默认背景/主题/预设)，已智能剔除';
      } else if (isJunkOrDevFile(routed.hubPath, { keepDevFiles, keepAll })) {
        action = ACTIONS.DROP;
        reason = '开发/构建冗余或系统临时文件(安全清洗)';
      } else if (extensionMode === EXTENSION_MODES.MANIFEST && routed.kind === 'extension-pkg') {
        action = ACTIONS.DROP;
        reason = '轻量清单模式：扩展代码由目标酒馆按清单下载';
      } else if (routed.kind === 'manifest') {
        if (target === TARGETS.L) {
          action = ACTIONS.SYNTHESIZE;
          targetPath = 'manifest.json';
          reason = '源清单内容已读取，将重新合成为目标清单';
        } else {
          action = ACTIONS.DROP;
          reason = '源 manifest.json 为中间元数据，目标平台重新合成或不需要';
        }
      } else if (routed.kind === 'engine-dump') {
        if (target === TARGETS.L) {
          action = ACTIONS.COPY;
          targetPath = entry.fileName;
          reason = 'Luker 引擎数据原样保留';
        } else {
          action = ACTIONS.DROP;
          reason = 'Luker 数据库引擎私有数据，跨平台已安全丢弃';
        }
      } else if (category === SPECIAL_CATEGORIES.CACHE) {
        if (keepAll || includeCache) {
          targetPath = targetEntryPath(routed.hubPath, target);
          action = targetPath === entry.fileName ? ACTIONS.COPY : ACTIONS.ROUTE;
          reason = '用户勾选保留派生缓存';
        } else {
          action = ACTIONS.DROP;
          reason = '派生缩略图与缓存，目标平台导入后会自动重建';
        }
      } else if (category === SPECIAL_CATEGORIES.BACKUPS) {
        if (includeBackups || keepAll) {
          targetPath = targetEntryPath(routed.hubPath, target);
          action = targetPath === entry.fileName ? ACTIONS.COPY : ACTIONS.ROUTE;
          reason = '备份聊天记录与历史快照';
        } else {
          action = ACTIONS.DROP;
          reason = '备份聊天记录与快照(默认不包含)';
        }
      } else if (category === SPECIAL_CATEGORIES.APP_PRIVATE) {
        if (target === TARGETS.TT || keepAll || includeAppPrivate) {
          targetPath = target === TARGETS.TT ? entry.fileName : routed.hubPath;
          action = targetPath === entry.fileName ? ACTIONS.COPY : ACTIONS.ROUTE;
          reason = '应用级私有配置';
        } else {
          action = ACTIONS.DROP;
          reason = '应用级私有配置，目标平台不消费';
        }
      } else if (routed.kind === 'extension-pkg' && (target === TARGETS.TT || target === TARGETS.PT)) {
        targetPath = targetEntryPath(routed.hubPath, target);
        action = ACTIONS.MIGRATE;
        reason = `适配 ${target.toUpperCase()} 平台 third-party 扩展目录布局`;
      } else if (routed.kind === 'extension-pkg' && (target === TARGETS.ST || target === TARGETS.L)
        && (entry.fileName.startsWith('extensions/third-party/') || entry.fileName.startsWith('data/extensions/third-party/'))) {
        targetPath = targetEntryPath(routed.hubPath, target);
        action = ACTIONS.MIGRATE;
        reason = '消除错误的 third-party 嵌套，自动平铺为目标平台规范布局';
      } else {
        targetPath = targetEntryPath(routed.hubPath, target);
        action = targetPath === entry.fileName ? ACTIONS.COPY : ACTIONS.ROUTE;
      }

      // 2. 判定用户选择状态（类目级 + 单文件穿透级）
      let isSelected = true;
      let effectiveAction = action;

      if (action === ACTIONS.DROP) {
        isSelected = false;
      } else {
        const isCategoryDeselected = (selection[category] === false);
        const isPathExcluded = excludedPaths.has(entry.fileName) || excludedPaths.has(routed.hubPath);

        if (isCategoryDeselected) {
          isSelected = false;
          effectiveAction = ACTIONS.FILTER;
          reason = '所属类目未勾选';
        } else if (isPathExcluded) {
          isSelected = false;
          effectiveAction = ACTIONS.FILTER;
          reason = '单项穿透反选排除';
        }
      }

      actionStats[effectiveAction] = (actionStats[effectiveAction] || 0) + 1;

      if (isSelected) {
        expectedOutputFiles += 1;
        expectedOutputBytes += size;
      }

      const planItem = {
        sourcePath: entry.fileName,
        hubPath: routed.hubPath,
        targetPath,
        category,
        sizeBytes: size,
        action: effectiveAction,
        rawAction: action,
        reason,
        selected: isSelected,
      };

      if (!categories[category]) {
        categories[category] = {
          label: category,
          count: 0,
          sizeBytes: 0,
          selectedCount: 0,
          selectedSizeBytes: 0,
          items: [],
        };
      }

      categories[category].count += 1;
      categories[category].sizeBytes += size;
      if (isSelected) {
        categories[category].selectedCount += 1;
        categories[category].selectedSizeBytes += size;
      }
      categories[category].items.push(planItem);

      entry.skip();
    }
  } finally {
    await scanner.close();
  }

  // 3. 目标平台合成项预测
  if (target === TARGETS.L) {
    synthesizedItems.push({
      targetPath: 'manifest.json',
      action: ACTIONS.SYNTHESIZE,
      reason: '生成 Luker 规范清单 (含 schemaVersion 与 selection 状态)',
      estimatedSizeBytes: 256,
    });
    expectedOutputFiles += 1;
    expectedOutputBytes += 256;
    actionStats[ACTIONS.SYNTHESIZE] += 1;
  }
  if (target === TARGETS.ST) {
    synthesizedItems.push({
      targetPath: '_convert/README-ST.txt',
      action: ACTIONS.SYNTHESIZE,
      reason: '生成 SillyTavern 用户解压覆盖指南',
      estimatedSizeBytes: 300,
    });
    expectedOutputFiles += 1;
    expectedOutputBytes += 300;
    actionStats[ACTIONS.SYNTHESIZE] += 1;
  }

  return {
    sourceLayout: detection.layout,
    targetLayout: target,
    totalSourceFiles,
    totalSourceBytes,
    expectedOutputFiles,
    expectedOutputBytes,
    categories,
    synthesizedItems,
    actionStats,
  };
}
