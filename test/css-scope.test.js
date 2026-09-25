import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { checkCssScope } from '../scripts/css-scope.js';

describe('CSS 宿主作用域守卫', () => {
  it('允许本插件自有根容器（含独立态 marker 与模态覆盖层）', () => {
    const css = `
#app.app-container, .st-converter-drawer-app .menu_button { color: red; }
#app.app-container.app-standalone { padding: 20px 12px; }
#app.app-container.app-standalone::before { content: ""; }
#st-converter-modal-overlay #app.app-container { max-width: 1080px; }
#app.app-container * { box-sizing: border-box; }
#app.app-container :is(.first, .second) { display: flex; }
`;

    expect(checkCssScope(css, 'fixture.css')).toEqual([]);
  });

  it('拒绝裸 .app-container（第三方可能挂同名类，必须 id + 类双条件）', () => {
    const violations = checkCssScope('.app-container { max-width: 840px; }', 'fixture.css');

    expect(violations).toHaveLength(1);
    expect(violations[0].selector).toBe('.app-container');
  });

  it.each([
    ['顶层裸选择器', '.menu_button { color: red; }', '.menu_button', 1],
    ['媒体查询中的裸选择器', '@media (max-width: 600px) { body { color: red; } }', 'body', 1],
    ['支持查询中的裸选择器', '@supports (display: grid) { :root { color: red; } }', ':root', 1],
    ['逗号列表中的裸选择器', '#app.app-container .safe, * { color: red; }', '*', 1],
    ['容器出现在非根位置', 'body .app-container { color: red; }', 'body .app-container', 1],
    ['html 前缀', 'html body #app.app-container { color: red; }', 'html body #app.app-container', 1],
    ['相似但不同的根类名', '.app-container-evil { color: red; }', '.app-container-evil', 1],
    ['伪类函数逗号列表', '#app.app-container :is(.safe, .also-safe), body { color: red; }', 'body', 1],
    ['独立骨架以 body 为主体', 'body:has(> .app-container) { color: red; }', 'body:has(> .app-container)', 1],
    [
      'body 作门控的模态规则',
      'body:has(> .st-converter-modal-overlay) .app-container { max-width: 1080px; }',
      'body:has(> .st-converter-modal-overlay) .app-container',
      1,
    ],
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
#app.app-container { color: red; }
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

  it('一条规则内的多个裸分支各报一条', () => {
    const violations = checkCssScope('body:has(> .app-container), body { color: red; }', 'fixture.css');

    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.selector)).toEqual(['body:has(> .app-container)', 'body']);
  });

  it('仓库样式通过检查，且已不再出现以 body 为主体的选择器', async () => {
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    const violations = checkCssScope(css, 'style.css');

    expect(violations).toEqual([]);
    // 独立态骨架改为以自有 marker 类为主体（2026-09-25：原 `body:has(> .app-container)` 会因
    // 宿主/第三方出现 `.app-container` 直接子元素而落到宿主页面）
    // 去注释后再做文本断言，避免把「说明性注释」当成违规。
    const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(cssNoComments).not.toContain('body:has(');
    expect(cssNoComments).not.toMatch(/(^|\})\s*(?:body|html|:root|\*)\s*[,{]/);
    // 根选择器已收紧为 id + 类双条件（第三方同名类不再被命中）
    expect(css).toMatch(/#app\.app-container\.app-standalone\s*\{[^}]*padding: 20px 12px;/s);
    expect(css).toMatch(/#app\.app-container\.app-standalone\s*\{[^}]*padding: 8px 6px;/s);
    expect(css).toContain('#st-converter-modal-overlay #app.app-container');
    expect(css).not.toMatch(/^\s*\.app-container[\s,{]/m);
    expect(css).toMatch(/#app\.app-container\s*\{[^}]*padding: 12px 10px;/s);
    expect(css).toContain('#app.app-container .app-header');
    expect(css).toContain('.st-converter-drawer-app .app-header');
  });
});
