import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDomInjection } from '../scripts/dom-injection-guard.js';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GUARD = path.join(ROOT, 'scripts', 'dom-injection-guard.js');

describe('checkDomInjection · 负向（必须拦下）', () => {
  it('模板插值未转义 → 报 interpolation', () => {
    const violations = checkDomInjection('el.innerHTML = `<span>${file.name}</span>`;', 'x.js');
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('interpolation');
  });

  it('多个未转义插值逐个报出', () => {
    const violations = checkDomInjection('el.innerHTML = `<b>${a}</b><i>${b}</i>`;', 'x.js');
    expect(violations).toHaveLength(2);
  });

  it('右值为变量（无法静态确认）→ 报 opaque-rhs', () => {
    const violations = checkDomInjection('el.innerHTML = html;', 'x.js');
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('opaque-rhs');
  });

  it('insertAdjacentHTML 未转义 → 报 interpolation', () => {
    const violations = checkDomInjection("el.insertAdjacentHTML('beforeend', `<b>${x}</b>`);", 'x.js');
    expect(violations).toHaveLength(1);
  });

  it('outerHTML 未转义 → 报 interpolation', () => {
    const violations = checkDomInjection('el.outerHTML = `<b>${x}</b>`;', 'x.js');
    expect(violations).toHaveLength(1);
  });
});

describe('checkDomInjection · 正向（必须放行）', () => {
  it('清空动作放行', () => {
    expect(checkDomInjection("el.innerHTML = '';", 'x.js')).toHaveLength(0);
    expect(checkDomInjection('el.innerHTML = "";', 'x.js')).toHaveLength(0);
    expect(checkDomInjection('el.innerHTML = ``;', 'x.js')).toHaveLength(0);
  });

  it('escapeHtml 包裹放行', () => {
    expect(checkDomInjection('el.innerHTML = `<span>${escapeHtml(file.name)}</span>`;', 'x.js')).toHaveLength(0);
  });

  it('trustedStaticMarkup 包裹变量放行', () => {
    expect(checkDomInjection('el.innerHTML = trustedStaticMarkup(html);', 'x.js')).toHaveLength(0);
  });

  it('字符串字面量放行（无法插值）', () => {
    expect(checkDomInjection("el.innerHTML = '<b>静态</b>';", 'x.js')).toHaveLength(0);
  });

  it('显式豁免注释放行', () => {
    const src = '// dom-injection-guard:allow 单位测试用静态片段\nel.innerHTML = `<b>${x}</b>`;';
    expect(checkDomInjection(src, 'x.js')).toHaveLength(0);
  });
});

describe('守卫 CLI · 退出码语义', () => {
  it('对含未转义插值的合成样本退出码为 1', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dom-guard-'));
    try {
      await writeFile(path.join(dir, 'bad.js'), 'export const x = (file) => { el.innerHTML = `<b>${file.name}</b>`; };\n', 'utf8');
      await expect(run(process.execPath, [GUARD, dir])).rejects.toMatchObject({ code: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('对已转义的合成样本退出码为 0', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dom-guard-'));
    try {
      await writeFile(path.join(dir, 'good.js'), 'export const x = (file) => { el.innerHTML = `<b>${escapeHtml(file.name)}</b>`; };\n', 'utf8');
      const { stdout } = await run(process.execPath, [GUARD, dir]);
      expect(stdout).toContain('DOM 注入守卫通过');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('对本仓库自身退出码为 0（防回归门禁）', async () => {
    const { stdout } = await run(process.execPath, [GUARD]);
    expect(stdout).toContain('DOM 注入守卫通过');
  });
});
