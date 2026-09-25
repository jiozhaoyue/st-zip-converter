/**
 * 宿主 DOM 作用域守卫 (Host DOM Scope Guard)
 *
 * 目的：与 `scripts/css-scope.js` 互补。CSS 守卫管「样式不许越界」，本守卫管
 * **「往宿主 DOM 里写东西不许没交代」**——即：本插件对**宿主自有元素**的写入，
 * 必须是**显式声明并说明理由**的。
 *
 * 背景（2026-09-25 实测读数，见任务 research/`dom-writes-8003-verdict.json`）：
 * 整页 22425 次 DOM 写操作里本插件占 17 次——13 次写自己容器内，4 次写宿主元素
 * 且**全部落在声明锚点上**，改动宿主既有节点属性 0 次、删除 0 次。
 * 也就是说当前代码是干净的；本守卫的作用是**把"干净"锁住**，防止将来有人随手
 * `document.body.appendChild(...)` 或 `document.querySelector('#某宿主节点').appendChild(...)`。
 *
 * 判定规则（对 `src/ui/**` 与根 `index.js` 生效）：
 *   1. 写入对象是 `document.body` / `document.documentElement` / `document.head`
 *      → 需显式标记 `dom-scope:allow <理由>`；
 *   2. 写入对象是 `document.querySelector(...)` / `getElementById(...)` / `getElementsBy*` 直接链式调用
 *      → 其选择器字面量必须在 `ANCHOR_SELECTORS` 白名单内，否则需标记；
 *   3. 写入对象是其他任何 `document.*`
 *      → 需标记；
 *   4. 写入对象不是 `document` 起头（局部变量 / 自己 createElement 出来的节点）
 *      → 放行。这是**刻意的边界**：静态判断不出局部变量指向谁，
 *        真实归属由运行期仪器 `research/pw-dom-write-audit.cjs` 按调用栈归因来核
 *        （它带负例自检，能证明自己抓得到违规）。
 *   5. 显式豁免：语句所在行或其上一非空行含 `dom-scope:allow <理由>`；
 *      整文件豁免：文件含 `dom-scope:allow-file <理由>`。
 *
 * **已知盲区（如实记录，不假装覆盖）**：
 *   · 模板字面量**整体**被屏蔽（含 `${}` 内部），故 `${}` 里的写入调用扫不到；
 *   · 多行链式写法（`document\n  .body\n  .appendChild(x)`）只能识别第一段；
 *   · `el.style.x = y` 与 `classList` 打在谁身上，静态不可判——由运行期仪器负责。
 *
 * 退出码：0 = 通过；1 = 存在违规。
 *
 * 用法：`npm run check:dom-scope`
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ALLOW_MARKER = 'dom-scope:allow';
const ALLOW_FILE_MARKER = 'dom-scope:allow-file';

/** 会被判定为「写 DOM」的方法名 */
const WRITE_METHODS = ['appendChild', 'insertBefore', 'replaceChild', 'insertAdjacentHTML', 'prepend', 'append', 'after', 'before'];

/** 宿主全局写入目标：这三者永远属宿主，写它们必须有理由 */
const HOST_GLOBAL_TARGET = /^document\s*\.\s*(?:body|documentElement|head)$/;

/** 直接链式查询宿主节点再写 */
const HOST_QUERY_TARGET = /^document\s*\.\s*(?:querySelector|getElementById|getElementsByTagName|getElementsByClassName)\b/;

/**
 * 允许插件写入的宿主锚点（**穷举**，与运行期实测的 4 次宿主写入一一对应）。
 * 新增注入口时必须同时更新这里 + 运行期仪器的 ANCHORS，两处都不改就是漏审。
 */
const ANCHOR_SELECTORS = new Set([
  '#extensions_settings2',            // 扩展设置抽屉：工作台面板落点
  '#extensions_settings',             // 同上（旧版宿主 id）
  '#extensionsMenu',                  // 扩展菜单：入口项落点
  '#extensionsMenu .list-group',
  '#options',                         // 扩展菜单兜底容器
  '.userBackupButton',                // 账号弹层/管理面板按钮的锚点（按钮插在它旁边）
  '.userBackupManager .backupActionRow', // Luker 备份管理器动作行
]);

