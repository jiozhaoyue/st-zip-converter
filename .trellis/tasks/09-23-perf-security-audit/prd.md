# 恢复链路与传输性能安全审计

## Goal

对现有代码做一次带证据的性能与安全审计，聚焦恢复链路、Authority 传输、分卷内存模型与 DOM 高频路径，产出可执行的优化建议清单（只出报告，不在本任务内改代码）。

## Background

- 历史教训已沉淀多条规则（L1-MR-7 有界等待、L1-MR-9 rAF 合帧、P-6/P-7/P-8），但恢复链路（`restoreToHost`）与 Authority 传输（base64 分块）尚未经过同等审视。
- 已知可疑点：`authority-store.js` 全量 `arrayBuffer()` + base64 内存峰值；`restoreToHost` 无超时/中止兜底；`file-drop.js` 与 `host-bridge.js` 存在 `innerHTML` 拼接用户文件名；分卷在内存中累积 `Blob`。
- 本任务与 `09-23-authority-cloud-transfer`、`09-23-batch-restore-refresh` 的优化直接相关，审计结论将作为它们的设计输入。

## Requirements

- 审计范围限定四条链路：①`restoreToHost` 恢复链路（超时/中止/错误处理）；②`authority-store.js` 传输（内存峰值、base64 开销、失败清理）；③`splitter.js` 分卷内存模型（Blob 累积、超大文件）；④DOM 高频路径（进度回调、innerHTML 注入面）。
- 每条发现必须带 `file:line` 锚点、证据（代码路径或实测）、严重度与建议修复方向。
- 安全面重点：innerHTML 注入（用户文件名/扩展名进入 DOM）、CSRF 处理、凭据与 secrets 不出现在日志/报告中。
- 只读审计：不修改产品代码，不连接 Real 实例；如需运行基准，仅用合成数据。
- 产出为 `research/` 下的审计报告，供后续优化任务引用。

## Acceptance Criteria

- [ ] 审计报告覆盖四条链路，每条发现带 file:line 与严重度。
- [ ] innerHTML 注入面全部列出并给出修复建议（textContent/转义）。
- [ ] `restoreToHost` 是否有界等待（超时/abort）有明确结论。
- [ ] base64 内存峰值有量化估算（公式或实测）。
- [ ] 报告区分“立即修复”与“纳入后续优化任务”两档建议。

## Out of Scope

- 不修复任何发现（修复走对应实施任务）。
- 不做全仓安全审计（只覆盖上述四条链路）。
