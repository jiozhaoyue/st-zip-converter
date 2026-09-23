import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { checkCssScope } from '../scripts/css-scope.js';

describe('CSS 宿主作用域守卫', () => {
  it('允许两个应用根容器及独立页面骨架选择器', () => {
    const css = `
.app-container, .st-converter-drawer-app .menu_button { color: red; }
body:has( > .app-container ) { display: flex; }
body:has(> .st-converter-modal-overlay) .app-container { max-width: 1080px; }
.app-container :is(.first, .second) { display: flex; }
`;

    expect(checkCssScope(css, 'fixture.css')).toEqual([]);
  });

  it.each([
    ['顶层裸选择器', '.menu_button { color: red; }', '.menu_button', 1],
    ['媒体查询中的裸选择器', '@media (max-width: 600px) { body { color: red; } }', 'body', 1],
    ['支持查询中的裸选择器', '@supports (display: grid) { :root { color: red; } }', ':root', 1],
    ['逗号列表中的裸选择器', '.app-container .safe, * { color: red; }', '*', 1],
    ['容器出现在非根位置', 'body .app-container { color: red; }', 'body .app-container', 1],
    ['相似但不同的根类名', '.app-container-evil { color: red; }', '.app-container-evil', 1],
    ['伪类函数逗号列表', '.app-container :is(.safe, .also-safe), body { color: red; }', 'body', 1],
    ['带额外裸分支的独立骨架规则', 'body:has(> .app-container), body { color: red; }', 'body', 1],
  ])('拒绝%s并报告文件位置与选择器', (_label, css, selector, line) => {
    const violations = checkCssScope(css, 'fixture.css');

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      file: 'fixture.css',
      line,
      column: expect.any(Number),
      selector,
    });
  });

  it('忽略 keyframes 帧规则，但不放过其外部裸选择器', () => {
    const css = `
@keyframes pulse { 0%, 50%, to { opacity: 1; } }
.app-container { color: red; }
`;

    expect(checkCssScope(css, 'fixture.css')).toEqual([]);
    expect(checkCssScope(`${css}\nbody { color: red; }`, 'fixture.css')).toHaveLength(1);
  });

  it('CSS 语法错误时提供文件及解析位置', () => {
    const violations = checkCssScope('.app-container { color: red;', 'broken.css');

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      file: 'broken.css',
      line: expect.any(Number),
      column: expect.any(Number),
    });
    expect(violations[0].message).toMatch(/解析/);
  });

  it('仓库样式通过检查且两种入口都具有对应的响应式规则', async () => {
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    const violations = checkCssScope(css, 'style.css');

    expect(violations).toEqual([]);
    expect(css).toMatch(/body:has\(> \.app-container\)\s*\{[^}]*padding: 8px 6px;/s);
    expect(css).toMatch(/\.app-container\s*\{[^}]*padding: 12px 10px;/s);
    expect(css).toContain('.app-container .app-header');
    expect(css).toContain('.st-converter-drawer-app .app-header');
  });
});
