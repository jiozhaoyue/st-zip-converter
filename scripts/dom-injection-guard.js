/**
 * DOM 注入守卫 (DOM Injection Guard)
 *
 * 目的：阻止「用户可控数据未经转义进入 `innerHTML` / `outerHTML` / `insertAdjacentHTML`」
 * 这类注入面复发。与 `scripts/css-scope.js` 同构（同样的 CLI 约定与退出码语义）。
 *
 * 判定规则（对 `src/ui/**` 与根 `index.js` 生效）：
 *   1. `.innerHTML = ''` / `""` / 空模板（清空动作）→ 放行；
 *   2. 模板字面量中每个 `${...}` 插值都必须以 `escapeHtml(` 或 `trustedStaticMarkup(` 开头
 *      → 否则报错；
 *   3. 右值为**变量/表达式**（无法静态确认）→ 报错，要求内联模板、显式包裹
 *      `trustedStaticMarkup(...)`，或加 `dom-injection-guard:allow` 注释；
 *   4. 显式豁免：语句所在行或其上一行含 `dom-injection-guard:allow <理由>` 注释；
 *   5. 整文件豁免：文件含 `dom-injection-guard:allow-file <理由>`（用于死代码等）。
 *
 * 退出码：0 = 通过；1 = 存在违规。
 *
 * 用法：`npm run check:dom-injection`
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ALLOW_MARKER = 'dom-injection-guard:allow';
const ALLOW_FILE_MARKER = 'dom-injection-guard:allow-file';
const ESCAPE_CALL = /^(?:escapeHtml|trustedStaticMarkup)\s*\(/;
const ASSIGN_RE = /(?:^|[^.\w])(?:[\w$]+\.)*(innerHTML|outerHTML)\s*(\+?=)/g;
const INSERT_ADJACENT_RE = /insertAdjacentHTML\s*\(/g;

/** 空白字符判断 */
function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/** 从 `start`（反引号位置）向前扫描，返回模板字面量结束位置（含） */
function findTemplateEnd(code, start) {
  let i = start + 1;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') return i;
    if (ch === '$' && code[i + 1] === '{') {
      i = findInterpolationEnd(code, i + 1);
      continue;
    }
    i += 1;
  }
  return code.length - 1;
}

/** 从 `braceIndex`（'{' 位置）向前扫描到配对的 '}'，返回其位置 */
function findInterpolationEnd(code, braceIndex) {
  let depth = 0;
  let i = braceIndex;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '`') {
      i = findTemplateEnd(code, i);
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return code.length - 1;
}

/** 提取模板字面量（起止为反引号位置）中的全部 `${...}` 表达式 */
function extractInterpolations(code, tplStart, tplEnd) {
  const out = [];
  let i = tplStart + 1;
  while (i < tplEnd) {
    const ch = code[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') {
      i = findTemplateEnd(code, i) + 1;
      continue;
    }
    if (ch === '$' && code[i + 1] === '{') {
      const end = findInterpolationEnd(code, i + 1);
      out.push({ text: code.slice(i + 2, end), index: i });
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

/** 行号计算（1 基） */
function lineOf(code, index) {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i += 1) {
    if (code[i] === '\n') line += 1;
  }
  return line;
}

/** 该位置的前一行或本行是否带显式豁免注释 */
function hasAllowMarker(code, index) {
  const line = lineOf(code, index);
  const lines = code.split('\n');
  return Boolean(
    lines[line - 1]?.includes(ALLOW_MARKER) || lines[line - 2]?.includes(ALLOW_MARKER),
  );
}

/**
 * 校验一段 JS 源码的 DOM 注入面
 * @param {string} code 源码
 * @param {string} [file] 文件名（用于报错）
 * @returns {Array<{file:string,line:number,kind:string,message:string}>} 违规列表
 */
export function checkDomInjection(code, file = '<js>') {
  const violations = [];
  const push = (index, kind, message) => {
    if (hasAllowMarker(code, index)) return;
    violations.push({ file, line: lineOf(code, index), kind, message });
  };

  const inspectRhs = (rhsIndex) => {
    let i = rhsIndex;
    while (i < code.length && isSpace(code[i])) i += 1;
    const ch = code[i];

    if (ch === '`') {
      const end = findTemplateEnd(code, i);
      for (const item of extractInterpolations(code, i, end)) {
        if (!ESCAPE_CALL.test(item.text.trim())) {
          push(i, 'interpolation', `模板插值未转义：\${${item.text.trim()}} —— 请改为 \${escapeHtml(${item.text.trim()})}`);
        }
      }
      return;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < code.length && code[j] !== quote) {
        if (code[j] === '\\') j += 1;
        j += 1;
      }
      // 字符串字面量无法插值，天生安全
      void j;
      return;
    }

    // 右值已被显式包裹为「已转义 / 已标注可信」—— 视为已处理
    if (ESCAPE_CALL.test(code.slice(i))) return;

    push(i, 'opaque-rhs', `右值无法静态确认（${code.slice(i, i + 24).split('\n')[0]}...）—— 请内联模板并包 escapeHtml，或包 trustedStaticMarkup(...)，或加 ${ALLOW_MARKER} 注释`);
  };

  for (const m of code.matchAll(ASSIGN_RE)) {
    inspectRhs(m.index + m[0].length);
  }

  for (const m of code.matchAll(INSERT_ADJACENT_RE)) {
    // 跳过第一个参数（位置字面量），检查第二个参数
    let i = m.index + m[0].length;
    let depth = 0;
    let commaSeen = false;
    while (i < code.length) {
      const ch = code[i];
      if (ch === '(' || ch === '[') depth += 1;
      else if (ch === ')' || ch === ']') {
        if (depth === 0) break;
        depth -= 1;
      } else if (ch === ',' && depth === 0) {
        commaSeen = true;
        break;
      } else if (ch === "'" || ch === '"') {
        const quote = ch;
        i += 1;
        while (i < code.length && code[i] !== quote) {
          if (code[i] === '\\') i += 1;
          i += 1;
        }
      }
      i += 1;
    }
    if (commaSeen) inspectRhs(i + 1);
  }

  return violations;
}

/** 递归收集待扫描的 JS 文件 */
async function collectFiles(target) {
  const info = await stat(target);
  if (info.isFile()) return [target];
  const entries = await readdir(target, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(full)));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const args = process.argv.slice(2);
  // 可选：显式传入扫描目标（供测试对合成样本断言退出码 1）
  const targets = args.length
    ? args.map((p) => path.resolve(p))
    : [path.join(root, 'src', 'ui'), path.join(root, 'index.js')];

  const files = [];
  for (const target of targets) {
    try {
      files.push(...(await collectFiles(target)));
    } catch {
      // 目标不存在则跳过（容错）
    }
  }

  const violations = [];
  const skipped = [];
  for (const file of files) {
    const code = await readFile(file, 'utf8');
    const relative = path.relative(root, file).replace(/\\/g, '/');
    if (code.includes(ALLOW_FILE_MARKER)) {
      skipped.push(relative);
      continue;
    }
    violations.push(...checkDomInjection(code, relative));
  }

  if (violations.length) {
    for (const item of violations) {
      console.error(`${item.file}:${item.line}: [${item.kind}] ${item.message}`);
    }
    console.error(`\nDOM 注入守卫未通过：${violations.length} 处违规（扫描 ${files.length} 个文件）`);
    process.exitCode = 1;
    return;
  }

  const suffix = skipped.length ? `，整文件豁免 ${skipped.length} 个（${skipped.join(', ')}）` : '';
  console.log(`DOM 注入守卫通过：${files.length} 个文件无未转义 innerHTML 插值${suffix}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