/**
 * 屏蔽注释与字符串**内容**（保留引号与全部换行，**偏移量与原文一一对应**）。
 *
 * 保留偏移是关键：结构判定在屏蔽后的文本上做，而**选择器字面量要回到原文里取**。
 * 模板字面量整体屏蔽（含 `${}`），这是已知盲区，见文件头。
 * @param {string} code 源码
 * @returns {string} 等长文本，注释/字符串内容被换成 `\u0000`（换行保留）
 */
export function maskCode(code) {
  const out = code.split('');
  const n = code.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k += 1) if (out[k] !== '\n') out[k] = '\u0000';
  };
  let i = 0;
  while (i < n) {
    const c = code[i];
    if (c === '/' && code[i + 1] === '/') {
      let j = i;
      while (j < n && code[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      const j = end === -1 ? n : end + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === c) { j += 1; break; }
        j += 1;
      }
      blank(i + 1, j - 1);
      i = j;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/**
 * 从 `dotIndex`（`.` 的位置）向前收集「写入对象」的成员链，返回 `[start, end]` 偏移区间。
 *
 * 返回**偏移**而不是字符串：判定要用屏蔽后的文本（不含字符串内容），
 * 而报错与选择器提取要用**原文**（可读、且含字面量）。两者偏移一一对应。
 */
function objectExprRange(masked, dotIndex) {
  let i = dotIndex - 1;
  while (i >= 0 && /\s/.test(masked[i])) i -= 1;
  const end = i;
  while (i >= 0) {
    const c = masked[i];
    if (/[\w$]/.test(c) || c === '.') { i -= 1; continue; }
    // 可选链：`document.body?.appendChild(x)` 的那枚 `?`。
    // 必须放行——否则整个写入的「对象」收集会在此处断掉，目标变成空串被跳过，
    // **守卫会静默漏掉可选链形式的宿主写入**（首版实测：`document.querySelector('#evil')?.appendChild(x)`
    // 报 0 违规）。只在紧跟 `.` 时放行，避免把三元的 `?` 也吞进来。
    if (c === '?' && masked[i + 1] === '.') { i -= 1; continue; }
    if (c === ')') {
      let depth = 0;
      let j = i;
      for (; j >= 0; j -= 1) {
        if (masked[j] === ')') depth += 1;
        else if (masked[j] === '(') { depth -= 1; if (depth === 0) break; }
      }
      if (j < 0) return null;
      i = j - 1;
      continue;
    }
    if (c === ']') {
      let depth = 0;
      let j = i;
      for (; j >= 0; j -= 1) {
        if (masked[j] === ']') depth += 1;
        else if (masked[j] === '[') { depth -= 1; if (depth === 0) break; }
      }
      if (j < 0) return null;
      i = j - 1;
      continue;
    }
    break;
  }
  let start = i + 1;
  let endAt = end;
  // 可选链留在区间末尾的 `?` 属「?.」的一部分，不属于对象表达式本身（否则 `document.body?`
  // 匹配不上 body 判定、白名单选择器也会被误报）
  while (endAt >= start && (masked[endAt] === '?' || /\s/.test(masked[endAt]))) endAt -= 1;
  while (start <= endAt && /\s/.test(masked[start])) start += 1;
  return start > endAt ? null : [start, endAt];
}

/** 取第一个实参的字面量选择器（从**原文**里取，因为屏蔽后内容已被清空） */
function firstStringArg(code, openParenIndex) {
  const m = /^\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/.exec(code.slice(openParenIndex + 1));
  return m ? m[2] : null;
}

function lineOf(code, index) {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i += 1) if (code[i] === '\n') line += 1;
  return line;
}

/** 语句所在行或上一非空行是否有 allow 标记 */
function hasAllowMarker(lines, line) {
  const same = lines[line - 1] || '';
  if (same.includes(ALLOW_MARKER)) return true;
  for (let i = line - 2; i >= 0; i -= 1) {
    if (!lines[i].trim()) continue;
    return lines[i].includes(ALLOW_MARKER);
  }
  return false;
}

/**
 * 检查一段源码的宿主 DOM 写入作用域。
 * @param {string} code 源码
 * @param {string} [file] 文件名（仅用于报错）
 * @returns {Array<{line:number, method:string, target:string, reason:string}>} 违规列表（空 = 通过）
 */
export function checkDomScope(code, file = '<inline>') {
  if (code.includes(ALLOW_FILE_MARKER)) return [];
  const masked = maskCode(code);
  const lines = code.split('\n');
  const violations = [];
  const re = new RegExp(`\\.(${WRITE_METHODS.join('|')})\\s*\\(`, 'g');

  let m;
  while ((m = re.exec(masked)) !== null) {
    const method = m[1];
    const dotIndex = m.index;
    const range = objectExprRange(masked, dotIndex);
    if (!range) continue;
    const target = code.slice(range[0], range[1] + 1).replace(/\s+/g, ' ').trim();
    const targetMasked = masked.slice(range[0], range[1] + 1).replace(/\s+/g, ' ').trim();
    const line = lineOf(code, dotIndex);

    let reason = null;
    if (HOST_GLOBAL_TARGET.test(targetMasked)) {
      reason = '直接写宿主 body/documentElement/head：宿主页面结构不属本插件，写入须显式说明理由';
    } else if (HOST_QUERY_TARGET.test(targetMasked)) {
      // 要取的是**对象表达式里** `querySelector(` 的括号 —— 它在 `m.index`（写入方法名的那个点）
      // **之前**，就在对象区间内。取第一个 `(` 即可（`document.querySelector(...)` 形态下无歧义）。
      // 两个错版本都栽在这里：`dotIndex + method.length + 1` 是写入方法的括号（在对象之后），
      // `m.index + m[0].length - 1` 同样是写入方法的括号 → 都取不到选择器字面量，
      // 于是白名单永远匹配不上、锚点检查形同虚设。是负例测试把它逼出来的。
      const objText = code.slice(range[0], range[1] + 1);
      const parenRel = objText.indexOf('(');
      const rawSelector = parenRel === -1 ? null : firstStringArg(code, range[0] + parenRel);
      // `getElementById` 的参数是 **id**，不是选择器：归一成 `#id` 再比白名单，
      // 否则同一句写成 getElementById 形态就会因「没带 #」被判违规（负例测试当场抓到）。
      const byId = /\.\s*getElementById\s*\(/.test(targetMasked);
      const selector = rawSelector === null ? null : (byId ? `#${rawSelector.trim()}` : rawSelector.trim());
      if (!selector || !ANCHOR_SELECTORS.has(selector)) {
        reason = `写入目标是宿主查询结果，选择器 ${rawSelector ? `"${rawSelector}"` : '(非字面量/未知)'} 不在锚点白名单内`;
      }
    } else if (/^document\b/.test(targetMasked)) {
      reason = `写入目标是 ${target}（宿主文档对象），不在锚点白名单内`;
    }

    if (reason && !hasAllowMarker(lines, line)) {
      violations.push({ line, method, target, reason });
    }
  }
  return violations.map((v) => ({ ...v, file }));
}

/** 收集待检查的源码文件（与 dom-injection-guard 同范围） */
async function collectFiles(root) {
  const files = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir); } catch { return; }
    for (const name of entries) {
      const full = path.join(dir, name);
      const info = await stat(full);
      if (info.isDirectory()) await walk(full);
      else if (name.endsWith('.js')) files.push(full);
    }
  }
  await walk(path.join(root, 'src', 'ui'));
  const rootIndex = path.join(root, 'index.js');
  try { await stat(rootIndex); files.push(rootIndex); } catch { /* 无根入口 */ }
  return files;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = await collectFiles(root);
  let failed = 0;
  for (const file of files) {
    const code = await readFile(file, 'utf8');
    const violations = checkDomScope(code, path.relative(root, file).split(path.sep).join('/'));
    for (const v of violations) {
      failed += 1;
      console.error(`✗ ${v.file}:${v.line}  ${v.method}(${v.target}) —— ${v.reason}`);
    }
  }
  if (failed > 0) {
    console.error(`\n宿主 DOM 作用域检查失败：${failed} 处违规`
      + `\n（确属必要者，在该语句行或上一行加注释 \`${ALLOW_MARKER} <理由>\`）`);
    process.exit(1);
  }
  console.log(`宿主 DOM 作用域检查通过：${files.length} 个文件，零未声明写入`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
