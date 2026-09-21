# 执行计划

> 每步完成即跑相关单测；三个提交边界对齐 prd Deliverables。详细规格见 `docs/superpowers/specs/2026-09-07-transfer-speed-task-control-filetree.md`。
>
> **状态（2026-09-21 核对）**：三提交全部落地，全量测试 187 过 / 2 跳过。commit ①=`7462523`、②=`82ea011`、③=`ce1c70f`（后续修复 `034b7ab` workerInstance 重置 + opfsName 提升）。

## 提交① perf(core): OPFS streaming fetch + smart store compression + max workers ✅ `7462523`

- [x] 1.1 `src/core/zip-io.js`：`zip.configure` 增加 `maxWorkers: Math.max(4, HW)`（L28）
- [x] 1.2 `entryCompressionLevel(fileName, userLevel)` + STORE_EXTENSIONS（L35/47/160）；report 增 storeBypassCount/storeBypassBytes
- [x] 1.3 单测：`test/smart-compression.test.js` 分流表覆盖
- [x] 1.4 `src/ui/host-bridge.js`：fetchHostBackup OPFS 流式落盘 + 内存 Blob 回退
- [x] 1.5 下游接受 Blob | OPFS 句柄；fetch-tmp 清理
- [x] 1.6 验证：`npm test` 绿

## 提交② feat(core): task manager with abort/pause/resume for fetch and convert ✅ `82ea011`

- [x] 2.1 `src/core/task-manager.js`：TaskManager 状态机 + AbortController + checkpoint 序列化 + OPFS adapter 注入
- [x] 2.2 单测：`test/task-manager.test.js` 状态机/并发/幂等/abort 清理
- [x] 2.3 `src/core/transform.js`：`options.signal` / `options.resumeCrcMap` / `options.onEntryDone`（L184-220, 552）
- [x] 2.4 Worker 路径 pause/abort 先 terminate；PROGRESS 补 crc（后续修复 `034b7ab`）
- [x] 2.5 host-bridge 拉取 signal + checkpoint + Range 续传
- [x] 2.6 UI：task-controls（index.js 13 处接线）
- [x] 2.7 验证：`test/convert-resume.test.js` 续传跳过生效

## 提交③ feat(ui): unified file tree for host fetch and uploads ✅ `ce1c70f`

- [x] 3.1 类目卡片=文件树父节点，勾选聚合，selection/excludedPaths 同树派生（`src/ui/file-tree-picker.js`）
- [x] 3.2 宿主拉取接树（拉取→扫描→勾选→convert）
- [x] 3.3 降级：扫描失败置灰按类目勾选
- [x] 3.4 单测：`test/unified-tree.test.js` 勾选聚合
- [x] 3.5 验证：`npm test` 全量 187 绿

## 收尾

- [x] 全量 `npm test`（187 过 / 2 跳过，2026-09-21）
- [ ] `trellis-check` 全范围复查
- [ ] spec 更新判断（trellis-update-spec）
- [ ] 归档任务

## 回滚点

- 每提交独立可回滚；②③依赖①的 OPFS 基建，①回滚需连带
- TaskManager 为纯新增模块，出问题可先摘除 UI 接线保核心转换稳定
