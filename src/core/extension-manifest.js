/**
 * 扩展清单契约（Extension Manifest Contract）
 *
 * 存在原因：转换产物里有**两种**清单，此前语义散落在 `transform.js` 的合成块与
 * `host-bridge.js` 的恢复块中，导致「包内已有实体」「仅清单可在线安装」「无 URL 不可安装」
 * 三类状态在数据上不可区分（FULL 模式甚至完全不产清单）。
 *
 * 本模块把 schema 与状态判定收敛为**纯函数**，是唯一权威实现点：
 * - `transform.js` 生成端调用 `deriveExtensionEntry()` / `buildExtensionManifest()` / `buildOfficialIndex()`
 * - `host-bridge.js` 恢复端调用 `normalizeManifestEntries()` 归一包内清单
 *
 * 分层约束：本模块属 `src/core/`，**禁止 DOM 依赖**；亦不得导入 `src/ui/**`
 * （故 `isInstallableUrl` 在此自持实现，与 `src/ui/escape.js` 的 `isSafeHttpUrl` 同规则）。
 *
 * 字段语义与兼容策略见
 * `.trellis/tasks/09-23-extension-manifest-git/design.md` §2 / §5。
 */

/** 私有清单当前 schema 版本。缺省（v1）表示旧产物：仅 MANIFEST 模式、无状态字段。 */
export const MANIFEST_SCHEMA_VERSION = 2;

/** 条目的可安装性状态（由 `mode` + URL 派生，调用方不得传入）。 */
export const AVAILABILITY = Object.freeze({
  EMBEDDED: 'embedded',       // 包内已含扩展实体（FULL 模式）
  INSTALLABLE: 'installable', // 仅清单，但记录了可用的 Git URL，可在线安装
  UNAVAILABLE: 'unavailable', // 仅清单且无可用 URL，无法在线安装
});

/** URL 来源类型（由取值链位置派生，调用方不得传入）。 */
export const SOURCE_KIND = Object.freeze({
  GIT: 'git',           // 来自 .git/config 的 remote origin
  HOMEPAGE: 'homepage', // 来自 manifest.json 的 homePage
  UNKNOWN: 'unknown',   // 无任何 URL 线索
});

/**
 * 判断字符串是否为可在线安装的远程地址（仅 http / https）。
 *
 * 与 `src/ui/escape.js` 的 `isSafeHttpUrl` **同规则、同语义**；因核心层不得依赖 UI 层，
 * 此处独立实现。两处若需变更必须同步（回归由 `test/extension-manifest.test.js` 把关）。
 * @param {unknown} value 待校验值
 * @returns {boolean}
 */
export function isInstallableUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

/**
 * 从 `.git/config` 文本提取 origin 远程地址。
 * @param {string} configText
 * @returns {string|null}
 */
