# 技术设计：传输提速 + 任务控制 + 统一文件树

> 权威设计文档：`docs/superpowers/specs/2026-09-07-transfer-speed-task-control-filetree.md`（brainstorming 产出，用户已逐节确认）。本文件只补充工程落地要点，避免双源漂移；冲突时以 specs/ 版本为准。

## 架构边界

| 模块 | 层 | 职责 | DOM 依赖 |
|------|---|------|----------|
| `src/core/zip-io.js` | core | maxWorkers configure、entryCompressionLevel、writer per-entry level | 禁止 |
| `src/core/task-manager.js`（新增） | core | 纯状态机 + checkpoint 清单管理 | 禁止（OPFS 走注入 adapter） |
| `src/core/transform.js` | core | `options.signal` / `options.resumeCrcMap` / `onEntryDone` / `resumedCount` | 禁止 |
| `src/ui/host-bridge.js` | ui | OPFS 流式 fetch（手写 reader 循环保留 onPhase）、Range 续传、Blob\|OPFS 双返回 | 可 |
| `src/ui/export-queue.js` / `index.js` | ui | 任务控制条 UI、统一树接线 | 可 |
| `src/ui/file-tree-picker.js`（现有组件复用） | ui | 统一树的逐文件明细行 | 可 |

## 关键决策

1. **OPFS 直写而非内存 Blob**：GB 级包不再全量缓冲；返回句柄描述 `{kind:'opfs', name, size}`，下游 `runConversionTask` 用 `getFileHandle().getFile()` 得到 File 直传（zip.js 原生吃 File）。
2. **Store 直存判定在 zip-io 层**：扩展名集合静态表 + `entryCompressionLevel()` 纯函数导出，`add/addLazy` 内部统一走 per-entry level；不改变现有 `createWriter({level})` 对外签名语义（用户等级仍作用于非 Store 条目）。
3. **TaskManager 纯状态机**：state 转换 + AbortController 生命周期 + 清单序列化都在 core；OPFS 读写、UI 通知通过构造/注入 adapter。暂停语义 = checkpoint 落盘 → abort → state=paused，半成品保留待续传。
4. **续传尽力而为**：Range 请求非 206 或不支持 → 整包重拉（半成品作废）。转换续传靠 crc32 清单 skip，天然可靠。
5. **统一树派生双通道**：`selection[cat] = 该类目至少一个文件被勾`；文件级差异走 `excludedPaths`。不删除现有 selection 概念，转换入口签名不变。
6. **宿主拉取先全量后过滤**：端点不支持文件级导出（ST/Luker 同），过滤在本地 `convert()` excludedPaths 完成，零额外网络成本；不勾任何文件=现状行为。

## 兼容与回退

- 无 OPFS（旧 Firefox）→ 现有内存 Blob 路径原样保留
- 无 Worker（Node 测试）→ vendor 自动主线程退化，maxWorkers 配置无害
- 扫描失败/超时 10s → 树 ▸ 置灰"明细不可用，按类目勾选"，类目勾选仍生效
- `showSaveFilePicker`/drag-out 等已有特性检测不受影响

## 风险

- zip-io `firstEntryDone` 保序语义与 per-entry level 交互：manifest 首条仍先落盘，仅改 level 不改顺序
- Worker 路径 crc32 透传需要 converter-worker PROGRESS 消息格式变更——主线程 onProgress 消费端同步更新
- OPFS `createWritable()` 在同文件并发写会抛 NoModificationAllowedError：临时文件名按 taskId 命名天然隔离
