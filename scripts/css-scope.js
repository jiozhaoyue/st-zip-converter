import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';

/**
 * 允许作为**作用域根**（第一个复合选择器）的选择器：本插件自有容器 / 覆盖层。
 *
 * 2026-09-25 变更（两处，均有实机/合成页证据）：
 * 1. **新增 `#st-converter-modal-overlay`**（模态态工作台的自家覆盖层）。
 * 2. **独立态/模态态根由 `.app-container` 收紧为 `#app.app-container`**：只用类名时，
 *    任何第三方只要挂了 `.app-container` 就会被本插件的列宽/间距与后代规则命中
 *    （合成页实测：第三方容器被压成 840px 列）。本插件自己的两处根
 *    （`index.html` 骨架、`index.js` 模态容器）**都带 `id="app"`**，故以 id + 类双条件限定。
 * 3. **移除**原 `body:has(> .app-container)` 豁免——那条豁免允许以 `body` 为主体的规则，
 *    而 `body` 属宿主页面元素（宿主仓内确有第三方扩展使用 `.app-container` 类名）。
 */
const ALLOWED_ROOTS = [
  /^#app\.app-container(?=$|[\s>+~.#:[\]])/,
  /^\.st-converter-drawer-app(?=$|[\s>+~.#:[\]])/,
  /^#st-converter-modal-overlay(?=$|[\s>+~.#:[\]])/,
];

/**
 * 全局元素作**主体**：`body`/`html`/`:root` 永远不可能位于本插件容器内部，出现即外泄面。
 * （`*` 不列入：`.app-container *` 这种「容器内通配」是安全且必要的；
 *   裸 `* { … }` 会被下面的「作用域根」检查拦下。）
 */
const GLOBAL_SUBJECT = /^(?:body|html)(?=$|[\s>+~.#:[\]])|^:root(?=$|[\s>+~.#:[\]])/;

/** 取选择器的「主体」＝ 最后一个顶层复合选择器（逗号已在外层切分） */
function subjectOf(selector) {
  let depth = 0;
  let quote = null;
  let start = 0;

  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    else if (depth === 0 && (char === ' ' || char === '>' || char === '+' || char === '~')) start = index + 1;
  }

  return selector.slice(start).trim();
}

function hasAllowedRoot(selector) {
  return ALLOWED_ROOTS.some((pattern) => pattern.test(selector));
}

function splitSelectors(selector) {
  const selectors = [];
  let start = 0;
  let depth = 0;
  let quote = null;

  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    else if (char === ',' && depth === 0) {
      selectors.push(selector.slice(start, index).trim());
      start = index + 1;
    }
  }

  selectors.push(selector.slice(start).trim());
  return selectors;
}

function insideKeyframes(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'atrule' && /keyframes$/i.test(parent.name)) return true;
  }
  return false;
}

export function checkCssScope(css, file = '<css>') {
  const violations = [];
  let root;

  try {
    root = postcss.parse(css, { from: file });
  } catch (error) {
    violations.push({
      file,
      line: error.line ?? 1,
      column: error.column ?? 1,
      selector: '<CSS 语法>',
      message: `解析失败：${error.reason ?? error.message}`,
    });
    return violations;
  }

  root.walkRules((rule) => {
    if (insideKeyframes(rule)) return;

    for (const selector of splitSelectors(rule.selector)) {
      const normalized = selector.trim();
      if (!normalized) continue;

      // ① 主体不得是全局元素（会落到宿主页面）
      const subject = subjectOf(normalized);
      if (GLOBAL_SUBJECT.test(subject)) {
        violations.push({
          file,
          line: rule.source?.start?.line ?? 1,
          column: rule.source?.start?.column ?? 1,
          selector: normalized,
          message: '样式主体不得是 body/html/:root/*（本文件与插件态共用，会落到宿主页面）',
        });
        continue;
      }

      // ② 作用域根必须是本插件自有容器
      if (!hasAllowedRoot(normalized)) {
        violations.push({
          file,
          line: rule.source?.start?.line ?? 1,
          column: rule.source?.start?.column ?? 1,
          selector: normalized,
          message: '选择器必须以 .app-container / .st-converter-drawer-app / #st-converter-modal-overlay 为作用域根',
        });
      }
    }
  });

  return violations;
}

async function main() {
  const file = fileURLToPath(new URL('../style.css', import.meta.url));
  const css = await readFile(file, 'utf8');
  const violations = checkCssScope(css, 'style.css');

  if (violations.length) {
    for (const item of violations) {
      console.error(`${item.file}:${item.line}:${item.column}: ${item.selector} - ${item.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('CSS 作用域检查通过：style.css');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
