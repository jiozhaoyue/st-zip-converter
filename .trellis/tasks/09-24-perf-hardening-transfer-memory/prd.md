# 性能止血：恢复链路有界等待 + 传输/分卷内存峰值

## Goal

修复审计确认的无界等待与内存峰值：restoreToHost 超时/中止/并发互斥、authority-store 去整包 arrayBuffer 常驻、分卷 Blob 即时释放

## Requirements

**来源**：`.trellis/tasks/archive/2026-09/09-23-perf-security-audit/research/00-audit-index.md` 第 2 节中属「性能」类的项，及分片报告 `01-restore-chain.md` / `02-authority-transfer.md` / `03-splitter-memory.md`。
**性质**：修复已确认的无界等待与内存峰值，**不改变**纯前端为主、后端为可选增强层的产品定位（L0-11 / L1-MR-1）。

| 编号 | 要求 | 锚点（审计证据） |
| --- | --- | --- |
| R1 | 恢复链路**有界等待**：抽出带超时与 `AbortSignal` 的 fetch 封装，`restoreToHost` 全链路可中止；UI 提供取消入口，取消后明确提示「宿主可能仍在处理，请稍后核对数据」 | `src/ui/host-bridge.js:158/168/429/437`；`index.js:1036-1060`（R-01 / R-02 / R-05） |
| R2 | 恢复**并发互斥**：全局 `restoreInFlight` 标志，在途时禁用全部「写回宿主」入口，避免两个 restore 事务并发写同一用户目录 | R-12 |
| R3 | 修掉**伪成功**：响应体解析失败不得当作 `success: true`；UI 区分「成功」与「请求已发出但未确认」 | `src/ui/host-bridge.js:459`（R-15） |
| R4 | `authority-store` **去整包驻留**：写入改 `blob.stream()` 逐块切分，去掉整包 `arrayBuffer()` 与整包 base64 中间串；读取改流式重组 | `src/storage/authority-store.js:118,132`（F-A / F-C） |
| R5 | `createCheckpointAdapter` **失败回退**：KV 写失败必须回退内存 adapter，不得让「暂停」语义依赖可选后端 | `authority-store.js`；`src/core/task-manager.js:131`（F-B，违反 L1-MR-1） |
| R6 | 分卷**即时释放**：`lastConvertedBlob` 用后置空；条目写入后即时释放（`entries[i].data = null` 或改 `for await` 流式喂 writer） | `index.js:1188/1232`、`index.js:934-938/1210-1214`（S-01 / S-02） |
| R7 | 传输**失败清理**：`putArtifact` 中途失败回滚本次已写分块；写入改为「新 part 名 → 成功后换清单 → 清旧 part」，消除孤儿块与新旧混合损坏 | `authority-store.js`（F-D / F-F） |
| R8 | **不得降低既有行为**：`npm test` 全绿 + 两条守卫通过；后端不可用时纯前端路径仍全功能 | L0-11 / L1-MR-1 |

## Acceptance Criteria

- [ ] `restoreToHost` 的每个网络 `await` 都有超时或 `AbortSignal` 兜底（逐点列表可核对），且可被用户取消。
- [ ] 恢复在途时全部「写回宿主」入口被禁用（并发互斥生效），并有对应单测。
- [ ] 响应体解析失败不再返回 `success: true`（有单测断言）。
- [ ] `authority-store` 写入路径不再出现整包 `arrayBuffer()`；`putArtifact` 峰值由 `N + 2.33C` 降至 `O(C)`（公式核对 + 合成数据抽样）。
- [ ] KV 写失败时「暂停」仍生效：mock client 让 `kv.set` reject，断言 `signal.aborted` 为真。
- [ ] 分卷完成后 `lastConvertedBlob` 为 `null`；条目数据在写入后不再被持有。
- [ ] 新增 `test/restore-chain.test.js`：mock fetch 挂起 → 断言超时抛错；断言并发互斥；断言伪成功已修。
- [ ] `npm test` 全绿（≥ 226 passed / 2 skipped 基线不退化）；`check:css-scope` 与 `check:dom-injection` 通过。

## Out of Scope

- 恢复进度可见化（`XMLHttpRequest.upload.onprogress`）——属 `09-23-batch-restore-refresh`，不要重复设计。
- 分卷流式重构（`AsyncIterable` + `addLazy`）——若与 `09-23-authority-cloud-transfer` 重叠则并入该任务。
- 宿主 UI 落点合规性（审计 R-22 / R-23 / R-26）与日志隐私脱敏（R-24）。
- 内存基线自动化门禁（审计后续项，另行评估）。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
