import { NullZipWriter } from './null-writer.js';
import { Report } from './report.js';
import { detectFromReader, LAYOUTS } from './detect.js';
import { zipIo } from './zip-io.js';
import { categoryOfHubPath } from './inspect.js';
import { isTavernBuiltinAsset } from './builtin-assets.js';

/**
 * 转换管线:源布局规范化为 hub(ST 摊平)→ 逐条目按目标适配写出。
 * 映射规则的证据与依据见任务 research/platform-facts.md 与 design.md §2/§4。
 *
 * 内存模型:逐条目读入 Buffer 再写出(峰值 ≈ 最大单文件),不整包驻留。
 * 顺序:保持源条目顺序(同输入同输出),合成条目(目标 manifest、extension-sources)
 * 统一追加在尾部、按名字排序。
 *
 * IO 注入:zip 的读写经 options.io 适配器(Node 用 src/io/node-io.js,浏览器插件用
 * src/io/zipjs-io.js),本模块不感知文件系统与运行时;两个适配器产物必须同构(AC9)。
 */

export const TARGETS = Object.freeze({
  ST: 'st',
  L: 'l',
  TT: 'tt',
  PT: 'pt',
});

export const EXTENSION_MODES = Object.freeze({
  MANIFEST: 'manifest', // 轻量清单模式:仅导出来源清单，不打包插件实体与 git packfile，防 408 超时
  FULL: 'full',         // 完整离线包模式:打包代码文件，适合无网环境
});

const TT_USER_PREFIX = 'data/default-user/';
const TT_THIRD_PARTY_PREFIX = 'data/extensions/third-party/';
const TT_SOURCES_PREFIX = 'data/_tauritavern/extension-sources/';
const TT_PRIVATE_PREFIXES = ['data/_cache/', 'data/_css/', 'data/_errors/'];
const TT_PRIVATE_FILES = ['data/content.log', 'data/content.log.1'];
const DERIVED_DIRS = ['thumbnails/', 'backups/', 'vectors/'];
const ENGINE_DUMP_ENTRIES = ['_engine_dump.bin', '_engine_meta.json'];
const THIRD_PARTY_PREFIX = 'extensions/third-party/';
const DATA_PREFIX = 'data/';
const USER_EXTENSIONS_PREFIX = 'extensions/';
/** TT 写进用户目录的私有/派生内容(hub 路径视角)。 */
const TT_APP_PRIVATE_USER = ['tauritavern-settings.json', 'user/lan-sync/'];
const TT_DERIVED_USER = ['content.log', 'user/cache/'];

const FIXED_TIMESTAMP = '2020-01-01T00:00:00.000Z';

/**
 * 判断条目是否属于开发垃圾、构建冗余或系统临时文件
 * @param {string} hubPath hub 路径
 * @param {object} [options]
 * @param {boolean} [options.keepDevFiles] 是否保留开发与构建文件
 * @param {boolean} [options.keepAll] 是否保留所有内容
 * @returns {boolean}
 */
export function isJunkOrDevFile(hubPath, { keepDevFiles = false, keepAll = false } = {}) {
  if (keepAll) return false;

  const fileName = hubPath.slice(hubPath.lastIndexOf('/') + 1);

  // 1. 系统级垃圾文件（任何情况均默认剔除）
  if (
    fileName === '.DS_Store'
    || fileName === 'Thumbs.db'
    || fileName === 'desktop.ini'
    || hubPath.startsWith('__MACOSX/')
    || hubPath.includes('/__MACOSX/')
    || fileName.endsWith('.tmp')
  ) {
    return true;
  }

  // 2. 开发与构建冗余（当 !keepDevFiles 时剔除）
  if (!keepDevFiles) {
    // 依赖目录与测试目录
    if (
      hubPath.includes('/node_modules/')
      || hubPath.startsWith('node_modules/')
      || hubPath.includes('/test/')
      || hubPath.includes('/tests/')
      || hubPath.includes('/__tests__/')
      || hubPath.includes('/coverage/')
    ) {
      return true;
    }

    // 构建与工程配置文件
    if (
      fileName.startsWith('webpack.config.')
      || fileName.startsWith('vite.config.')
      || fileName.startsWith('rollup.config.')
      || fileName.startsWith('tsconfig.')
      || fileName === 'tsconfig.json'
      || fileName === '.babelrc'
      || fileName.startsWith('babel.config.')
    ) {
      return true;
    }

    // 源码映射与测试脚本
    if (
      fileName.endsWith('.map')
      || fileName.endsWith('.spec.js')
      || fileName.endsWith('.test.js')
      || fileName.endsWith('.spec.ts')
      || fileName.endsWith('.test.ts')
    ) {
      return true;
    }

    // Git 运行时冗余 (logs/、hooks/、refs/original/)
    if (
      hubPath.includes('/.git/logs/')
      || hubPath.includes('/.git/hooks/')
      || hubPath.includes('/.git/refs/original/')
    ) {
      return true;
    }
  }

  return false;
}

