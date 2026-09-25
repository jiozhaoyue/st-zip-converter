/**
 * 单一模板源守卫（L1-MR-10 单向化 · 2026-09-25）
 *
 * 背景：独立态 `index.html` 与插件态 `src/ui/workbench-template.js` 历史上是
 * 两份独立维护的 UI 副本，且**已实际分歧**——`index.html` 缺少 `#stash-list`、
 * `#stash-batch-bar`、`#task-controls`、`#btn-host-fetch`、`#log-console-mount`
 * 等节点，导致独立态功能静默缺失（2026-09-24 静态核对，2026-09-25 实测确认）。
 *
 * 现约定：`index.html` **仅为空骨架**，工作台内容由 `getWorkbenchHtml()` 唯一产出。
 * 本守卫断言两件事：
 *   1) `index.html` 不得再出现任何业务节点 id（除骨架容器 `app`）；
 *   2) `workbench-template.js` 必须含全部业务节点 id（防止误删导致绑定失联）。
 *
 * 违规时退出码 1，输出 `文件:行号`（沿用 css-scope.js / dom-injection-guard.js 约定）。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** index.html 允许出现的 id（仅骨架容器） */
export const ALLOWED_STANDALONE_IDS = new Set(['app']);

/** index.html 不得出现的业务 class（防以 class 形态复活第二份副本） */
const FORBIDDEN_STANDALONE_CLASSES = ['menu_button', 'inline-drawer', 'text_pole', 'checkbox_label'];

/**
 * 必须由模板产出的业务节点 id
 * 来源：`index.js` 的 `getElementById()` 静态引用集，排除运行时动态创建者
 * （`app` 由骨架提供；`host-selection-mode-hint`、`st-converter-modal-overlay`
 * 由 `index.js` 运行时 `createElement` 创建）。
 */
export const REQUIRED_TEMPLATE_IDS = [
  'btn-cancel-restore',
  'btn-confirm-restore',
  'btn-convert',
  'btn-export-ext-manifest',
  'btn-host-fetch',
  'btn-host-tree-cancel',
  'btn-host-tree-confirm',
  'btn-host-tree-selectall',
  'btn-restore-luker',
  'btn-select-base-zip',
  'category-panel',
  'compression-select',
  'drop-main-text',
  'drop-sub-text',
  'dropzone',
  'env-badge',
  'export-queue-panel',
  'file-input',
  'filename-preview',
  'filename-template-input',
  'host-base-archive-select',
  'host-base-zip-input',
  'host-base-zip-section',
  'host-base-zip-status',
  'host-incremental-export',
  'host-tree-confirm-bar',
  'host-user-badge',
  'include-backups-check',
  'include-cache-check',
  'include-private-check',
  'incremental-mode-check',
  'keep-dev-files-check',
  'log-console-mount',
  'prune-builtin-check',
  'restore-modal-desc',
  'restore-modal-overlay',
  'split-input',
  'stash-batch-bar',
  'stash-list',
  'target-select',
  'usage-dashboard',
];

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/**
 * 校验单一模板源约束
 * @param {{html: string, template: string, htmlFile?: string, templateFile?: string}} input
 * @returns {Array<{file: string, line: number, id: string, message: string}>}
 */
export function checkSingleTemplateSource({ html, template, htmlFile = 'index.html', templateFile = 'src/ui/workbench-template.js' }) {
  const violations = [];

  // 1) index.html 不得持有业务节点 id
  for (const match of html.matchAll(/id="([^"]+)"/g)) {
    const id = match[1];
    if (!ALLOWED_STANDALONE_IDS.has(id)) {
      violations.push({
        file: htmlFile,
        line: lineOf(html, match.index),
        id,
        message: `index.html 不得持有业务节点 id（单一模板源：业务节点只允许出现在模板中）`,
      });
    }
  }

  // 1b) index.html 不得持有业务 class
  for (const cls of FORBIDDEN_STANDALONE_CLASSES) {
    let cursor = 0;
    for (;;) {
      const at = html.indexOf(cls, cursor);
      if (at === -1) break;
      violations.push({
        file: htmlFile,
        line: lineOf(html, at),
        id: cls,
        message: `index.html 不得使用业务 class "${cls}"（业务标记只允许出现在模板中）`,
      });
      cursor = at + cls.length;
    }
  }

  // 2) 模板必须含全部业务节点 id
  for (const id of REQUIRED_TEMPLATE_IDS) {
    if (!template.includes(`id="${id}"`)) {
      violations.push({
        file: templateFile,
        line: 1,
        id,
        message: `模板缺少必需节点 id="${id}"（index.js 会引用它，缺失将导致绑定失联）`,
      });
    }
  }

  return violations;
}

async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const htmlFile = 'index.html';
  const templateFile = 'src/ui/workbench-template.js';

  const [html, template] = await Promise.all([
    readFile(`${root}${htmlFile}`, 'utf8'),
    readFile(`${root}${templateFile}`, 'utf8'),
  ]);

  const violations = checkSingleTemplateSource({ html, template, htmlFile, templateFile });

  if (violations.length) {
    for (const item of violations) {
      console.error(`${item.file}:${item.line}: [${item.id}] ${item.message}`);
    }
    console.error(`\n单一模板源守卫未通过：${violations.length} 处违规`);
    process.exitCode = 1;
    return;
  }

  console.log(`单一模板源守卫通过：index.html 为骨架，${REQUIRED_TEMPLATE_IDS.length} 个业务节点均定义于 ${templateFile}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
