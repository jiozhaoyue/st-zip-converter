# 双入口一致性：独立态 index.html 与插件态 workbench-template 分歧修复

## Goal

index.html 缺 #stash-list 等两块式节点导致独立态早退（L1-MR-10 违规），需补齐结构一致性并加机器化自查

## Requirements

**问题（2026-09-24 已核实，不是推测）**：同一 UI 存在两份独立维护的副本——独立态 `index.html` 与插件态 `src/ui/workbench-template.js`，两侧**结构已分歧**：

- `src/ui/workbench-template.js` 已按两块式（暂存区 + 待导出区）重构；
- `index.html` 仍是旧的多抽屉布局：**没有** `#stash-list`、`#stash-batch-bar`、`.wb-block` 等节点
  （`grep -n "stash-list\|wb-block" index.html` 无命中），仅有 `#workspace-archive-list` 等旧 id；
- **后果**：独立态下 `index.js:257` 的 `document.getElementById('stash-list')` 得到 `null` →
  `refreshArchiveManagerUI()` **直接 return**，暂存区组件在独立模式下**永不渲染**。

这违反 L1-MR-10「多入口产物必须同源同改」。

| 编号 | 要求 |
| --- | --- |
| R1 | **先出差异清单**（机器化）：列出 `index.html` 与 `src/ui/workbench-template.js` 的 id/结构差集，作为决策与验收依据，落盘到本任务 `research/`。 |
| R2 | **方向选择需先确认**（属架构取舍，走交互提问 + brainstorm），候选：<br>A. **单一模板来源**——独立态也用 `getWorkbenchHtml()` 生成，删除 `index.html` 的静态标记；<br>B. **保持两份副本**——补齐 `index.html` 缺失节点并对齐结构，加机器化自查防再分歧；<br>C. 其他（brainstorm 产出）。 |
| R3 | 按选定方向修复后，**独立态与插件态功能一致**：暂存区列表、批量条、待导出区、日志控制台在两种入口都能渲染与交互。 |
| R4 | **加机器化自查**：新增 npm 守卫（或在既有守卫中扩展），断言两处关键 id 集合一致。CLI 约定沿用 `scripts/css-scope.js` / `scripts/dom-injection-guard.js`：违规退出码 1、输出 `文件:行号`。 |
| R5 | 不要求用户跑构建；不引入外部 CDN；样式仍受双前缀铁律约束。 |

## Acceptance Criteria

> 2026-09-25 收口：以下各项均由 `09-25-ui-slim-native` 以**方向 A（单一模板源）**达成，
> 逐条证据见文末「收口记录」表。

- [x] 产出差异清单（id/结构差集）并落盘到本任务 `research/`。 → 由 T2 落于 `09-25-ui-slim-native/research/ids-before.txt`
- [x] 方向经确认后再实施，决策记录写入本任务 `implement.md`。 → 用户裁决 14「并入本任务」+ T2 `design.md` §2
- [x] 独立态 `npm run dev` 下：暂存区列表、批量条、待导出区、日志控制台均可见可用（手测证据）。 → T2 `implement.md` 8.3：41/41 节点、0 控制台错误
- [x] 新增的双入口一致性守卫退出码 0，且**对人为制造的 id 缺失样本退出码 1**（负向测试）。 → `check:template-source` + `test/single-template-source.test.js` 负向用例
- [x] `npm test` 全绿（≥ 226 passed / 2 skipped 不退化）；`check:css-scope` 与 `check:dom-injection` 通过。 → 现为 39 文件 / 333 passed / 2 skipped，三守卫通过
- [x] 手测**只针对 Dev 实例**（8001 / 8003），严禁 Real（8002 / 8004）。 → 满足；本轮 8004 只读复验属父任务 `09-25-workbench-native-onesop` 的用户授权范围，且已还原

## Out of Scope

- 不改转换核心（`src/core/`）逻辑。
- 不做 UI 视觉重设计（只对齐结构一致性）。

---

## 收口记录（2026-09-25）

**结论：本任务的课题已由 `09-25-ui-slim-native`（父任务 `09-25-workbench-native-onesop` 的 T2）以方向 A 实现并取代，归档。**

逐条对照（现场取证，不采信交接文档）：

| 本任务条目 | 达成情况 | 证据 |
| --- | --- | --- |
| R1 差异清单落盘 `research/` | 由 T2 承担 | `09-25-ui-slim-native/research/ids-before.txt`（`index.js` 静态引用 45 个 id、`index.html` 旧结构 85 个 id） |
| R2 方向选择（A 单一模板源 / B 保持两份副本） | **选 A** | 用户 2026-09-25 裁决 14「双入口分歧 → 并入本任务」；T2 `design.md` §2 定稿方向 A |
| R3 两入口功能一致 | **达成** | T2 `implement.md` 8.3：独立态 `npm run dev` + Playwright，**41/41 业务节点存在、0 控制台错误**（骨架化前独立态缺 `#stash-list` / `#task-controls` / `#btn-host-fetch`） |
| R4 机器化自查守卫（违规退出码 1、输出 `文件:行号`） | **达成** | `scripts/single-template-source.js` + `npm run check:template-source`；负向用例见 `test/single-template-source.test.js`（模板缺 `#stash-list` → 报 `src/ui/workbench-template.js` 缺少必需节点） |
| R5 不要求构建 / 无 CDN / 双前缀铁律 | **达成** | 三条守卫通过；`check:css-scope` 未回归 |

**方向 A 的实际形态**（比本任务 R2 原设想更强）：不再「断言两处 id 集合一致」，而是**结构上消除第二份副本**——
`index.html` 收敛为骨架（仅 `#app.app-container` + 脚本入口），唯一来源是
`src/ui/workbench-template.js` 的 `getWorkbenchHtml({ isStandalone | isDrawer | isModal })`。
守卫因此双向扫描：`index.html` 出现业务节点 id 即违规；模板缺少 `REQUIRED_TEMPLATE_IDS` 任一节点即违规。
三入口渲染一致性由 `test/single-template-source.test.js` 用 `it.each` 对三态各断言一遍（各 41 个必需节点）。

**权威条文落点**（`prd.md` 非持久载体，规范已入 `.trellis/spec/`）：
- `.trellis/spec/frontend/component-guidelines.md` → **Single Template Source Mandate** 一节
  （含三态唯一合法分支差异、机器断言清单、旧双副本事故的反向断言）
- `.trellis/spec/frontend/quality-guidelines.md` → 「单一模板源（取代原「多入口同源同改」）」
- `.trellis/spec/frontend/directory-structure.md` → 「Single Template Source」一节

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
