# 扩展迁移与云端批量恢复优化

## Goal

统筹扩展清单与 Git、批量恢复、Authority 可选增强及性能安全审计，把云酒馆 / Luker 场景下的数据包导入恢复从“单包一次提交”推进为可观察、可降级、可验证的批处理体验。

## Background

- 现有 `src/ui/file-drop.js` 已支持多选 ZIP 并批量分析入工作区，但恢复路径 `restoreToHost()` 每次只把一个完整 ZIP 作为 multipart body 提交给宿主 `/api/users/restore`。
- 现有 `src/core/splitter.js` 可生成多个合法 ZIP 分卷（规避云酒馆约 100MB 单包限制），但宿主公开恢复端点并未提供“上传分卷 → 服务端合并 → 原子恢复”契约；分卷逐个调用恢复不是原子批量导入。
- Authority（ST-Delegation-of-authority）文档提供 transfer、Blob、私有文件、Jobs、Events 等可移植能力，但这些能力服务于 Authority 扩展隔离数据面，不能替代酒馆用户数据的原生恢复端点。
- 宿主刷新必须由酒馆公开 UI/API 或用户显式操作完成；不得拦截、改写或假定宿主内部逻辑。
- 相关既有任务：`09-22-extension-git-slim` 负责 `.git` 瘦身策略；`09-23-extension-manifest-git` 负责扩展清单语义。

## Requirements

- 维护父级任务地图，分别覆盖扩展清单/Git、批量恢复与刷新、Authority 云端传输、性能安全审计；每个子任务必须有独立可验证交付物。
- 任何云端 / 批量路径必须遵守纯前端优先与适配器降级（L0-11 / L1-MR-1）：Authority 不可用或权限不足时，本地 IndexedDB / 浏览器路径保持可用，不阻断现有转换与导出。
- 所有涉及宿主写入、刷新或恢复的方案必须以官方公开端点/文档为准（L1-MR-5）；缺少契约时先研究并形成报告，不得靠翻宿主源码直接实现。
- 性能与安全审计只形成带证据的报告和建议，未经单独批准不改宿主、不连 Real 实例（L0-1）、不提交任何用户真实数据（L1-MR-14）。
- 规划阶段必须保留待决问题，不把“分次上传”与“服务端合并原子恢复”混为一谈。

## Acceptance Criteria

- [ ] 父 PRD 明确任务边界、公开契约约束、降级策略和验收矩阵。
- [ ] 每个子任务有非 `TBD` 的 Requirements / Acceptance Criteria，复杂项另有 `design.md` / `implement.md` 或明确研究前置。
- [ ] 文档区分“多选入工作区”“分卷 ZIP”“多次恢复”“原子合并恢复”“Authority 后台暂存”等概念。
- [ ] 验收计划中所有实例侧验证均限定 Dev 实例；Real 实例只读且需用户显式授权。
- [ ] 后续实施开始前，用户批准对应子任务的最终规划摘要。

## Out of Scope

- 本任务不直接实现代码、不创建远程仓库、不安装依赖、不连接或修改酒馆实例。
- 不要求 Authority 为必选后端，不把转换计算迁移到 Authority Jobs。

## Open Questions

- OQ-1：宿主是否已有公开的分段上传/合并恢复接口或等价官方流程；若无，批量恢复是否只能逐个分卷恢复并在 UI 明示非原子性。
- OQ-2：恢复后“单次刷新”能否通过公开 API/事件完成；若只能由用户刷新，应如何设计明确的一键引导而不是拦截宿主。
- OQ-3：Authority 云端部署的传输上限、权限提示、重试与 SSE 事件是否足以承载大数据包暂存；需要哪些实测数据。
- OQ-4：现有代码安全/性能审计的优先级——`host-bridge.js` 恢复链路、`authority-store.js` base64 开销与传输、`splitter.js` 分卷内存模型、DOM 高频路径。
