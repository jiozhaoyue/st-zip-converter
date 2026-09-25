import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDomScope } from '../scripts/dom-scope.js';

/**
 * 宿主 DOM 作用域守卫的负例回归（R7）。
 *
 * 为什么要负例：只看真仓跑出「0 违规」无法区分「确实干净」与「守卫失灵」。
 * 本文件里的**每一例都必须被拦下**（或必须被放行）——它同时也是守卫能力的说明书。
 *
 * 首版守卫在写这些负例时当场暴露过一个真漏洞：`?.` 可选链形式的宿主写入
 * （`document.querySelector('#evil')?.appendChild(x)`）会**静默通过**。
 * 见 `scripts/dom-scope.js` 里 `objectExprRange` 的 `?` 处理。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('宿主 DOM 作用域守卫', () => {
  it('放行：写自己 createElement 出来的节点 / 局部变量', () => {
    const code = `
const panel = document.createElement('div');
panel.appendChild(child);
listEl.appendChild(itemEl);
fragment.appendChild(line);
cond ? a.appendChild(x) : b;
`;
    expect(checkDomScope(code, 'fixture.js')).toEqual([]);
  });

  it('放行：写入白名单锚点（含可选链写法）', () => {
    const code = `
document.querySelector('#extensions_settings2').appendChild(panel);
document.getElementById('extensionsMenu')?.appendChild(item);
document.querySelector('#extensionsMenu .list-group').appendChild(item);
document.querySelector('.userBackupManager .backupActionRow').insertBefore(btn, row.firstChild);
`;
    expect(checkDomScope(code, 'fixture.js')).toEqual([]);
  });

  it('拦截：直接写宿主 body / documentElement / head', () => {
    for (const target of ['document.body', 'document.documentElement', 'document.head']) {
      const violations = checkDomScope(`${target}.appendChild(overlay);`, 'fixture.js');
      expect(violations, `${target} 必须被拦下`).toHaveLength(1);
      expect(violations[0].reason).toContain('宿主 body');
    }
  });

  it('拦截：可选链形式的宿主 body 写入（首版守卫在此静默漏报）', () => {
    expect(checkDomScope('document.body?.appendChild(x);', 'fixture.js')).toHaveLength(1);
    expect(checkDomScope("document.querySelector('#evil')?.appendChild(x);", 'fixture.js')).toHaveLength(1);
  });

  it('拦截：写入宿主查询得到的**非白名单**节点', () => {
    const violations = checkDomScope("document.querySelector('#someThirdPartyThing').appendChild(x);", 'fixture.js');
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toContain('不在锚点白名单内');
  });

  it('拦截：选择器不是字面量（静态不可判）时不放行', () => {
    expect(checkDomScope('document.querySelector(sel).appendChild(x);', 'fixture.js')).toHaveLength(1);
  });

  it('拦截：方括号取法的宿主 body 也逃不掉', () => {
    expect(checkDomScope("document['body'].appendChild(x);", 'fixture.js')).toHaveLength(1);
  });

  it('拦截：insertAdjacentHTML / replaceChild / prepend 同样算写入', () => {
    expect(checkDomScope("document.body.insertAdjacentHTML('beforeend', h);", 'fixture.js')).toHaveLength(1);
    expect(checkDomScope('document.head.replaceChild(a, b);', 'fixture.js')).toHaveLength(1);
    expect(checkDomScope('document.body.prepend(x);', 'fixture.js')).toHaveLength(1);
  });

  it('放行：语句行或上一非空行有显式 allow 标记', () => {
    expect(checkDomScope(
      'document.body.appendChild(a); // dom-scope:allow 下载锚点：临时 <a> 触发 click()\n',
      'fixture.js',
    )).toEqual([]);
    expect(checkDomScope(
      '// dom-scope:allow 自绘模态覆盖层必须挂 body\n\ndocument.body.appendChild(overlay);\n',
      'fixture.js',
    )).toEqual([]);
  });

  it('拦截：标记放得太远（隔了内容行）不算数', () => {
    const code = `
// dom-scope:allow 随便写的理由
const x = 1;
document.body.appendChild(overlay);
`;
    expect(checkDomScope(code, 'fixture.js')).toHaveLength(1);
  });

  it('放行：整文件豁免', () => {
    const code = '// dom-scope:allow-file 本文件为待清理死代码\ndocument.body.appendChild(x);\n';
    expect(checkDomScope(code, 'fixture.js')).toEqual([]);
  });

  it('不误报：注释与字符串里出现的写入形态不算', () => {
    const code = `
// document.body.appendChild(x);
/* document.body.appendChild(y); */
const s = 'document.body.appendChild(z);';
const t = \`document.body.appendChild(w);\`;
`;
    expect(checkDomScope(code, 'fixture.js')).toEqual([]);
  });
});

describe('宿主 DOM 作用域守卫 · 真仓现状', () => {
  it('src/ui 与 index.js 当前零未声明写入（改动后若报错，先看是否确属必要再决定加标记）', async () => {
    const files = ['index.js'];
    for (const f of ['view.js', 'export-queue.js', 'stash-list.js', 'log-console.js', 'host-bridge.js',
      'category-filter.js', 'file-tree-picker.js', 'escape.js', 'file-drop.js', 'task-controls.js',
      'usage-dashboard.js', 'action-colors.js', 'workbench-template.js']) {
      files.push(`src/ui/${f}`);
    }
    const all = [];
    for (const rel of files) {
      const code = await readFile(path.join(root, rel), 'utf8');
      all.push(...checkDomScope(code, rel));
    }
    expect(all).toEqual([]);
  });
});
