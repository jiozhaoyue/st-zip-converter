/**
 * 导出文件名模板解析器
 * 支持动态占位符替换，防呆清理与非法字符过滤。
 */

export const DEFAULT_FILENAME_TEMPLATE = '{source}-to-{target}-{date}.zip';

export const FILENAME_PRESETS = Object.freeze({
  SPLIT: '{target}_{user}_{part}_{date}.zip',
  CORE: '{target}_core_{user}_{date}.zip',
  FULL: '{target}_full_{user}_{date}.zip',
});

/**
 * 清理文件名中的非法字符 (Windows / Unix 跨系统安全)
 * @param {string} str
 * @returns {string}
 */
export function sanitizeFilename(str) {
  return (str || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 180);
}

/**
 * 格式化默认日期字符串 (YYYY-MM-DD)
 * @param {Date} [d]
 * @returns {string}
 */
export function formatDate(d = new Date()) {
  const dateObj = d instanceof Date ? d : new Date();
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 根据模板与上下文参数生成合法安全的 zip 导出文件名
 * @param {string} template 用户输入或默认模板
 * @param {object} context
 * @param {string} [context.sourceName] 源数据包文件名
 * @param {string} [context.target] 目标平台代码 (st|l|tt|pt)
 * @param {string} [context.handle] 用户标识
 * @param {string} [context.part] 分卷标识 (如 'part1', 'part1_core')
 * @param {string} [context.category] 类目标识 (如 'core', 'assets', 'all')
 * @param {string} [context.mode] 打包模式 (如 'full', 'inc', 'manifest', 'split')
 * @param {string} [context.date] 自定义日期字符串
 * @returns {string}
 */
export function resolveFilename(template, {
  sourceName,
  target,
  handle = 'default-user',
  part = 'part1',
  category = 'all',
  mode = 'full',
  date,
} = {}) {
  const tpl = (template && template.trim()) ? template.trim() : DEFAULT_FILENAME_TEMPLATE;

  const cleanSource = (sourceName || 'archive')
    .replace(/\.zip$/i, '')
    .trim();

  const formattedDate = date || formatDate();
  const targetCode = (target || 'backup').toLowerCase();
  const userHandle = (handle && handle.trim()) ? handle.trim() : 'default-user';
  const partCode = part || 'part1';
  const catCode = category || 'all';
  const modeCode = mode || 'full';

  let resolved = tpl
    // 分包标识: {part}, {partindex}, {volume}
    .replace(/\{(part|partindex|volume)\}/gi, () => partCode)
    // 资产类目: {category}, {cat}, {content}
    .replace(/\{(category|cat|content)\}/gi, () => catCode)
    // 打包模式: {mode}
    .replace(/\{(mode)\}/gi, () => modeCode)
    // 源名称及其别名: {source}, {sourceName}, {name}, {filename}
    .replace(/\{(source|sourcename|name|filename)\}/gi, () => cleanSource)
    // 目标代码及其别名: {target}, {platform}, {layout}
    .replace(/\{(target|platform|layout)\}/gi, () => targetCode)
    // 用户身份及其别名: {handle}, {user}, {username}
    .replace(/\{(handle|user|username)\}/gi, () => userHandle)
    // 时间戳及其别名: {date}, {datetime}, {time}, {timestamp}
    .replace(/\{(date|datetime|time|timestamp)\}/gi, () => formattedDate);

  resolved = sanitizeFilename(resolved);

  if (!resolved.toLowerCase().endsWith('.zip')) {
    resolved += '.zip';
  }

  return resolved;
}

/**
 * 获取实时预览文件名（与 resolveFilename 一致，专门用于 UI 动态展示）
 * @param {string} template
 * @param {object} context
 * @returns {string}
 */
export function previewFilename(template, context = {}) {
  return resolveFilename(template, context);
}