export function extractGitRemoteUrl(configText) {
  if (!configText) return null;
  const match = configText.match(/\[remote\s+["']origin["']\][\s\S]*?url\s*=\s*([^\r\n]+)/i)
    || configText.match(/url\s*=\s*([^\r\n]+)/i);
  return match ? match[1].trim() : null;
}

/**
 * 从 `.git/HEAD` 文本提取当前分支名。
 * @param {string} headText
 * @returns {string|null}
 */
export function extractGitBranch(headText) {
  if (!headText) return null;
  const match = headText.match(/ref:\s*refs\/heads\/([^\r\n]+)/i);
  return match ? match[1].trim() : null;
}

/**
 * 从 hub 路径取扩展目录名（`extensions/<name>/...` → `<name>`）。
 * @param {string} hubPath
 * @returns {string} 非 extensions/ 前缀时返回空串
 */
export function extensionFolderName(hubPath) {
  if (!hubPath.startsWith('extensions/')) return '';
  const rest = hubPath.slice('extensions/'.length);
  const slash = rest.indexOf('/');
  return slash > 0 ? rest.slice(0, slash) : rest;
}

/**
 * 从 hub 路径取扩展内相对路径（`extensions/<name>/a/b` → `a/b`）。
 * @param {string} hubPath
 * @returns {string} 非 extensions/ 前缀时返回空串
 */
export function extensionRelativePath(hubPath) {
  if (!hubPath.startsWith('extensions/')) return '';
  const rest = hubPath.slice('extensions/'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return rest;
  return rest.slice(slash + 1);
}

/**
 * 派生单个扩展清单条目。
 *
 * `sourceKind` / `availability` / `notes` **必须**由此函数从原始输入派生，
 * 不接受调用方传入——以此保证 FULL / MANIFEST 两条产出路径同源。
 * @param {object} params
 * @param {string} params.name 扩展目录名（稳定标识）
 * @param {object} [params.manifest] 解析后的 `manifest.json`（可为空对象）
 * @param {object} [params.gitMeta] `.git` 解析结果 `{ remoteUrl, branch, commit }`
 * @param {object} [params.sourceRecord] TT/PT 来源记录（`remote_url` / `reference` / `installed_commit`）
 * @param {string} params.mode `manifest` | `full`
 * @returns {object} 清单条目
 */
export function deriveExtensionEntry({ name, manifest = {}, gitMeta = {}, sourceRecord = {}, mode }) {
  const homePage = typeof manifest.homePage === 'string' ? manifest.homePage.trim() : '';

  // URL 取值链与来源类型同步判定（顺序即优先级，不得拆分）
  const fromGitRemote = typeof gitMeta.remoteUrl === 'string' ? gitMeta.remoteUrl.trim() : '';
  const fromSourceRecord = typeof sourceRecord.remote_url === 'string' ? sourceRecord.remote_url.trim() : '';
  let url = '';
  let sourceKind = SOURCE_KIND.UNKNOWN;
  if (fromGitRemote) {
    url = fromGitRemote;
    sourceKind = SOURCE_KIND.GIT;
  } else if (fromSourceRecord) {
    url = fromSourceRecord;
    sourceKind = SOURCE_KIND.GIT;
  } else if (homePage) {
    url = homePage;
    sourceKind = SOURCE_KIND.HOMEPAGE;
  }

  const installable = isInstallableUrl(url);
  let availability;
  if (mode === 'full') {
    availability = AVAILABILITY.EMBEDDED;
  } else {
    availability = installable ? AVAILABILITY.INSTALLABLE : AVAILABILITY.UNAVAILABLE;
  }

  const notes = [];
  if (availability === AVAILABILITY.UNAVAILABLE) {
    notes.push('清单未记录可用的 Git URL，无法在线安装；请手动获取该扩展。');
  }
  if (sourceKind === SOURCE_KIND.HOMEPAGE && installable) {
    notes.push('来源为扩展主页而非 Git 仓库，安装可能失败。');
  }

  const entry = {
    id: name,
    name,
    displayName: manifest.display_name || name,
    description: manifest.description || '',
    url,
    branch: gitMeta.branch || sourceRecord.reference || 'main',
    commit: gitMeta.commit || sourceRecord.installed_commit || '',
    version: manifest.version || '1.0.0',
    type: 'extension',
    sourceKind,
    availability,
    manifest,
  };
  if (notes.length > 0) entry.notes = notes.join(' ');

  return entry;
}

/**
 * 构建转换器私有清单（`_convert/extensions-manifest.json`）。
 *
 * FULL 与 MANIFEST **两种模式都产出**；条目状态由 `deriveExtensionEntry` 派生。
 * @param {object} params
 * @param {Array<object>} params.extensions 原始扩展输入数组（每项含 name/manifest/gitMeta/sourceRecord）
 * @param {string} params.mode `manifest` | `full`
 * @param {string} params.generatedAt 固定时间戳（保证产物字节可复现）
 * @returns {object} 私有清单对象
 */
export function buildExtensionManifest({ extensions, mode, generatedAt }) {
  const entries = extensions.map((ext) => deriveExtensionEntry({ ...ext, mode }));
  return {
    converter: 'st-zip-converter',
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt,
    mode,
    total: entries.length,
    extensions: entries,
  };
}

/**
 * 构建 SillyTavern 官方 Content Downloader 索引（`extensions-index.json`）。
 *
 * **仅 MANIFEST 模式产出**：该索引的语义是「按 URL 在线下载」，而 FULL 包内已有实体，
 * 宿主若按索引再装一遍会造成重复安装与潜在覆盖（决策 D-6，见 design.md §2.4）。
 *
 * 官方格式无「不可安装」语义，故 `unavailable` 条目**必须过滤掉**——写入空 URL 会让
 * 宿主的 Content Downloader 报错。
 * @param {Array<object>} extensions 清单条目数组（`deriveExtensionEntry` 的产物）
 * @returns {object|null} 官方索引对象；无可安装项时返回 null
 */
export function buildOfficialIndex(extensions) {
  const usable = extensions.filter(
    (ext) => ext.availability === AVAILABILITY.INSTALLABLE && isInstallableUrl(ext.url),
  );
  if (usable.length === 0) return null;
  return {
    extension: usable.map(({ id, displayName, name, description, url, branch, commit, type }) => ({
      id,
      name: displayName || name,
      description,
      url,
      branch,
      commit,
      type,
    })),
  };
}

/**
 * 归一包内清单条目（恢复端使用）。
 *
 * 兼容三种来源：
 * - v1 旧清单（无 `availability`）：按 `mode` 推断——MANIFEST 下有可用 URL 即可安装；
 * - 非法 `availability` 取值：回退到同一推断规则；
 * - URL 非 http(s)：**强制** `unavailable`（无论声明为何）。
 *
 * 同时兼容 FULL 模式的 v1 等价形态（无 mode 字段）：一律按「包内已有实体」处理，
 * 因为能读到实体的包才可能带有这些扩展。
 * @param {unknown} raw `JSON.parse` 后的清单对象
 * @returns {Array<object>} 归一后的条目数组；无法解析时返回空数组
 */
export function normalizeManifestEntries(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const list = Array.isArray(raw.extensions) ? raw.extensions : [];
  const mode = typeof raw.mode === 'string' ? raw.mode : 'manifest';

  return list
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const name = typeof item.name === 'string' && item.name
        ? item.name
        : (typeof item.id === 'string' ? item.id : '');
      const url = typeof item.url === 'string' ? item.url.trim() : '';
      const installable = isInstallableUrl(url);

      let availability = item.availability;
      const legal = Object.values(AVAILABILITY);
      if (!legal.includes(availability)) {
        // 旧版 / 非法值：按 mode 推断
        if (mode === 'full') availability = AVAILABILITY.EMBEDDED;
        else availability = installable ? AVAILABILITY.INSTALLABLE : AVAILABILITY.UNAVAILABLE;
      }
      // 强制规则：无可用 URL 就不可能在线安装
      if (availability !== AVAILABILITY.EMBEDDED && !installable) {
        availability = AVAILABILITY.UNAVAILABLE;
      }

      const sourceKind = Object.values(SOURCE_KIND).includes(item.sourceKind)
        ? item.sourceKind
        : (installable ? SOURCE_KIND.GIT : SOURCE_KIND.UNKNOWN);

      return {
        ...item,
        id: item.id || name,
        name,
        displayName: item.displayName || name,
        description: typeof item.description === 'string' ? item.description : '',
        url,
        branch: item.branch || 'main',
        commit: item.commit || '',
        type: item.type || 'extension',
        sourceKind,
        availability,
        notes: typeof item.notes === 'string' ? item.notes : '',
      };
    })
    .filter((item) => item.name);
}

/**
 * 判定恢复后是否需要自动弹出安装器。
 *
 * 只有存在**可在线安装**条目时才自动弹窗；全部为「包内已含」或「无法安装」时不打扰用户，
 * 仅提示并提供手动入口（决策 D-4，见 design.md §5.2）。
 * @param {Array<object>} entries `normalizeManifestEntries` 的产物
 * @returns {boolean}
 */
export function shouldAutoOpenInstaller(entries) {
  if (!Array.isArray(entries)) return false;
  return entries.some((ext) => ext.availability === AVAILABILITY.INSTALLABLE);
}
