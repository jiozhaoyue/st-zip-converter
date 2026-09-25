import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_STANDALONE_IDS,
  REQUIRED_TEMPLATE_IDS,
  checkSingleTemplateSource,
} from '../scripts/single-template-source.js';

describe('单一模板源守卫', () => {
  const skeleton = `<!DOCTYPE html>
<html lang="zh-CN">
<body>
  <div class="app-container" id="app"></div>
  <script type="module" src="./index.js"></script>
</body>
</html>`;

  const fullTemplate = REQUIRED_TEMPLATE_IDS.map((id) => `<div id="${id}"></div>`).join('\n');

  it('允许 index.html 仅含骨架容器，且模板含全部业务节点', () => {
    const violations = checkSingleTemplateSource({ html: skeleton, template: fullTemplate });

    expect(violations).toEqual([]);
    expect(ALLOWED_STANDALONE_IDS.has('app')).toBe(true);
  });

  it.each([
    ['业务节点 id', '<div id="stash-list"></div>', 'stash-list', 1],
    ['业务控件 id', '<button id="btn-convert"></button>', 'btn-convert', 1],
    ['宿主原生类', '<button class="menu_button"></button>', 'menu_button', 1],
    ['折叠容器类', '<div class="inline-drawer"></div>', 'inline-drawer', 1],
  ])('当 index.html 出现%s时报告文件与行号', (_label, extra, id, expectedLineOffset) => {
    const html = `${skeleton}\n${extra}`;
    const violations = checkSingleTemplateSource({ html, template: fullTemplate });
    const target = violations.find((v) => v.id === id);

    expect(target).toBeDefined();
    expect(target.file).toBe('index.html');
    expect(target.line).toBeGreaterThanOrEqual(expectedLineOffset);
  });

  it('当模板缺失被 index.js 引用的节点时报告违规', () => {
    const template = fullTemplate.replace('<div id="stash-list"></div>', '');
    const violations = checkSingleTemplateSource({ html: skeleton, template });
    const target = violations.find((v) => v.id === 'stash-list');

    expect(target).toBeDefined();
    expect(target.file).toBe('src/ui/workbench-template.js');
    expect(target.message).toMatch(/缺少必需节点/);
  });

  it('仓库实况通过：index.html 为骨架，业务节点全部定义于模板', async () => {
    const [html, template] = await Promise.all([
      readFile(new URL('../index.html', import.meta.url), 'utf8'),
      readFile(new URL('../src/ui/workbench-template.js', import.meta.url), 'utf8'),
    ]);

    const violations = checkSingleTemplateSource({ html, template });

    expect(violations).toEqual([]);
    // 反向断言：曾经的旧版副本节点不得复活
    expect(html).not.toContain('workspace-panel');
    expect(html).not.toContain('host-export-card');
    expect(html).not.toContain('btn-clear-workspace');
  });
});
