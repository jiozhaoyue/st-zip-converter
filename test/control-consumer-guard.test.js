import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_CONSUMERS,
  checkControlConsumers,
  extractControls,
} from '../scripts/control-consumer-guard.js';

/**
 * 控件消费点守卫契约（2026-09-25）
 *
 * 由来：`#incremental-mode-check` 长期存在却**其值从不被读取**——
 * 它有 getElementById、有 addEventListener、有摘要文字，**看不出问题**。
 * 故本守卫不靠「搜不到引用」（它确实被引用过），而是**强制显式声明消费点**。
 */

/** 合成模板：行号可控，便于断言违规行号 */
const FIXTURE = [
  '<div class="wrap">',                            // 1
  '  <button id="btn-known">A</button>',            // 2
  '  <input type="radio" name="mode-group">',       // 3
  '  <button class="btn-tool btn-grouped">B</button>', // 4
  '</div>',                                         // 5
].join('\n');

const CONSUMERS = {
  'btn-known': 'index.js — click 做某事',
  'name:mode-group': 'index.js — querySelector(:checked).value',
  'group:.btn-grouped': '某模块 — 事件委托读 dataset',
};

const run = (template, consumers = CONSUMERS) =>
  checkControlConsumers({ template, consumers, templateFile: 'src/ui/workbench-template.js' });

describe('extractControls 控件提取', () => {
  it('提取 id / name / class，并给出正确行号', () => {
    const controls = extractControls(FIXTURE);
    expect(controls).toHaveLength(3);
    expect(controls[0]).toMatchObject({ line: 2, tag: 'button', id: 'btn-known', name: null });
    expect(controls[1]).toMatchObject({ line: 3, tag: 'input', id: null, name: 'mode-group' });
    expect(controls[2]).toMatchObject({ line: 4, tag: 'button', id: null, name: null });
    expect(controls[2].classes).toEqual(['btn-tool', 'btn-grouped']);
  });

  it('非控件标签（div/span/select 之外）不被当作控件', () => {
    const controls = extractControls('<div id="x"></div><span id="y"></span>');
    expect(controls).toEqual([]);
  });

  it('textarea 与 select 也在扫描范围内', () => {
    const controls = extractControls('<select id="s"></select><textarea id="t"></textarea>');
    expect(controls.map((c) => c.id)).toEqual(['s', 't']);
  });
});

describe('控件消费点守卫', () => {
  it('仓库实况通过：全部交互控件均有消费点声明', async () => {
    const template = await readFile(new URL('../src/ui/workbench-template.js', import.meta.url), 'utf8');
    const violations = checkControlConsumers({ template });
    expect(violations).toEqual([]);
  });

  it('实况声明表无僵尸条目，且覆盖 name 型单选组与 class 型分组按钮', async () => {
    const template = await readFile(new URL('../src/ui/workbench-template.js', import.meta.url), 'utf8');
    const controls = extractControls(template);

    // name 型（无 id）单选组必须被显式声明
    const nameOnly = controls.filter((c) => !c.id && c.name);
    expect(nameOnly.length).toBeGreaterThan(0);
    for (const c of nameOnly) {
      expect(CONTROL_CONSUMERS).toHaveProperty(`name:${c.name}`);
    }

    // class 型（无 id 无 name）必须由 group: 覆盖
    const groupOnly = controls.filter((c) => !c.id && !c.name);
    expect(groupOnly.length).toBeGreaterThan(0);
    for (const c of groupOnly) {
      const hit = Object.keys(CONTROL_CONSUMERS).filter(
        (k) => k.startsWith('group:.') && c.classes.includes(k.slice('group:.'.length)),
      );
      expect(hit).toHaveLength(1);
    }
  });

  it('合法模板无违规', () => {
    expect(run(FIXTURE)).toEqual([]);
  });

  it('【负向】新增未声明控件 → 报违规且行号正确', () => {
    const template = `${FIXTURE}\n<button id="btn-undeclared"></button>`; // 第 6 行
    const violations = run(template);

    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe('src/ui/workbench-template.js');
    expect(violations[0].line).toBe(6);
    expect(violations[0].control).toBe('btn-undeclared');
    expect(violations[0].message).toMatch(/未在 CONTROL_CONSUMERS 中声明消费点/);
  });

  it('【负向】未声明的 name 型单选组 → 报违规并指出应使用的键名', () => {
    const template = `${FIXTURE}\n<input type="radio" name="new-mode">`; // 第 6 行
    const violations = run(template);

    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(6);
    expect(violations[0].control).toBe('name:new-mode');
    expect(violations[0].message).toMatch(/"name:new-mode"/);
  });

  it('【负向】既无 id 也无 name 且无 group 声明 → 报违规', () => {
    const template = `${FIXTURE}\n<button class="btn-orphan">C</button>`; // 第 6 行
    const violations = run(template);

    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(6);
    expect(violations[0].message).toMatch(/既无 id 也无 name/);
  });

  it('【负向】一个控件被多个 group: 声明覆盖 → 报违规', () => {
    const consumers = { ...CONSUMERS, 'group:.btn-tool': '另一个模块' };
    const violations = run(FIXTURE, consumers);

    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(4);
    expect(violations[0].message).toMatch(/被多个 group: 声明覆盖/);
  });

  it('【负向】声明表含僵尸条目（模板中已无该控件）→ 报违规', () => {
    const consumers = { ...CONSUMERS, 'btn-gone': 'index.js — 已删除的控件' };
    const violations = run(FIXTURE, consumers);

    expect(violations).toHaveLength(1);
    expect(violations[0].control).toBe('btn-gone');
    expect(violations[0].message).toMatch(/僵尸条目/);
  });

  it('【防绕过】group: 键不得用来兜底「有 id 的控件」', () => {
    // 故意把 btn-known 从表里删掉，但加一条能匹配它 class 的 group: 声明
    const consumers = {
      'name:mode-group': CONSUMERS['name:mode-group'],
      'group:.btn-grouped': CONSUMERS['group:.btn-grouped'],
    };
    const template = [
      '<button id="btn-known" class="btn-tool">A</button>',
      '<button class="btn-tool btn-grouped">B</button>',
    ].join('\n');
    const violations = run(template, consumers);

    // 有 id 的控件只能由 id 声明，不得被 group: 兜底
    expect(violations.some((v) => v.control === 'btn-known')).toBe(true);
  });
});
