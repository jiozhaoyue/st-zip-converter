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

- [ ] 产出差异清单（id/结构差集）并落盘到本任务 `research/`。
- [ ] 方向经确认后再实施，决策记录写入本任务 `implement.md`。
- [ ] 独立态 `npm run dev` 下：暂存区列表、批量条、待导出区、日志控制台均可见可用（手测证据）。
- [ ] 新增的双入口一致性守卫退出码 0，且**对人为制造的 id 缺失样本退出码 1**（负向测试）。
- [ ] `npm test` 全绿（≥ 226 passed / 2 skipped 不退化）；`check:css-scope` 与 `check:dom-injection` 通过。
- [ ] 手测**只针对 Dev 实例**（8001 / 8003），严禁 Real（8002 / 8004）。

## Out of Scope

- 不改转换核心（`src/core/`）逻辑。
- 不做 UI 视觉重设计（只对齐结构一致性）。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
