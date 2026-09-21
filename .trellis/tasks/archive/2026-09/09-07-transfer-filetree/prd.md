# 传输提速+任务中止暂停断点续传+统一文件树

## Goal

解决宿主拉取"传输中"速度 <5MB/s 的问题；为长任务（宿主拉取/转换/写回）提供中止/暂停/断点续传能力；把"类目勾选"与"逐文件勾选"合并为一棵统一文件树并接入宿主拉取路径。

## Background

用户反馈宿主拉取速度慢，brainstorming 已定位根因（详见技术设计 `docs/superpowers/specs/2026-09-07-transfer-speed-task-control-filetree.md`，用户已逐节确认）：

1. 服务端 `createBackupArchive` 默认 deflate-6（服务端改造不在本插件实施，正文已交付）
2. 插件端全量缓冲内存（chunks.push → Blob）引发卡顿
3. vendor zip.js 默认仅 2 个压缩 Worker，未 configure maxWorkers
4. 长任务无任何中断/恢复控制；类目勾选与文件树是两套 UI，宿主拉取路径无文件级选择

## Requirements

### R1 传输提速（提交①）

- 拉取流直写 OPFS（`navigator.storage.getDirectory` 可用时 `response.body` 手写 reader 循环 → OPFS writable，保留 onPhase 回调），返回 `{ kind:'opfs', name, size }`；无 OPFS 回退现有内存 Blob 路径
- 下游统一接受 Blob | OPFS 句柄；OPFS 临时文件在任务完成/中止后清理，续传场景保留
- 智能压缩：`entryCompressionLevel(fileName, userLevel)` —— 已压缩扩展名（图片/音视频/数据库/再压缩包）Store 直存 level 0，文本/配置类仍用用户等级；report 增加 `storeBypassCount/storeBypassBytes`
- Worker 拉满：`zip.configure({ maxWorkers: Math.max(4, HW) })`

### R2 任务管理器（提交②）

- `src/core/task-manager.js` 纯状态机：state ∈ running|paused|aborted|done|failed；`start/pause/resume/abort/get`；每任务一个 AbortController，signal 透传 fetch 与 zip.js
- 断点清单持久化 OPFS `checkpoints/<id>.json`（拉取：receivedBytes+opfsName；转换：sourceCrcRef+doneEntries path→crc32）；OPFS 副作用注入 adapter（模块可单测）
- 拉取接入：fetch 加 signal；每 chunk 检查暂停 → checkpoint → cancel；续传优先 Range，端点不支持（非 206）→ 整包重拉并提示
- 转换接入：`convert()` 增加 `options.resumeCrcMap` + `options.signal`；crc 命中 → skip + `resumedCount`；`onEntryDone(path, crc32)` 节流持久化（每 64 条或 2s）；Worker 路径 pause/abort 先 terminate，PROGRESS 消息补 crc 字段
- UI：进度条旁任务控制条 running→【暂停】【中止】paused→【继续】【丢弃】+ 状态文案；写回宿主仅支持中止

### R3 统一文件树（提交③）

- 类目卡片 = 文件树父节点：类目行保留勾选框（全选/半选/未选聚合），展开为逐文件明细行；勾类目=全选其下文件；`selection` 与 `excludedPaths` 由同一棵树派生
- 宿主拉取接树（先扫描后拉取）：拉全量包落 OPFS → `inspectArchive` 只读扫描渲染树 → 用户勾选 → `convert()` 以 excludedPaths 过滤 → 产物进待导出区
- 【从宿主拉取】按钮语义变为"拉取并选择"；默认全选确认 = 现状行为
- 降级：扫描失败/超时 >10s → 树不可展开（▸ 置灰提示"按类目勾选"），类目勾选仍生效

## Constraints

- `src/core/` 禁止 DOM 依赖（TaskManager 纯状态机 + adapter 注入）
- vendor zip.js / fzstd 本地副本不可升级改动，只可用其已有 API（signal/configure/crc32/per-entry level 均已验证存在）
- style.css 双前缀铁律（`.app-container` / `.st-converter-drawer-app`）；配色继承宿主变量
- 浏览器 API 特性检测 + 回退（OPFS / Range）
- 严禁写入本地酒馆实例目录；实例更新只走 Git

## Acceptance Criteria

- [ ] 单测：entryCompressionLevel 分流表（含无扩展名、大写扩展名）；TaskManager 状态机（含并发/重复暂停）；convert resumeCrcMap 跳过与 resumedCount；文件树勾选聚合（父半选/子排除 → selection/excludedPaths）
- [ ] 全量 `npm test` 147+ 绿
- [ ] OPFS 拉取：浏览器真机验证流式落盘、任务完成/中止后临时文件清理
- [ ] 暂停/继续/中止全流程手测；续传 crc 跳过生效（resumedCount > 0）
- [ ] 统一树：宿主拉取路径出现文件级勾选，未勾选文件不进产物；扫描失败降级为不可展开树
- [ ] 独立模式与插件模式均不回归（现 137 项测试 + 现有手测路径）

## Deliverables

- 提交① `perf(core): OPFS streaming fetch + smart store compression + max workers`
- 提交② `feat(core): task manager with abort/pause/resume for fetch and convert`
- 提交③ `feat(ui): unified file tree for host fetch and uploads`
