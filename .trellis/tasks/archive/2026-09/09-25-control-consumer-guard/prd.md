# 控件消费点守卫：把「死控件」排查固化为第 4 条机器守卫

> 由来：T4（`09-25-transfer-pack-optimize`）手工排查发现 `#incremental-mode-check`
> 长期存在却**其值从不被任何代码读取**——勾选只改摘要文字、行为零变化。
> 该项已移除；本任务把「控件必有消费点」从流程约定升级为机器守卫，
> 按本项目既有先例（`09-22-css-scope-guard`）单独成任务。
>
> **用户 2026-09-25 裁决**：新建第 4 条守卫（交互问答）。

## Goal

新增静态守卫 `npm run check:control-consumer`：模板中每个交互控件（`input` / `select` / `textarea` / `button`）
必须在**显式声明表**中有消费点条目；缺失即退出码 1 并输出 `文件:行号`。

## Background

### 问题形态（2026-09-25 实证）

`#incremental-mode-check` 的失败方式是**静默**的：它有 `getElementById`、有 `addEventListener`、
有折叠摘要文字，**看不出问题**——只有 `grep` 它的 `.checked` 读取点才会发现一个都没有。

因此「搜不到引用」这种弱判据**抓不住它**（它确实被引用了）。可靠的做法是**强制显式声明**：
新增控件时作者必须写下「谁读它的值」，写不出来就说明控件没有存在理由。

### 既有守卫惯例（必须沿用）

| 约定 | 出处 |
| --- | --- |
| CLI：违规**退出码 1**、输出 `文件:行号` | `scripts/css-scope.js`、`scripts/single-template-source.js` |
| 挂进 `package.json` 的 `scripts` | 现有三条：`check:css-scope` / `check:dom-injection` / `check:template-source` |
| 有对应单测（含**负向用例**：人为造违规须被抓到并给出正确行号） | `test/css-scope.test.js`、`test/single-template-source.test.js` |

### 本轮控件面已人工核清（守卫要覆盖的基线）

- 模板中 13 个输入控件 + 19 个按钮，**逐个人工核过消费点**（含 `file-input` 经 `file-drop.js`、
  `.btn-quick` 三个类目快捷按钮经 `category-filter.js:99`），全部有真实消费点。
- 两个单选组无 id（`name="restore-mode"` / `name="extension-mode"`），经
  `querySelector('input[name=…]:checked')` 读取——**守卫须覆盖 name 型控件**，不能只认 id。

## Requirements

### R1 守卫脚本

- **R1.1** 新增 `scripts/control-consumer-guard.js`，导出供单测调用的纯函数（沿用既有守卫的可测结构）。
- **R1.2** 扫描 `src/ui/workbench-template.js`，提取全部交互控件的 **id** 与 **name**（分组单选按 name 对待）。
- **R1.3** 与声明表比对：模板中的每个控件标识都必须在表中；**表中多出已不存在的控件**同样报违规
  （防声明表腐烂成僵尸条目）。
- **R1.4** 违规输出 `文件:行号`，退出码 1；通过时输出一行可读结论（与既有守卫文案风格一致）。

### R2 声明表

- **R2.1** 声明表 `CONTROL_CONSUMERS` 与脚本同文件，每条为
  `'<控件标识>': '<消费点：文件 — 读的是什么>'`，须可被人据以核对。
- **R2.2** 表内**必须写明局限**：该守卫只强制「声明存在」，**不能验证声明为真**——
  不要把它当作「控件一定有消费点」的证明。

### R3 接入与测试

- **R3.1** `package.json` 新增 `check:control-consumer` 脚本。
- **R3.2** 单测 `test/control-consumer-guard.test.js`：
  - 正向：仓库实况通过；
  - 负向：模板新增一个未声明的控件 → 报违规且**行号正确**；
  - 负向：声明表含模板中已不存在的控件 → 报违规（僵尸条目）；
  - 覆盖 **name 型单选组**的提取与比对。
- **R3.3** 把守卫写进 `.trellis/spec/frontend/quality-guidelines.md` 的验证矩阵
  （三条 → **四条**）与 `host-capabilities.md` 的「UI 控件合宪性」一节。

### R4 贯穿约束

- **R4.1** 不改任何产品代码——本任务**只新增守卫 + 测试 + 文档**。
- **R4.2** 不引入新依赖（G6）；只用 `node:fs` 与既有工具。
- **R4.3** `npm test` 全绿、四条守卫全部通过，零回归（起点 40 文件 / 346 passed）。

## Acceptance Criteria

- [ ] `npm run check:control-consumer` 在仓库实况下退出码 0，并输出结论行。
- [ ] 人为在模板加一个未声明控件 → 该守卫退出码 1，输出指向 `src/ui/workbench-template.js` 的**正确行号**。
- [ ] 声明表含僵尸条目（模板中已无该控件）→ 退出码 1。
- [ ] name 型单选组（`restore-mode` / `extension-mode`）被守卫覆盖，不漏检。
- [ ] `test/control-consumer-guard.test.js` 覆盖上述四种情形，且**负向用例断言行号**。
- [ ] `quality-guidelines.md` 验证矩阵与 `host-capabilities.md` 已更新（三条 → 四条守卫）。
- [ ] `npm test` 全绿（≥ 40 文件 / 346 passed）；四条守卫全通过；**未改动任何产品代码**（`git diff --stat` 可证）。

## Out of Scope

- 不实现「验证消费点声明真假」的语义分析（需变量追踪，误报率高）。
- 不改既有三条守卫的行为。
- 不新增或删除任何 UI 控件。
