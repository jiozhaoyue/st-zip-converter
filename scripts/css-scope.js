import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';

const STANDALONE_BODY = /^body:has\(\s*>\s*\.[a-z0-9-]+\s*\)(?:\s+.+)?$/;

function hasAllowedRoot(selector) {
  return /^(?:\.app-container|\.st-converter-drawer-app)(?=$|[\s>+~.#:[\]])/.test(selector);
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
      if (hasAllowedRoot(normalized) || STANDALONE_BODY.test(normalized)) continue;

      violations.push({
        file,
        line: rule.source?.start?.line ?? 1,
        column: rule.source?.start?.column ?? 1,
        selector: normalized,
        message: '选择器必须以 .app-container 或 .st-converter-drawer-app 为作用域根',
      });
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
