# 安全注入面止血：扩展清单 XSS 与全量未转义注入点

## Goal

修复审计发现的用户可控数据注入 innerHTML 面：扩展清单字段 XSS、未净化文件名注入点、统一 escapeHtml 与 CI 守卫

## Requirements

**来源**：`archive/2026-09/09-23-perf-security-audit/research/04-dom-injection.md`（D-01~D-06）与 `01-restore-chain.md`（R-21 / R-25）。审计结论：存在**完整可达的存储型 XSS 路径**。

| 编号 | 要求 |
| --- | --- |
| R1 | 新增共享转义层 `src/ui/escape.js`，导出 `escapeHtml()`，**覆盖 5 个字符** `& < > " '`；供 UI 层复用，替代 `log-console.js` 内部仅覆盖 3 字符的私有实现。 |
| R2 | `src/ui/host-bridge.js` 扩展安装面板（`renderExtensionInstallerModal`，约 `:702-733`）改为 `createElement` + `textContent`；`ext.url` 在**渲染期**补 `^https?://` 校验，不合法则显示占位文本（不输出原值）。 |
| R3 | `src/ui/host-bridge.js` 安装状态与错误消息改 `textContent`（Font Awesome 图标拆为独立节点，见 `:831`  `err.message` 插值）。 |
| R4 | 文件名 / 文本类注入点**经共享 `escapeHtml` 转义**（结构化列表模板），单值块改 `textContent`：`src/ui/stash-list.js:155`、`src/ui/export-queue.js:332`、`src/ui/file-drop.js:78/136`、根 `index.js` 两处。**整块模板串改写为 `createElement` 属后续任务**（审计报告第 3 节第 2 项），本任务只做止血。 |
| R5 | `src/ui/log-console.js` 改用共享 `escapeHtml`（从 3 字符升为 5 字符，堵住属性上下文注入）。 |
| R6 | 新增 `scripts/dom-injection-guard.js` + `npm run check:dom-injection`：扫描 `src/ui/**` 与根 `index.js`，检出 `innerHTML` / `insertAdjacentHTML` / `outerHTML` 赋值中含未转义 `${...}` 插值的行。白名单仅允许「空串清空」与「显式 `escapeHtml(` 包裹」。 |
| R7 | **纯安全加固**：不得改变任何可见外观与交互行为；不得改变模块公开签名（除新增 `escape.js`）。 |

**约束**：
- 遵循 L1-MR-3 的既有先例（`scripts/css-scope.js` + `npm run check:css-scope`）——守卫脚本必须能被 CI/本地一条命令调用。
- 遵循 L0-4：全部改动为块级 diff（`replace_string_in_file`），禁止整文件覆盖。

## Acceptance Criteria

- [x] `src/ui/escape.js` 导出 `escapeHtml`，对 `& < > " '` 五个字符均转义；有对应单测。
- [x] 扩展清单渲染路径中**不存在**未转义插值：`displayName` / `folder` / `url` / `branch` 全部经 `textContent` 或 `escapeHtml`（并由 `npm run check:dom-injection` 机器化固化）。
- [x] 恶意 URL（如 `javascript:alert(1)`）在面板中只显示占位文本，不产生可点击/可执行节点（`isSafeHttpUrl()` 渲染期把关）。
- [x] `npm run check:dom-injection` 存在，且对当前仓库退出码为 **0**。
- [x] **负向测试**：守卫脚本对含未转义 `${file.name}` 的合成样本报错并退出码 **1**（已由 `test/dom-injection-guard.test.js` 固化）。
- [x] `npm test` 全绿：**226 passed / 2 skipped**（基线 199 passed 未退化，净增 27 项）。
- [x] `npm run check:css-scope` 仍通过（未引入裸选择器）。
- [x] 全部改动为块级 diff，未整文件覆盖任何现有文件。

## Out of Scope

- 不做链路②（`authority-store` 内存/传输）与链路③（分卷内存）的性能优化——属性能止血档，另任务。
- 不改宿主 UI 落点合规性（审计 R-22 / R-23 / R-26，属 `09-23-extension-cloud-migration`）。
- 不引入 CSP（宿主页面非本项目可控）。
- 不改 `data-id="${…}"` 之类的隐式契约项（审计 D-04，低优先，另行处理）。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
