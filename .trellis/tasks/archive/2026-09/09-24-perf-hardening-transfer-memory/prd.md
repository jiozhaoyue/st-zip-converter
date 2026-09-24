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

> 回填于 2026-09-24（Phase 2.2 收尾）。证据列给出可核对位置；**标注「仅代码核对」的项
> 无单测覆盖**，原因见该项括号内说明。

- [x] `restoreToHost` 的每个网络 `await` 都有超时或 `AbortSignal` 兜底（逐点列表可核对），且可被用户取消。
      ——**兜底闭合**：`getCsrfToken` / `getHandle` 走 `SHORT_FETCH_TIMEOUT_MS`；
      `POST /api/users/restore` 超时由 `UPLOAD_TIMEOUT_MS` 配置（默认 `0`，见 `design.md` §2.2）；
      **响应体读取**走 `readJsonBounded`（headers 到达后 `fetchWithTimeout` 已摘掉 listener，
      此前该 `await` 既无超时也不响应取消——2026-09-24 自核补修）。
      ——**取消入口已补齐**（2026-09-24 用户裁决「现在补齐」）：`host-bridge.js` 持有在途控制器，
      导出 `cancelRestoreInFlight()`；待导出区在途时渲染「取消恢复」按钮；
      取消抛 `AbortError`，UI 给「恢复已取消 + 宿主可能仍在处理，请稍后核对数据」（非「失败」）。
      单测：`test/restore-chain.test.js`（有界等待 7 + 响应体有界 7 + 并发互斥 2 + 取消入口 3 + 伪成功 2）。
- [x] 恢复在途时全部「写回宿主」入口被禁用（并发互斥生效），并有对应单测。
      ——互斥本身有单测（`restore-chain.test.js` 并发互斥 2 条：在途拒绝 + finally 复位）。
      **按钮禁用部分仅代码核对**（`export-queue.js:317`/`384`）：本仓无 DOM 测试环境
      （无 jsdom 依赖，沿 `restore-manifest.test.js` 既定约定），该分支需选中条目后才渲染。
- [x] 响应体解析失败不再返回 `success: true`（有单测断言）。
      ——`restore-chain.test.js`「响应体不可解析时返回 unconfirmed」。
- [x] `authority-store` 写入路径不再出现整包 `arrayBuffer()`；`putArtifact` 峰值由 `N + 2.33C` 降至 `O(C)`（公式核对 + 合成数据抽样）。
      ——单测 `authority-store.test.js`：探针对象对 `arrayBuffer`/`text` 直接抛错（回归即失败），
      1MB 数据 / 256KB 块切 4 块；另「大 blob 分块写入并完整重组」做 1.5MB 合成数据往返。
- [x] KV 写失败时「暂停」仍生效：mock client 让 `kv.set` reject，断言 `signal.aborted` 为真。
      ——`authority-store.test.js`「KV 写失败不阻断暂停」（经 `createCheckpointAdapter` 真实接缝）。
- [x] 分卷完成后 `lastConvertedBlob` 为 `null`；条目数据在写入后不再被持有。
      ——**仅代码核对**（`index.js` D1/D2，`try/finally` 释放 `entries`）：`index.js` 为根控制器，
      本仓无任何测试文件导入它，故无单测。
- [x] 新增 `test/restore-chain.test.js`：mock fetch 挂起 → 断言超时抛错；断言并发互斥；断言伪成功已修。
      ——10 条用例（有界等待 7 + 并发互斥 2 + 伪成功 1）。
- [x] `npm test` 全绿（≥ 226 passed / 2 skipped 基线不退化）；`check:css-scope` 与 `check:dom-injection` 通过。
      ——**289 passed / 2 skipped / 37 文件**（基线 226/2/34）；两条守卫通过；`npm run build` exit 0。

## 未满足项（2026-09-24 自核发现，待裁决）

### U-1 恢复的「取消入口」缺失 —— ✅ 已解决（用户裁决「现在补齐」）

- **原状**：`restoreToHost(zipBlob, { signal })` 已具备取消能力，但**所有调用点都没传 `signal`**；
  弹窗的 `#btn-cancel-restore` 只是开跑前撤销（恢复开始后弹窗已隐藏，按钮不可达）。
- **结果**：2026-09-24 补齐为「在途控制器由 `host-bridge.js` 持有 + 待导出区取消按钮」，
  见 AC #1。选择该落点而非 index.js 局部变量的原因：无 DOM 的 Node 环境下**可被单测覆盖**
  （`restore-chain.test.js`「取消入口」3 条）。
- **仍无单测的部分**：待导出区那个按钮本身的渲染（无 jsdom，沿本仓既定约定）。

### U-2 扩展安装器链路的 fetch 仍无兜底（R1 范围外）

`host-bridge.js` 的 `discoverHostExtensions` / `installExtensionViaHost` /
`checkHostThirdPartyAnomaly` / `deleteExtensionViaHost` 四处仍是裸 `fetch`。
它们属恢复成功后的扩展安装器（上一任务 `09-23-extension-manifest-git` 交付），
**不在 R1「恢复链路」范围内**，此处仅登记，避免日后误判为已覆盖。

---

## Out of Scope

- 恢复进度可见化（`XMLHttpRequest.upload.onprogress`）——属 `09-23-batch-restore-refresh`，不要重复设计。
- 分卷流式重构（`AsyncIterable` + `addLazy`）——若与 `09-23-authority-cloud-transfer` 重叠则并入该任务。
- 宿主 UI 落点合规性（审计 R-22 / R-23 / R-26）与日志隐私脱敏（R-24）。
- 内存基线自动化门禁（审计后续项，另行评估）。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
