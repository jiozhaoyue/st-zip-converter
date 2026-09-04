import { NullZipWriter } from './null-writer.js';
import { Report } from './report.js';
import { detectFromReader, LAYOUTS } from './detect.js';
import { zipIo } from './zip-io.js';
import { categoryOfHubPath } from './inspect.js';

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
export async function convert(sourcePath, targetPath, { target, keepAll = false, dryRun = false, io = zipIo, onProgress, selection } = {}) {
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
  const writer = dryRun ? new NullZipWriter() : await io.createWriter(targetPath);
  const totalEntries = reader.totalEntries ?? 0;
  let processedEntries = 0;

  const context = {
    manifest: null,
    extensionSources: new Map(), // folderName -> {scope, fileName, record}
    extensionManifests: new Map(), // folderName -> parsed manifest object
    sawEngineDump: false,
    userExtensionsMigrated: 0, // PT 目标:迁移为 third-party 布局的用户级扩展条目数
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

      // 按用户类目选择过滤（脱敏排除）
      if (selection && typeof selection === 'object') {
        const cat = categoryOfHubPath(routed.hubPath);
        if (cat && selection[cat] === false) {
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
        if (keepAll) {
          const outPath = (target === TARGETS.TT || target === TARGETS.PT)
            ? entry.fileName
            : routed.hubPath;
          if (!dryRun) writer.addLazy(outPath, lazyOpen(entry));
          report.copied(routed.hubPath, entry.uncompressedSize);
        } else {
          entry.skip();
          report.dropped(routed.hubPath, 'TT 私有/缓存,目标平台不消费(--keep-all 可保留)');
        }
        continue;
      }
      if (routed.kind === 'tt-app-private') {
        // TT 应用级私有设置:TT 目标原位保留,其余目标丢弃(keep-all 保留在 hub 根)
        if (target === TARGETS.TT || keepAll) {
          const outPath = target === TARGETS.TT ? entry.fileName : routed.hubPath;
          if (!dryRun) writer.addLazy(outPath, lazyOpen(entry));
          report.copied(routed.hubPath, entry.uncompressedSize);
        } else {
          entry.skip();
          report.dropped(routed.hubPath, 'TT 应用私有设置,仅 TT 目标有意义(--keep-all 可保留)');
        }
        continue;
      }
      if (routed.kind === 'user' && DERIVED_DIRS.some((dir) => routed.hubPath.startsWith(dir))) {
        routed = { kind: 'derived', hubPath: routed.hubPath };
      }
      if (routed.kind === 'derived') {
        if (keepAll) {
          if (!dryRun) writer.addLazy(targetEntryPath(routed.hubPath, target), lazyOpen(entry));
          report.copied(routed.hubPath, entry.uncompressedSize);
        } else {
          entry.skip();
          report.dropped(routed.hubPath, '派生缓存,平台按需重建(--keep-all 可保留)');
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

      // PT 目标:用户级扩展迁移为 third-party 布局(PT 目录表没有 extensions/,
      // 原样放 default-user/extensions 会被 PT 整体丢弃);与 third-party 同名时保留第三方副本。
      if (routed.kind === 'user' && target === TARGETS.PT
        && routed.hubPath.startsWith(USER_EXTENSIONS_PREFIX)
        && !routed.hubPath.startsWith(THIRD_PARTY_PREFIX)) {
        const rest = routed.hubPath.slice(USER_EXTENSIONS_PREFIX.length);
        const slash = rest.indexOf('/');
        if (slash > 0) {
          const name = rest.slice(0, slash);
          if (thirdPartyFolders.has(name)) {
            context.userExtensionCollisions.add(name);
            entry.skip();
            report.dropped(routed.hubPath, '与 third-party 扩展 "' + name + '" 同名,保留第三方副本');
            continue;
          }
          const migratedHub = THIRD_PARTY_PREFIX + rest;
          const outPath = 'data/extensions/third-party/' + rest;
          if (rest === name + '/manifest.json') {
            const data = await entry.read();
            noteExtensionPackage(context, migratedHub, data);
            await writer.add(outPath, data);
          } else {
            if (!dryRun) writer.addLazy(outPath, lazyOpen(entry));
          }
          context.userExtensionsMigrated += 1;
          report.copied(routed.hubPath, entry.uncompressedSize);
          continue;
        }
      }

      // user / extension-pkg:流式直通,只有扩展 manifest 需要读内容(小文件)
      const outPath = targetEntryPath(routed.hubPath, target);
      if (routed.kind === 'extension-pkg') {
        const fromTpRoot = routed.hubPath.slice(THIRD_PARTY_PREFIX.length);
        if ((target === TARGETS.TT || target === TARGETS.PT) && !fromTpRoot.includes('/')) {
          // third-party 根下的散文件(如 .gitkeep):TT/PT 只消费 目录名/文件 形态
          entry.skip();
          report.dropped(routed.hubPath, 'third-party 根下的散文件,目标平台不消费');
          continue;
        }
        if (extensionRelativePath(routed.hubPath) === 'manifest.json') {
          const data = await entry.read();
          noteExtensionPackage(context, routed.hubPath, data);
          await writer.add(outPath, data);
          report.copied(routed.hubPath, entry.uncompressedSize);
          continue;
        }
      }
      if (!dryRun) writer.addLazy(outPath, lazyOpen(entry));
      report.copied(routed.hubPath, entry.uncompressedSize);
    }

    await emitSynthesized(writer, report, context, target, selection);
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
function routeSource(sourcePath, layout) {
  if (layout === LAYOUTS.TT) {
    if (sourcePath.startsWith(TT_USER_PREFIX)) {
      const hubPath = sourcePath.slice(TT_USER_PREFIX.length);
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
      return { kind: 'extension-pkg', hubPath: `${THIRD_PARTY_PREFIX}${rest}` };
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

  // st / l:摊平布局
  if (sourcePath === 'manifest.json') {
    return { kind: 'manifest', hubPath: 'manifest.json' };
  }
  if (ENGINE_DUMP_ENTRIES.includes(sourcePath)) {
    return { kind: 'engine-dump', hubPath: sourcePath };
  }
  if (sourcePath.startsWith(THIRD_PARTY_PREFIX)) {
    return { kind: 'extension-pkg', hubPath: sourcePath };
  }
  return { kind: 'user', hubPath: sourcePath };
}

/** hub 路径 → 目标平台上的最终条目路径。 */
function targetEntryPath(hubPath, target) {
  if (target === TARGETS.TT || target === TARGETS.PT) {
    if (hubPath.startsWith(THIRD_PARTY_PREFIX)) {
      return `data/extensions/third-party/${hubPath.slice(THIRD_PARTY_PREFIX.length)}`;
    }
    return `data/default-user/${hubPath}`;
  }
  return hubPath;
}

/** 预扫用:路径若属于 third-party 扩展包,返回目录名(st/l 与 TT 两种布局都认)。 */
function thirdPartyFolderOf(sourcePath, layout) {
  const prefixes = layout === LAYOUTS.TT ? [TT_THIRD_PARTY_PREFIX] : [THIRD_PARTY_PREFIX];
  for (const prefix of prefixes) {
    if (!sourcePath.startsWith(prefix)) continue;
    const rest = sourcePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash > 0) return rest.slice(0, slash);
  }
  return null;
}

function extensionRelativePath(hubPath) {
  const rest = hubPath.slice(THIRD_PARTY_PREFIX.length);
  return rest.slice(rest.indexOf('/') + 1);
}

function noteExtensionPackage(context, hubPath, data) {
  const rest = hubPath.slice(THIRD_PARTY_PREFIX.length);
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
 * 尾部合成条目:目标 manifest(L)、extension-sources(pt/tt)、ST 安装说明。
 */
async function emitSynthesized(writer, report, context, target, selection) {
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

  if (target === TARGETS.PT && context.userExtensionsMigrated > 0) {
    report.warn(
      `已将 ${context.userExtensionsMigrated} 个用户级 extensions/** 条目迁移为 third-party 布局`
      + '(PT 目录表没有 extensions/,原样放置会被 PT 丢弃);'
      + '来源记录取自各扩展 manifest 的 homePage。',
    );
  }
  if (target === TARGETS.PT && context.userExtensionCollisions.size > 0) {
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
 * - 没有记录 → 从扩展 manifest 的 homePage 合成(reference/installed_commit 置空,
 *   PT 的 readExtensionSource 允许;非 https 的 homePage 视为无来源并警告,与 PT 对齐)
 */
function buildExtensionSources(context, report) {
  const output = new Map();

  for (const { scope, fileName, record } of context.extensionSources.values()) {
    if (record) output.set(`data/_tauritavern/extension-sources/${scope}/${fileName}`, record);
  }

  for (const [folderName, manifest] of context.extensionManifests) {
    if (context.extensionSources.has(folderName)) continue;
    const homePage = typeof manifest.homePage === 'string' ? manifest.homePage.trim() : '';
    if (/^https:\/\//iu.test(homePage)) {
      output.set(`data/_tauritavern/extension-sources/global/${folderName}.json`, {
        remote_url: homePage,
        reference: '',
        installed_commit: '',
      });
    } else {
      report.warn(
        `扩展 "${folderName}" 无来源记录且 manifest.homePage 非 https(${homePage || '空'}),`
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
