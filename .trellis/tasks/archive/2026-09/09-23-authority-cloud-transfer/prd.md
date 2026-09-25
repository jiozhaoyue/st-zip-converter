# Authority 云端传输与后台暂存

## Goal

把 Authority 的可移植能力（transfer / blob / private-file / jobs / events）用于本插件的大数据包后台暂存与云端部署优化，使云酒馆场景下的传输更快、更可续传，同时严格保持纯前端降级路径完整可用。

## Background

- 现有 `authority-store.js` 用 base64 分块（4MB/块）经 `storage.blob.put` 逐块写入，云端部署时 base64 有约 33% 体积膨胀与编解码 CPU 开销。
- Authority 公开 transfer API（`/transfers/init|append|commit-transfer`）支持流式大对象暂存，可避免 base64；`fs/private/write-file-transfer` 可落成扩展私有文件。
- Authority Jobs 仅支持内置 job 类型（delay/sql.backup/trivium.flush/fs.import-jsonl），不是任意代码执行框架，不能用来跑转换。
- L0-12：跨宿主插件禁用 Host Bridge，只能用可移植子集；L0-11/L1-MR-1：Authority 只做可选增强，静默降级。

## Requirements

- 调研并设计从 base64 分块到 transfer API 的迁移路径：大产物暂存优先走 transfer，保留 base64 作为旧版 Authority 的回退。
- 云端部署优化：针对延迟较高的云酒馆，设计传输并发度、重试与断点续传策略；明确 Authority 服务端 limits（effectiveInlineThresholdBytes 等）如何被探测与遵守。
- 产物镜像（`mirrorArtifact`）保持 fire-and-forget：任何 Authority 失败只告警，不阻塞本地产物入库。
- 所有 Authority 数据仍在扩展隔离命名空间内；不得借 Authority 写酒馆用户事实源目录。
- 性能结论必须有实测证据（本地与至少一种云端/高延迟模拟环境对比）。

## Acceptance Criteria

- [ ] transfer API 迁移方案与回退策略成文，含 SDK 返回形状的兼容处理。
- [ ] base64 与 transfer 两条路径的体积/耗时对比实测记录（research/ 落盘）。
- [ ] 云端高延迟场景的并发/重试参数有依据（非拍脑袋）。
- [ ] 降级路径测试计划：无 Authority、权限被拒、传输中断三种场景。
- [ ] 不引入新的宿主耦合，不声明 Authority 为必选。

## Out of Scope

- 不把转换计算迁移到 Authority Jobs（其 job 类型受限且非任意执行）。
- 不修改 Authority 服务端本身（那是另一个仓库）。

## Open Questions

- OQ-1：Authority SDK 的 transfer API 在浏览器侧的确切调用形状（以 Authority 官方文档为准）。
- OQ-2：云部署时 Authority 与本插件的部署拓扑（同机/跨机）对延迟的影响是否需要实测。

---

## 收口取证与残留登记（2026-09-25）

**收口决议（用户 2026-09-25 四问裁决）**：本任务**不再实施** —— 逐条取证后归档。

> ⚠ **本任务的残留未并入新任务**（与 `09-23-batch-restore-refresh` 不同）：新任务主题是
> 「恢复编排 + 宿主端点适配」，而 transfer 迁移属云端/Authority 主题，且其验收自身要求
> **实测环境**（Authority 服务端在线 + 高延迟模拟），并入会造成范围膨胀与假达成。理由详下。

### AC 逐条取证（**未执行的条目保持未勾选，不得批量补勾**）

- **[部分]** AC1 transfer API 迁移方案与回退策略成文（含 SDK 返回形状兼容处理）
  —— `design.md` 有目标路径与探测/回退设想（`Blob.stream()` → transfer/init → append →
  `blob/commit-transfer`；由 `session.init` 的 `limits`/`features` 决定启用，失败回退 base64），
  但 **SDK 返回形状未取证**（原 OQ-1 从未执行）。
- **[未做]** AC2 base64 与 transfer 两条路径的体积/耗时对比实测记录（`research/` 落盘）
  —— 相近代偿（**不是本 AC**）：`09-24-perf-hardening-transfer-memory` 已量化并落单测的是
  **内存模型** `N + 2.33C → O(CHUNK_SIZE)`（`test/authority-store.test.js:139`「写入走
  blob.stream() 逐块切分，不触碰整包 arrayBuffer」），不是两条路径的体积/耗时对比。
- **[未做]** AC3 云端高延迟场景的并发/重试参数有依据（非拍脑袋）
  —— 取证：`src/storage/authority-store.js` 全文**无** retry / 并发 / backoff 参数
  （grep `retry|重试|并发|concurren` 零命中）；`UPLOAD_TIMEOUT_MS` 属恢复链路（09-24 交付），
  不在本任务范围。
- **[部分]** AC4 降级路径测试计划（无 Authority / 权限被拒 / 传输中断三场景）
  —— 已有覆盖：不可用安全降级（`test/authority-store.test.js:64`）、中途失败回滚（`:186`）、
  清单写入失败孤儿清理（`:208`）、KV 写失败不阻断暂停（`:237`）；
  **未覆盖**「权限被拒」与「传输中断（网络层）」两类。
- **[满足]** AC5 不引入新的宿主耦合，不声明 Authority 为必选
  —— `authority-store.js` 仍只探测 `window.STAuthority.AuthoritySDK`，不可用时接口返回
  `null/false`，调用方无需分支，主路径不阻塞（L0-11 / L1-MR-1）。

### 残留去向（登记不做 · 未转交）

| 残留项 | 处置 | 理由（可复核） |
| --- | --- | --- |
| transfer API 迁移（去掉 base64 约 33% 体积膨胀与编解码 CPU） | **登记不做** | 需 Authority 服务端在线 + 高延迟环境才能满足本任务 AC2/AC3 的实测要求；09-24 已把内存峰值降到 `O(CHUNK_SIZE)`，剩余收益仅在云端网络体积/CPU，而 Authority 是**可选增强层**（L0-11 / L1-MR-1）——收益与验证成本不成比例 |
| 云端并发/重试参数 | **登记不做** | 同属「无实测环境则只能拍脑袋」，恰违反本任务 AC3 自身要求 |
| 「权限被拒」「传输中断」两类降级测试 | **登记不做** | 前者需 Authority 权限门禁环境；后者可单测模拟，但属独立主题，不搭车 |

**若要重启**：本文件 Requirements / AC 已非 `TBD`，可直接对某一条 `start` 独立实施，
或另开子任务；不得把「已登记不做」读作「已覆盖」。
