# 执行计划

> 每步完成即跑相关单测；三个提交边界对齐 prd Deliverables。详细规格见 `docs/superpowers/specs/2026-09-07-transfer-speed-task-control-filetree.md`。

## 提交① perf(core): OPFS streaming fetch + smart store compression + max workers

- [ ] 1.1 `src/core/zip-io.js`：`zip.configure` 增加 `maxWorkers: Math.max(4, HW)`（HW 兜底 4）
- [ ] 1.2 `src/core/zip-io.js`：新增导出 `entryCompressionLevel(fileName, userLevel)` + STORE_EXTENSIONS 静态表；`add/addLazy` 调 vendor `writer.add(..., { level })` 传入分流结果；report 增 `storeBypassCount/storeBypassBytes`
- [ ] 1.3 单测：`test/` 新增 entryCompressionLevel 分流表（无扩展名→userLevel、大写扩展名命中、非 Store 扩展名→userLevel）
- [ ] 1.4 `src/ui/host-bridge.js`：fetchHostBackup 手写 reader 循环 → OPFS writable（特性检测 `navigator.storage.getDirectory`），保 onPhase；返回 `{kind:'opfs', name, size}`；回退内存 Blob
- [ ] 1.5 下游 handleHostExport / runConversionTask 接受 Blob | OPFS 句柄（`getFile().getFile()` → File 直传）；任务完成/中止后清理 fetch-tmp
- [ ] 1.6 验证：`npm test` + vite dev 独立模式手测上传→转换→导出不回归

## 提交② feat(core): task manager with abort/pause/resume for fetch and convert

- [ ] 2.1 新增 `src/core/task-manager.js`：TaskManager 类（start/pause/resume/abort/get；AbortController；checkpoint 清单序列化；OPFS adapter 注入）
- [ ] 2.2 单测：状态机转换、并发/重复暂停幂等、abort 清理、checkpoint 节流
- [ ] 2.3 `src/core/transform.js`：`options.signal`（循环开头 aborted 检查）、`options.resumeCrcMap`（crc 命中 → entry.skip() + resumedCount）、`options.onEntryDone(path, crc32)`
- [ ] 2.4 Worker 路径：pause/abort 先 `worker.terminate()`；converter-worker PROGRESS 消息补 crc 字段，主线程 onProgress 消费同步
- [ ] 2.5 host-bridge 拉取接入：fetch signal、每 chunk 检查暂停→checkpoint→cancel+close；续传 Range → 非 206 整包重拉提示
- [ ] 2.6 UI：progress-container 内 task-controls（running→⏸/✕，paused→▶/🗑 + "已暂停于 45%（1.2GB/2.7GB）"文案）；写回宿主仅【中止】；style.css 双前缀
- [ ] 2.7 验证：`npm test` + dev 手测暂停/继续/中止/续传

## 提交③ feat(ui): unified file tree for host fetch and uploads

- [ ] 3.1 类目卡片 = 文件树父节点：类目行勾选框聚合态（全选/半选/未选），展开为 file-tree-picker 明细行；selection/excludedPaths 同树派生
- [ ] 3.2 宿主拉取接树：拉取落 OPFS → inspectArchive 扫描 → 渲染统一树 → 勾选确认 → convert(excludedPaths) → 产物进待导出区；按钮语义"拉取并选择"
- [ ] 3.3 降级：扫描失败/超时 >10s → ▸ 置灰"明细不可用，按类目勾选"
- [ ] 3.4 单测：文件树勾选聚合（父半选/子排除 → selection/excludedPaths）
- [ ] 3.5 验证：`npm test` 全量 147+ 绿 + dev 全流程（上传树、宿主树、降级路径）

## 收尾

- [ ] 全量 `npm test`
- [ ] `trellis-check` 全范围复查（跨 core/ui 层）
- [ ] spec 更新判断（trellis-update-spec）
- [ ] 三提交按序推送 origin

## 回滚点

- 每提交独立可回滚；②③依赖①的 OPFS 基建，①回滚需连带
- TaskManager 为纯新增模块，出问题可先摘除 UI 接线保核心转换稳定
