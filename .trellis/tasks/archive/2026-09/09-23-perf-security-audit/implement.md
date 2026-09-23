# 实施清单（执行阶段）

> 本任务为**只读审计**：不修改产品代码，产出仅写入本任务 `research/`。

## 0 规划（已完成）

- [x] 审计范围与优先级确认——四条链路：①恢复 `restoreToHost` ②`authority-store` 传输 ③`splitter` 分卷内存 ④DOM 高频路径/innerHTML。
- [x] 配置 check 上下文清单（spec 质量规范 + 相关源码路径说明）。
- [x] start 任务并派子代理执行审计。（**曾误用外部 channel worker，已按用户指令终止并改为 Copilot 自身子代理**）

## 1 执行（Copilot 自身子代理并行 + 主代理同轮并行）

> **2026-09-23 用户指令变更**：禁止调用其他 agent（含 `trellis channel spawn` 的 claude/codex worker），
> 只能使用 **Copilot 自身子代理功能**（`runSubagent`），且主代理不得被阻塞。
> 已终止 3 个已派发的外部 worker（channel `perf-audit-0923`）。
> 落地方式：3 个子代理**同一轮并发派发**，主代理同轮并行读取源码建立锚点。

- [x] CH1 恢复链路 `restoreToHost` 超时/中止/错误处理 → `research/01-restore-chain.md`（25 条，最高**高**）
- [x] CH2 `authority-store.js` 传输内存峰值 / base64 开销 / 失败清理 → `research/02-authority-transfer.md`（10 条，最高**高**）
- [x] CH3 `splitter.js` 分卷内存模型（Blob 累积 / 超大文件）→ `research/03-splitter-memory.md`（11 条，最高**高**）
- [x] CH4 DOM 高频路径（进度回调/long task）+ innerHTML 注入面 → `research/04-dom-injection.md`（9 条，最高**高**）

## 2 主代理自办（同轮并行推进）

- [x] 建立四链路 `file:line` 锚点索引 → `research/00-audit-index.md`
- [x] 汇总报告：区分「立即修复」（20 项）与「纳入后续优化任务」（14 项）两档

## 3 收口（验收对齐 prd.md）

- [x] 报告覆盖四条链路，每条发现带 file:line 与严重度
- [x] innerHTML 注入面全量列出（57 处赋值全覆盖）+ textContent/转义修复建议
- [x] `restoreToHost` 有界等待（超时/abort）结论明确：**存在无界等待**
- [x] base64 内存峰值量化估算（公式 + 分档表）
- [x] 两档建议分档清晰

## 4 规则沉淀

- [x] 子代理来源唯一性 + 并行不阻塞 + 自包含 + 写权限边界 → `.trellis/spec/guides/subagent-collaboration.md`
- [x] 同步至 `AGENTS.md`（Custom Agent Guidelines）与 `CLAUDE.md`（踩过的坑 #5）
- [x] `.trellis/spec/guides/index.md` 登记条目 + 派发自检清单

## 当前不做

- 不修改任何产品代码；不连接 Real 实例（端口 8002/8004）；基准仅用合成数据。
- 本任务**不修复**任何发现——修复走 `00-audit-index.md` 第 2/3 节列出的实施任务。
