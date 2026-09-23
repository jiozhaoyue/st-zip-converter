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