export function extractGitRemoteUrl(configText) {
  if (!configText) return null;
  const match = configText.match(/\[remote\s+["']origin["']\][\s\S]*?url\s*=\s*([^\r\n]+)/i)
    || configText.match(/url\s*=\s*([^\r\n]+)/i);
  return match ? match[1].trim() : null;
}

export function extractGitBranch(headText) {
  if (!headText) return null;
  const match = headText.match(/ref:\s*refs\/heads\/([^\r\n]+)/i);
  return match ? match[1].trim() : null;
}

export function extensionFolderName(hubPath) {
  if (!hubPath.startsWith('extensions/')) return '';
  const rest = hubPath.slice('extensions/'.length);
  const slash = rest.indexOf('/');
  return slash > 0 ? rest.slice(0, slash) : rest;
}

export function extensionRelativePath(hubPath) {
  if (!hubPath.startsWith('extensions/')) return '';
  const rest = hubPath.slice('extensions/'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return rest;
  return rest.slice(slash + 1);
}

const INSTALL_MD = `# 手动导入说明(ST 目标)

SillyTavern 没有整包导入功能。把本压缩包解压后,将其中所有文件与目录
(除 _convert/ 外)覆盖到 SillyTavern 的用户数据目录:

- 默认单用户安装:  <SillyTavern>/data/default-user/
- 多用户:           <SillyTavern>/data/<你的用户句柄>/

覆盖前请先备份原目录。secrets.json 已包含在本包内(会覆盖现有密钥)。
`;

const L_SELECTION = Object.freeze({
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
 * 把 zip 源包转换为目标平台包。
 * @param {string} sourcePath 源 zip 路径
 * @param {string} targetPath 产物 zip 路径
 * @param {object} options
 * @param {string} options.target st|l|tt|pt
 * @param {boolean} [options.keepAll] 保留派生缓存与 TT 私有目录
 * @param {boolean} [options.dryRun] 只产出报告不写文件(数据条目跳过读取)
 * @returns {Promise<Report>}
 */
export async function convert(sourcePath, targetPath, {
  target,
  keepAll = false,
  dryRun = false,
  io = zipIo,
  onProgress,
  selection,
  excludedPaths,
  includeCache = false,
  includeBackups = true,
  includeAppPrivate = false,
  compressionLevel = 5,
  extensionMode = EXTENSION_MODES.FULL,
  keepDevFiles = false,
  pruneBuiltinAssets = false,
} = {}) {
  if (!target || !Object.values(TARGETS).includes(target)) {
    throw new Error(`convert: target 必须是 ${Object.values(TARGETS).join('|')} 之一`);
  }
  if (!io || typeof io.openReader !== 'function' || typeof io.createWriter !== 'function') {
    throw new Error('convert: 必须提供有效的 io 适配器 (openReader/createWriter)');
  }

  // 检测用一次遍历,yauzl/zip.js 的游标不能倒回,主循环须重新打开。
  const detector = await io.openReader(sourcePath);
  let detection;
  try {
    detection = await detectFromReader(detector);
  } finally {
    await detector.close();
  }
  const report = new Report(detection.layout, target);
  if (detection.layout === LAYOUTS.PT_NATIVE) {
    throw new Error('PT 原生归档(sha256 清单)暂不支持,请先从 PT 导出 TT 迁移包');
  }
  if (detection.layout === LAYOUTS.UNKNOWN) {
    throw new Error('无法识别源包布局(无 manifest.json / data/ 根 / 摊平用户目录标记)');
  }

  const reader = await io.openReader(sourcePath);
  const writer = dryRun ? new NullZipWriter() : await io.createWriter(targetPath, { level: compressionLevel });
  const totalEntries = reader.totalEntries ?? 0;
  let processedEntries = 0;

  const context = {
    manifest: null,
    extensionSources: new Map(), // folderName -> {scope, fileName, record}
    extensionManifests: new Map(), // folderName -> parsed manifest object
    extensionGitMeta: new Map(), // folderName -> { remoteUrl, branch, commit }
    sawEngineDump: false,
    thirdPartyFlattenedCount: 0, // ST/L 目标: 消除错误的 third-party 嵌套并拉平的条目数
    userExtensionsMigrated: 0, // PT/TT 目标: 迁移为 third-party 布局的用户级扩展条目数
    userExtensionCollisions: new Set(), // 与 third-party 同名而被丢弃的扩展名
  };

  // 数据条目一律惰性流直通(addLazy:泵到该条目才打开源流,配合 yazl 顺序泵
  // 满足 yauzl 单读流约束);dry-run 不打开任何数据流,报告按声明大小计数。
  const lazyOpen = (entryApi) => (cb) => {
    entryApi.openStream().then((stream) => cb(null, stream), (err) => cb(err));
  };

  // 预扫中央目录(不开文件流,开销可忽略):PT 目标迁移用户级扩展前,
  // 需要知道源里已有哪些 third-party 目录名,同名时保留第三方副本。
  const thirdPartyFolders = new Set();
  if (target === TARGETS.PT) {
    const scanner = await io.openReader(sourcePath);
    try {
      for await (const entry of scanner.entries()) {
        const name = thirdPartyFolderOf(entry.fileName, detection.layout);
        if (name) thirdPartyFolders.add(name);
        entry.skip();
      }
    } finally {
      await scanner.close();
    }
  }

  try {
    for await (const entry of reader.entries()) {
      processedEntries++;
      if (typeof onProgress === 'function') {
        onProgress(processedEntries, totalEntries, entry.fileName);
      }
      if (entry.isDirectory) {
        entry.skip();
        continue;
      }
      let routed = routeSource(entry.fileName, detection.layout);

      // 酒馆原生固定资产智能过滤 (剔除系统自带默认背景、默认主题等重复素材)
      if (pruneBuiltinAssets && isTavernBuiltinAsset(routed.hubPath)) {
        entry.skip();
        report.dropped(routed.hubPath, '酒馆原生固定资产(默认背景/主题/预设)，已智能剔除');
        continue;
      }

      // 垃圾文件与构建冗余过滤（清理开发垃圾、构建脚本与临时缓存）
      if (isJunkOrDevFile(routed.hubPath, { keepDevFiles, keepAll })) {
        entry.skip();
        report.dropped(routed.hubPath, '开发/构建冗余或系统临时文件(安全清洗)');
        continue;
      }

      // 按单文件细粒度排除过滤 (可穿透树形勾选)
      if (excludedPaths && (excludedPaths.has(entry.fileName) || excludedPaths.has(routed.hubPath))) {
        entry.skip();
        report.filtered(routed.hubPath, 'item-excluded');
        continue;
      }

      // 按历史备份快照开关过滤
      if (routed.hubPath.startsWith('backups/')) {
        if (!includeBackups && !keepAll) {
          entry.skip();
          report.dropped(routed.hubPath, '历史备份快照(用户选择不包含)');
          continue;
        }
      }

      // 按用户类目选择过滤（脱敏排除）
      if (selection && typeof selection === 'object') {
        const cat = categoryOfHubPath(routed.hubPath);
        if (cat && (selection[cat] === false || (cat === 'extensions' && selection.extensions === false))) {
          entry.skip();
          report.filtered(routed.hubPath, cat);
          continue;
        }
      }

      // 元数据条目:体积小、内容被解析使用,走缓冲
      if (routed.kind === 'manifest') {
        context.manifest = parseJsonSafe(await entry.read());
        if (target !== TARGETS.L) {
          report.dropped(routed.hubPath, '源 manifest 为元数据,由转换器按目标重新合成');
        }
        continue;
      }
      if (routed.kind === 'extension-source') {
        const record = parseJsonSafe(await entry.read());
        context.extensionSources.set(routed.source.name, { ...routed.source, record });
        continue;
      }

      if (routed.kind === 'engine-dump') {
        context.sawEngineDump = true;
        if (target === TARGETS.L) {
          if (!dryRun) writer.addLazy(entry.fileName, lazyOpen(entry));
          report.copied(routed.hubPath, entry.uncompressedSize);
        } else {
          entry.skip();
          report.dropped(routed.hubPath, 'L 引擎旁路数据,仅 L 目标有意义');
          report.warn(
            '源包含 _engine_dump.bin/_engine_meta.json(数据库引擎状态),已按设计丢弃;'
            + '跨存储模式迁移请用 L 自带的 cross-mode restore 流程。',
          );
        }
        continue;
      }
      if (routed.kind === 'tt-private') {
        if (keepAll || includeCache) {
          const outPath = (target === TARGETS.TT || target === TARGETS.PT)
            ? entry.fileName
            : routed.hubPath;
          if (!dryRun) writer.addLazy(outPath, lazyOpen(entry));
          report.copied(routed.hubPath, entry.uncompressedSize);
        } else {
          entry.skip();
          report.dropped(routed.hubPath, 'TT 私有/缓存,目标平台不消费');
        }
        continue;
      }
      if (routed.kind === 'tt-app-private') {
        // TT 应用级私有设置:TT 目标原位保留,其余目标丢弃
        if (target === TARGETS.TT || keepAll || includeAppPrivate) {
          const outPath = target === TARGETS.TT ? entry.fileName : routed.hubPath;
          if (!dryRun) writer.addLazy(outPath, lazyOpen(entry));
          report.copied(routed.hubPath, entry.uncompressedSize);
        } else {
          entry.skip();
          report.dropped(routed.hubPath, 'TT 应用私有设置,仅 TT 目标有意义');
        }
        continue;
      }
      if (routed.kind === 'user' && DERIVED_DIRS.some((dir) => routed.hubPath.startsWith(dir))) {
        routed = { kind: 'derived', hubPath: routed.hubPath };
      }
      if (routed.kind === 'derived') {
        if (keepAll || includeCache) {
          if (!dryRun) writer.addLazy(targetEntryPath(routed.hubPath, target), lazyOpen(entry));
          report.copied(routed.hubPath, entry.uncompressedSize);
        } else {
          entry.skip();
          report.dropped(routed.hubPath, '派生缓存,导入后会自动重新生成');
        }
        continue;
      }
      if (routed.kind === 'drop') {
        entry.skip();
        report.dropped(routed.hubPath, routed.reason);
        continue;
      }

      // L 目标:image-metadata.json 不在 L 任何备份类目里(users.js getUserBackupTargets),
      // L 恢复时必然跳过;ST/TT/PT 目标保留(ST 背景分组索引用它)。
      if (target === TARGETS.L && routed.hubPath === 'image-metadata.json') {
        entry.skip();
        report.dropped(routed.hubPath, 'L 备份类目不含 image-metadata.json,恢复时也不会落地');
        continue;
      }

      // user / extension-pkg:流式直通，或轻量清单解析
      if (routed.kind === 'extension-pkg') {
        const restUnderExt = routed.hubPath.slice('extensions/'.length);
        const extFolder = extensionFolderName(routed.hubPath);
        const relPath = extensionRelativePath(routed.hubPath);

        // 散文件过滤 (如 extensions/ 根目录下的 .gitkeep): TT/PT 目标只消费 目录名/文件 形态
        if ((target === TARGETS.TT || target === TARGETS.PT) && !restUnderExt.includes('/')) {
          entry.skip();
          report.dropped(routed.hubPath, 'extensions 根下的散文件,目标平台不消费');
          continue;
        }

        // ST/L 目标: 遇到错误的 third-party 嵌套布局，自动拉平为标准平铺布局
        if (target === TARGETS.ST || target === TARGETS.L) {
          if (entry.fileName.startsWith('extensions/third-party/')
            || entry.fileName.startsWith('data/extensions/third-party/')) {
            context.thirdPartyFlattenedCount += 1;
          }
        }

        // PT / TT 目标: 用户级扩展迁移为 third-party 布局，与 third-party 同名时保留第三方副本
        const isUserExt = !entry.fileName.startsWith('extensions/third-party/')
          && !entry.fileName.startsWith('data/extensions/third-party/');

        if ((target === TARGETS.PT || target === TARGETS.TT) && isUserExt) {
          if (thirdPartyFolders.has(extFolder)) {
            context.userExtensionCollisions.add(extFolder);
            entry.skip();
            report.dropped(routed.hubPath, `与 third-party 扩展 "${extFolder}" 同名,保留第三方副本`);
            continue;
          }
          context.userExtensionsMigrated += 1;
        }

        // 1. 读取扩展清单 manifest.json
        if (relPath === 'manifest.json' || relPath.endsWith('/manifest.json')) {
          const data = await entry.read();
          noteExtensionPackage(context, routed.hubPath, data);
          if (extensionMode !== EXTENSION_MODES.MANIFEST) {
            const outPath = targetEntryPath(routed.hubPath, target);
            await writer.add(outPath, data);
            report.copied(routed.hubPath, entry.uncompressedSize);
          } else {
            report.dropped(routed.hubPath, '轻量清单模式：已记录扩展清单，实体文件不打包');
          }
          continue;
        }

        // 2. 解析 Git 仓库配置与指针 (.git/config, .git/HEAD 等)
        if (relPath === '.git/config' || relPath.endsWith('/.git/config')) {
          try {
            const text = JSON_DECODER.decode(await entry.read());
            const url = extractGitRemoteUrl(text);
            if (url && extFolder) {
              const current = context.extensionGitMeta.get(extFolder) || {};
              current.remoteUrl = url;
              context.extensionGitMeta.set(extFolder, current);
            }
          } catch { /* 忽略读取错误 */ }
          if (extensionMode !== EXTENSION_MODES.MANIFEST) {
            const outPath = targetEntryPath(routed.hubPath, target);
            if (!dryRun) writer.addLazy(outPath, lazyOpen(entry));
            report.copied(routed.hubPath, entry.uncompressedSize);
          } else {
            report.dropped(routed.hubPath, '轻量清单模式：已解析 Git Remote URL，实体文件不打包');
          }
          continue;
        }

        if (relPath === '.git/HEAD' || relPath.endsWith('/.git/HEAD')) {
          try {
            const text = JSON_DECODER.decode(await entry.read());
            const branch = extractGitBranch(text);
            if (branch && extFolder) {
              const current = context.extensionGitMeta.get(extFolder) || {};
              current.branch = branch;
              context.extensionGitMeta.set(extFolder, current);
            }
          } catch { /* 忽略读取错误 */ }
          if (extensionMode !== EXTENSION_MODES.MANIFEST) {
            const outPath = targetEntryPath(routed.hubPath, target);
            if (!dryRun) writer.addLazy(outPath, lazyOpen(entry));
            report.copied(routed.hubPath, entry.uncompressedSize);
          } else {
            report.dropped(routed.hubPath, '轻量清单模式：已解析 Git 分支，实体文件不打包');
          }
          continue;
        }

        if (relPath.includes('/.git/refs/heads/') || relPath.startsWith('.git/refs/heads/')) {
          try {
            const commit = JSON_DECODER.decode(await entry.read()).trim();
            if (commit && extFolder && /^[0-9a-f]{40}$/i.test(commit)) {
              const current = context.extensionGitMeta.get(extFolder) || {};
              current.commit = commit;
              context.extensionGitMeta.set(extFolder, current);
            }
          } catch { /* 忽略读取错误 */ }
          if (extensionMode !== EXTENSION_MODES.MANIFEST) {
            const outPath = targetEntryPath(routed.hubPath, target);
            if (!dryRun) writer.addLazy(outPath, lazyOpen(entry));
            report.copied(routed.hubPath, entry.uncompressedSize);
          } else {
            report.dropped(routed.hubPath, '轻量清单模式：已解析 Git Commit，实体文件不打包');
          }
          continue;
        }

        // 3. 轻量清单模式下，跳过其他代码文件
        if (extensionMode === EXTENSION_MODES.MANIFEST) {
          entry.skip();
          report.dropped(routed.hubPath, '轻量清单模式：扩展代码由目标酒馆按清单下载');
          continue;
        }

        // 4. 完整模式下直通写出
        const outPath = targetEntryPath(routed.hubPath, target);
        if (!dryRun) writer.addLazy(outPath, lazyOpen(entry));
        report.copied(routed.hubPath, entry.uncompressedSize);
        continue;
      }

      const outPath = targetEntryPath(routed.hubPath, target);
      if (!dryRun) writer.addLazy(outPath, lazyOpen(entry));
      report.copied(routed.hubPath, entry.uncompressedSize);
    }

    await emitSynthesized(writer, report, context, target, selection, { extensionMode });
    await writer.close();
    return report;
  } catch (error) {
    await writer.abort();
    throw error;
  } finally {
    await reader.close();
  }
}

/** 源条目路由:决定 hub 路径与处理类别。hub 路径 = ST 摊平用户目录视角。 */
export function routeSource(sourcePath, layout) {
  if (layout === LAYOUTS.TT) {
    if (sourcePath.startsWith(TT_USER_PREFIX)) {
      const hubPath = sourcePath.slice(TT_USER_PREFIX.length);
      if (sourcePath.startsWith('data/default-user/_compat/')) {
        return { kind: 'compat', hubPath: sourcePath.slice('data/default-user/'.length) };
      }
      if (TT_APP_PRIVATE_USER.some((p) => hubPath === p || hubPath.startsWith(p))) {
        return { kind: 'tt-app-private', hubPath };
      }
      if (TT_DERIVED_USER.some((p) => hubPath === p || hubPath.startsWith(p))) {
        return { kind: 'tt-private', hubPath };
      }
      return { kind: 'user', hubPath };
    }
    if (sourcePath.startsWith(TT_THIRD_PARTY_PREFIX)) {
      const rest = sourcePath.slice(TT_THIRD_PARTY_PREFIX.length);
      return { kind: 'extension-pkg', hubPath: `extensions/${rest}` };
    }
    if (sourcePath.startsWith(TT_SOURCES_PREFIX)) {
      const rest = sourcePath.slice(TT_SOURCES_PREFIX.length);
      const separator = rest.indexOf('/');
      const scope = separator > 0 ? rest.slice(0, separator) : 'global';
      const fileName = separator > 0 ? rest.slice(separator + 1) : rest;
      if (fileName.endsWith('.json')) {
        return {
          kind: 'extension-source',
          hubPath: `_tauritavern/extension-sources/${scope}/${fileName}`,
          source: { scope, name: fileName.slice(0, -'.json'.length), fileName },
        };
      }
      return { kind: 'drop', hubPath: `_tauritavern/extension-sources/${rest}`, reason: 'TT 来源记录:非 JSON 条目' };
    }
    if (sourcePath.startsWith('data/_tauritavern/')) {
      // extension-sources 已在上面返回;其余是 TT 应用私有数据(window-state/mcp/skills/extension-store)
      return { kind: 'tt-app-private', hubPath: sourcePath.slice(DATA_PREFIX.length) };
    }
    if (TT_PRIVATE_PREFIXES.some((prefix) => sourcePath.startsWith(prefix))
      || TT_PRIVATE_FILES.includes(sourcePath)) {
      return { kind: 'tt-private', hubPath: sourcePath.slice(DATA_PREFIX.length) };
    }
    return { kind: 'drop', hubPath: sourcePath.slice(DATA_PREFIX.length), reason: 'TT data 根下未归类内容' };
  }

  // 跨平台兼容私有沙箱条目
  if (sourcePath.startsWith('_compat/')) {
    return { kind: 'compat', hubPath: sourcePath };
  }

  // st / l:摊平布局
  if (sourcePath === 'manifest.json') {
    return { kind: 'manifest', hubPath: 'manifest.json' };
  }
  if (ENGINE_DUMP_ENTRIES.includes(sourcePath)) {
    return { kind: 'engine-dump', hubPath: sourcePath };
  }
  if (sourcePath.startsWith('extensions/third-party/')) {
    const rest = sourcePath.slice('extensions/third-party/'.length);
    return { kind: 'extension-pkg', hubPath: `extensions/${rest}` };
  }
  if (sourcePath.startsWith('extensions/')) {
    return { kind: 'extension-pkg', hubPath: sourcePath };
  }
  return { kind: 'user', hubPath: sourcePath };
}

/** hub 路径 → 目标平台上的最终条目路径。包含私有配置沙箱解包与跨平台安全隔离。 */
export function targetEntryPath(hubPath, target) {
  // 1. 跨平台私有配置沙箱解包 (Unwrap compat)
  if (hubPath.startsWith('_compat/')) {
    const parts = hubPath.slice('_compat/'.length).split('/');
    const platform = parts[0]; // 'luker', 'tt', 'st'
    const subPath = parts.slice(1).join('/');
    if ((platform === 'luker' || platform === 'l') && target === TARGETS.L) {
      return subPath;
    }
    if (platform === 'tt' && target === TARGETS.TT) {
      return `data/default-user/${subPath}`;
    }
    if (platform === 'st' && target === TARGETS.ST) {
      return subPath;
    }
  }

  // 2. 目标不是 Luker 时，Luker 专属私有文件转入 _compat/luker/
  if (target !== TARGETS.L) {
    if (hubPath === 'stats.json' || hubPath === 'macros.json') {
      const compatPath = `_compat/luker/${hubPath}`;
      if (target === TARGETS.TT || target === TARGETS.PT) {
        return `data/default-user/${compatPath}`;
      }
      return compatPath;
    }
  }

  // 3. 目标不是 TT 时，TT 专属私有文件转入 _compat/tt/
  if (target !== TARGETS.TT) {
    if (hubPath === 'tauritavern-settings.json') {
      const compatPath = `_compat/tt/${hubPath}`;
      if (target === TARGETS.PT) {
        return `data/default-user/${compatPath}`;
      }
      return compatPath;
    }
  }

  // 4. 标准平台布局映射
  if (target === TARGETS.TT || target === TARGETS.PT) {
    if (hubPath.startsWith('extensions/')) {
      return `data/extensions/third-party/${hubPath.slice('extensions/'.length)}`;
    }
    return `data/default-user/${hubPath}`;
  }
  return hubPath;
}

/** 预扫用:路径若属于扩展包,返回目录名(st/l 与 TT 两种布局都认)。 */
export function thirdPartyFolderOf(sourcePath, layout) {
  const prefixes = layout === LAYOUTS.TT
    ? [TT_THIRD_PARTY_PREFIX]
    : ['extensions/third-party/'];
  for (const prefix of prefixes) {
    if (!sourcePath.startsWith(prefix)) continue;
    const rest = sourcePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash > 0) return rest.slice(0, slash);
  }
  return null;
}

function noteExtensionPackage(context, hubPath, data) {
  if (!hubPath.startsWith('extensions/')) return;
  const rest = hubPath.slice('extensions/'.length);
  const separator = rest.indexOf('/');
  if (separator <= 0) return;
  const folderName = rest.slice(0, separator);
  const relative = rest.slice(separator + 1);
  if (relative === 'manifest.json' && !context.extensionManifests.has(folderName)) {
    const parsed = parseJsonSafe(data);
    if (parsed) context.extensionManifests.set(folderName, parsed);
  }
}

/**
 * 尾部合成条目:目标 manifest(L)、extension-sources(pt/tt)、官方扩展下载索引、离线脚本与 ST 安装说明。
 */
async function emitSynthesized(writer, report, context, target, selection, { extensionMode = EXTENSION_MODES.FULL } = {}) {
  if (target === TARGETS.L) {
    const baseSelection = { ...L_SELECTION };
    if (selection && typeof selection === 'object') {
      for (const [key, val] of Object.entries(selection)) {
        if (key in baseSelection) {
          baseSelection[key] = Boolean(val);
        }
      }
      // 兼容旧版/别名:
      if (selection.worlds === false) baseSelection.lorebooks = false;
      if (selection.avatars === false) baseSelection.assets = false;
    }
    const manifest = {
      schemaVersion: 1,
      createdAt: FIXED_TIMESTAMP,
      handle: context.manifest?.handle ?? 'default-user',
      selection: baseSelection,
    };
    await writer.add('manifest.json', encodeJson(manifest));
    report.synthesized('manifest.json');
  }

  // 汇总所有已知扩展
  const allExtNames = new Set([
    ...context.extensionManifests.keys(),
    ...context.extensionSources.keys(),
    ...context.extensionGitMeta.keys(),
  ]);

  const extItems = [];
  for (const name of [...allExtNames].sort()) {
    const manifest = context.extensionManifests.get(name) || {};
    const gitMeta = context.extensionGitMeta.get(name) || {};
    const srcRecord = context.extensionSources.get(name)?.record || {};
    const url = gitMeta.remoteUrl || srcRecord.remote_url || (typeof manifest.homePage === 'string' ? manifest.homePage.trim() : '');
    const branch = gitMeta.branch || srcRecord.reference || 'main';
    const commit = gitMeta.commit || srcRecord.installed_commit || '';
    const displayName = manifest.display_name || name;
    const description = manifest.description || '';
    extItems.push({
      id: name,
      name,
      displayName,
      description,
      url,
      branch,
      commit,
      version: manifest.version || '1.0.0',
      type: 'extension',
      manifest,
    });
  }

  // 仅在 ST / L 目标且启用清单模式时，生成结构化清单与官方 Content Downloader 索引
  const shouldEmitManifest = (target === TARGETS.ST || target === TARGETS.L)
    && extensionMode === EXTENSION_MODES.MANIFEST;

  if (extItems.length > 0 && (!selection || selection.extensions !== false) && shouldEmitManifest) {
    // 1. 生成与 SillyTavern 官方 Content (assets) 下载规范完全兼容的 extensions-index.json
    const officialIndex = {
      extension: extItems.map(({ id, displayName, name, description, url, branch, commit, type }) => ({
        id,
        name: displayName || name,
        description,
        url,
        branch,
        commit,
        type,
      })),
    };
    await writer.add('extensions-index.json', encodeJson(officialIndex));
    report.synthesized('extensions-index.json');

    // 2. 生成转换器结构化清单供宿主插件自动恢复
    const convertManifest = {
      converter: 'st-zip-converter',
      generatedAt: FIXED_TIMESTAMP,
      mode: extensionMode,
      total: extItems.length,
      extensions: extItems,
    };
    await writer.add('_convert/extensions-manifest.json', encodeJson(convertManifest));
    report.synthesized('_convert/extensions-manifest.json');

    report.warn(
      `已启用轻量清单模式：已记录 ${extItems.length} 个扩展清单（未打包实体代码与 Git packfile），`
      + '已生成 extensions-index.json 与 _convert/extensions-manifest.json。',
    );
  }

  if ((target === TARGETS.ST || target === TARGETS.L) && context.thirdPartyFlattenedCount > 0) {
    report.warn(
      `已针对 ${target.toUpperCase()} 平台规范消除错误的 third-party 嵌套，自动将 ${context.thirdPartyFlattenedCount} 个扩展条目拉平为标准平铺布局 (extensions/<name>/)。`,
    );
  }

  if ((target === TARGETS.PT || target === TARGETS.TT) && context.userExtensionsMigrated > 0) {
    report.warn(
      `已将 ${context.userExtensionsMigrated} 个用户级 extensions/** 条目迁移为 third-party 布局`
      + `(${target.toUpperCase()} 规范需放置在 data/extensions/third-party/); `
      + '来源记录取自各扩展 manifest 的 homePage。',
    );
  }
  if ((target === TARGETS.PT || target === TARGETS.TT) && context.userExtensionCollisions.size > 0) {
    report.warn(
      `以下用户级扩展与 third-party 同名,已保留第三方副本: `
      + [...context.userExtensionCollisions].sort().join(', '),
    );
  }

  if ((target === TARGETS.PT || target === TARGETS.TT) && (!selection || selection.extensions !== false)) {
    for (const [path, value] of buildExtensionSources(context, report)) {
      await writer.add(path, encodeJson(value));
      report.synthesized(path);
    }
  }

  if (target === TARGETS.ST) {
    await writer.add('_convert/INSTALL.md', encodeText(INSTALL_MD));
    report.synthesized('_convert/INSTALL.md');
    await writer.add('_convert/meta.json', encodeJson({
      converter: 'tavern-convert',
      generatedAt: FIXED_TIMESTAMP,
      note: '本目录不会被任何平台消费,仅供人工核对。',
    }));
    report.synthesized('_convert/meta.json');
  }
}

/**
 * PT/TT 目标的 extension-sources 产出:
 * - 源里已有记录 → 原样保留(保 reference/installed_commit,更新链不断)
 * - 没有记录 → 从扩展 manifest 的 homePage 或 Git 提取信息合成
 */
function buildExtensionSources(context, report) {
  const output = new Map();

  for (const { scope, fileName, record } of context.extensionSources.values()) {
    if (record) output.set(`data/_tauritavern/extension-sources/${scope}/${fileName}`, record);
  }

  const allNames = new Set([
    ...context.extensionManifests.keys(),
    ...context.extensionGitMeta.keys(),
  ]);

  for (const folderName of allNames) {
    if (context.extensionSources.has(folderName)) continue;
    const manifest = context.extensionManifests.get(folderName) || {};
    const gitMeta = context.extensionGitMeta.get(folderName) || {};
    const homePage = gitMeta.remoteUrl
      || (typeof manifest.homePage === 'string' ? manifest.homePage.trim() : '');

    if (/^https:\/\//iu.test(homePage)) {
      output.set(`data/_tauritavern/extension-sources/global/${folderName}.json`, {
        remote_url: homePage,
        reference: gitMeta.branch || '',
        installed_commit: gitMeta.commit || '',
      });
    } else {
      report.warn(
        `扩展 "${folderName}" 无来源记录且 remoteUrl/homePage 非 https(${homePage || '空'}),`
        + '按 PT 规则它将在导入时被跳过,请在 PT 扩展面板重装。',
      );
    }
  }

  return new Map([...output.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

const JSON_DECODER = new TextDecoder();

/** Buffer/Uint8Array 通用的 JSON 解析(浏览器插件路径没有 Buffer)。 */
export function parseJsonSafe(data) {
  try {
    return JSON.parse(JSON_DECODER.decode(data));
  } catch {
    return null;
  }
}

const JSON_ENCODER = new TextEncoder();

/** 合成 JSON 条目统一走 TextEncoder,核心模块不依赖 node:buffer。 */
export function encodeJson(value) {
  return JSON_ENCODER.encode(JSON.stringify(value, null, 2));
}

export function encodeText(text) {
  return JSON_ENCODER.encode(text);
}
