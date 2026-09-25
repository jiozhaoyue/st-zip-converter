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

---

## 收口取证（2026-09-25）

### 子任务验收矩阵（4/4 收口）

| 子任务 | 状态 | 交付形态 |
| --- | --- | --- |
| `09-23-extension-manifest-git` | 已归档 | **实现交付**（扩展清单语义 + Git 安装） |
| `09-23-perf-security-audit` | 已归档 | **报告交付**（`research/00-audit-index.md` + 四链路分片；父 OQ-4 由此回答） |
| `09-23-batch-restore-refresh` | 本次归档 | **无实施**：逐条取证 + 残留**转交新任务** |
| `09-23-authority-cloud-transfer` | 本次归档 | **无实施**：逐条取证 + 残留**登记不做**（理由见该子任务 PRD） |

### AC 逐条取证

- **[满足]** 父 PRD 明确任务边界、公开契约约束、降级策略和验收矩阵
  —— 边界/约束/降级见本文件 Requirements 与 Out of Scope；「验收矩阵」由上表 + 概念区分表补齐。
- **[满足]** 每个子任务有非 `TBD` 的 Requirements / Acceptance Criteria
  —— 4 个子任务 PRD 均非 `TBD`（两条本次归档者见上表「交付形态」列）。
- **[满足]** 文档区分「多选入工作区」「分卷 ZIP」「多次恢复」「原子合并恢复」「Authority 后台暂存」

  | 概念 | 是否存在 | 证据落点 |
  | --- | --- | --- |
  | 多选入工作区 | **有** | `src/ui/file-drop.js` 多选 → `index.js:1278` `onFilesReady(fileItems)` 循环批量入库（`:1283`） |
  | 分卷 ZIP（自包含合法包，非 `.z01` 裸分片） | **有** | `.trellis/spec/guides/tavern-datapack-formats.md:93` |
  | 多次恢复（逐卷） | **有 —— 公开契约下的唯一可行形态** | `index.js:1225` 单条目恢复；宿主无合并契约见下条 |
  | 原子合并恢复（分卷上传 → 服务端合并） | **不存在** | `.trellis/spec/guides/tavern-datapack-formats.md:194-204`：Luker 只接受单个完整包 |
  | Authority 后台暂存 | **有（可选增强层，不阻塞主路径）** | `src/storage/authority-store.js` |

- **[满足]** 验收计划中所有实例侧验证均限定 Dev 实例；Real 实例只读且需用户显式授权
  —— 两个已归档子任务的实机取证均在 Dev（`09-22-extension-git-slim` 走 Dev 8003）；
  本次收口无实例侧动作。
  ⚠ 口径提醒：`09-25-workbench-native-onesop` 曾获用户对 **8004 Real Luker** 的**定向**授权
  （「我让你做 real 就做，不要把数据搞坏就是约束」），该授权**不当然延续**到本仓默认口径。
- **[满足]** 后续实施开始前，用户批准对应子任务的最终规划摘要
  —— 两个已归档子任务走完该门；两条本次归档者由用户 2026-09-25 四问裁决替代，
  **裁决内容为「不实施、转交新任务 / 登记不做」**。

### 残留登记（跨子任务汇总 · 唯一权威处）

| 残留项 | 来源 | 去向 |
| --- | --- | --- |
| 批量恢复编排（状态机 + 非原子 UI 文案 + 刷新按钮 + 降级测试） | `09-23-batch-restore-refresh` AC2–AC5 | **新任务** |
| Luker 恢复端点悬置路径：`host-bridge.js:728` 固定 `/api/users/restore`（`platform` 形参 `:719` 只用于日志） | 本次取证副产品（该子任务 AC1 取证时发现） | **新任务**（用户裁决：按平台选端点 + 特性探测） |
| spec 条文更正：`tavern-datapack-formats.md:201` 称「插件在 Luker 下会隐藏恢复按钮（`#btn-restore-luker` = `display:none`）」—— **与现状不符** | 本次取证 | **新任务**（随端点修复一并更正；见下） |
| Authority transfer API 迁移 + 云端并发/重试 + 「权限被拒/传输中断」降级测试 | `09-23-authority-cloud-transfer` | **登记不做**，未转交；理由与该子任务 PRD 同文件 |

### 本次取证更正的一处 spec 错误（P-4 同形风险：静默错误比缺失更危险）

`.trellis/spec/guides/tavern-datapack-formats.md:201` 记「插件在 Luker 下**隐藏**恢复按钮
（`#btn-restore-luker` = `display:none`）」。现场取证反驳：

- `index.js:121` `restore: { visible: s.isHost && s.hasArtifact, … }` —— **无平台项**；
- `index.js:150` `apply(document.getElementById('btn-restore-luker'), a.restore)`；
- `workbench-template.js:265` 的 `display:none` 只是**初始态**（首屏无产物），
  `applyActionAvailability` 在产出转换物后会置 `display: ''`（`index.js:912` 读 `lastConvertedBlob` 为真）。
- 另一入口：待导出区每行「写回宿主」（`src/ui/export-queue.js:412`）。

→ 结论：**该按钮在 Luker 下是可达的**，`/api/users/install` 之外的这条恢复链在 L 上必然 404
（`/api/users/restore` 在 L 为 404，黑盒探测见 spec `:194-195`）。原「有意为之」的推断不成立，
按用户裁决在**新任务**中修复并同步更正该 spec 条文。
