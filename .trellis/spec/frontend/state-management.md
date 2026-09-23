# State & Memory Management (Browser Plugins)

> 状态分层、Blob 生命周期、长任务断点与内存泄漏防治。

---

## Overview

状态分四层，职责与生命周期各不相同——改代码前先确认自己在哪一层：

| 层 | 载体 | 生命周期 | 位置 |
| --- | --- | --- | --- |
| 易失 UI 状态 | DOM / 内存变量 | 页面刷新即失 | `src/ui/view.js`、各控件模块 |
| 待导出区（内存队列） | `ExportQueue.items`（持有 Blob） | 页面刷新即失 | `src/ui/export-queue.js` |
| 长任务状态机 | `TaskManager` + checkpoint adapter | 跨暂停/续传 | `src/core/task-manager.js` |
| 持久层 | IndexedDB / OPFS /（可选）Authority | 跨刷新 | `src/storage/db.js`、`src/storage/authority-store.js` |

- IndexedDB（`src/storage/db.js`，`DB_VERSION = 2`）的 `files` store 带 **`origin`** 字段区分来源：
  `upload` / `host-export` / `converted` / `delta` / `split-part`（同文件 `ORIGINS`）。v1 记录在
  `onupgradeneeded` 中按 `role` 无损映射到 v2 `origin`。
- `authority-store.js` 是**可选后端适配器**：探测不到 `window.STAuthority.AuthoritySDK` 时
  全部接口返回 `null` / `false`，调用方无需分支——**不得**让纯前端主路径依赖它。

---

## State Lifecycle of an Export Operation

```
Idle → 宿主拉取(/api/users/backup) 或本地读入 → 规划(plan) → 转换(convert)
     → 入待导出区(ExportQueue) → 用户处置：下载 / 存工作区 / 写回宿主 / 移除 → Idle
```

1. **Idle**：按钮可用，状态面板为空。
2. **进行中**：状态文本更新；转换/传输期间必须防重复点击。
3. **完成**：产物入**待导出区**（`export-queue.js`）——**不自动下载**。
4. **处置**：用户逐条或批量选择 下载 / 存入工作区 / 写回宿主 / 移除。

**产物统一出口约定（违反即返工）**：转换、宿主拉取、增量补丁、分卷切片产物一律先入
`ExportQueue`；`autoDownload` 仅作兼容旧习惯的显式开关。队列条目
`{ id, name, blob, targetLayout, origin, ephemeral, autoDownload }` 中 `ephemeral = true`
表示「仅下载不入库」——下载动作发生时才写入 IndexedDB；`stash()` 把临时条目永久入库，
`remove()` 连带清理。队列渲染走 rAF 合帧，批量转换时不得同步逐条重建整表。

---

## Memory Leak Prevention in Long-Running Tabs

Users often keep SillyTavern or Luker browser tabs open for days. Accumulating zip blobs in memory can trigger browser tab crashes.

用户常把酒馆标签页开上好几天，内存里累积的 zip Blob 会把标签页拖垮：

### 1. 不得把 Blob 挂到全局或长生命周期对象上

```javascript
// FORBIDDEN —— 页面级驻留的 GB 级 Blob
window.lastExportedBlob = blob;
```

Blob 应严格限定在产生它的函数作用域内；跨步骤传递用 `ExportQueue` 条目或 IndexedDB 记录
（`saveFile` / `getFile`），用完即 `deleteFile`。

### 2. Object URL 必须定时撤销

Object URL 会持有底层 Blob 直到显式 `revokeObjectURL`。全仓现行实现与时限：

| 场景 | 位置 | 撤销时限 |
| --- | --- | --- |
| 普通下载 / 另存 | `triggerBlobDownload`（`export-queue.js`）、`stash-list.js`、`archive-manager.js`、`view.js` | 60s |
| 拖出（drag-out `DownloadURL`，仅 Chromium） | `setDragOutPayload`（`export-queue.js`） | 120s（拖放过程可能很长） |
| 分卷交付弹窗 | `split-deliver-modal.js` | 用后立即撤销 |

「选位置导出」优先 File System Access API（`window.showSaveFilePicker` + `createWritable`，
见 `exportToLocation`），**必须特性检测**；不支持或用户取消时回退普通下载。

### 3. 流式读写统一经 `src/core/zip-io.js`

IO **不再有** Node / 浏览器双适配器（旧的 `node-io`(yauzl/yazl) / `zipjs-io` 与
`test/zipjs-io.test.js` 均已删除）。现行唯一门面是 `zipIo`（封装 `src/vendor/zip.js` +
`src/vendor/fzstd.js`；vendor 副本**勿升级改动**，只用其已有 API）：

- 读：`zipIo.openReader(source)` 接受 Blob / File / 路径字符串，返回带 `entries()` 异步迭代器
  的对象（内部是 `zip.BlobReader` + `ZipReader`，不把整包读进 `ArrayBuffer`）。
- 写：`zipIo.createWriter(target, { level })` + 惰性流直通（`addLazy`），不在 JS 堆里囤中间字节数组。
- `STORE_EXTENSIONS`（png/jpg/mp4/db/zst… 已压缩扩展名）自动降级 `level = 0`（Store 直存）。
- Method 93（TauriTavern 的 7-Zip ZS / Zstandard）由 `src/vendor/fzstd.js` 注册为透明解压 codec。

---

## Long-Task State: TaskManager + OPFS Half-Products (2026-09-07)

长任务（宿主拉取 / 转换 / 写回）由 `src/core/task-manager.js` 管理——**纯状态机**，持久化经
注入的 adapter（OPFS 或 Authority KV），core 无 DOM / 存储依赖；UI 控制在 `src/ui/task-controls.js`。
状态：`running | paused | aborted | done | failed`（`TASK_STATES`）。

### OPFS 半成品生命周期（拉取任务）
- 流式拉取写入 OPFS `fetch-tmp/<taskId>.zip`——**绝不**在内存里缓冲 GB 级响应体
  （`chunks.push` + `new Blob(chunks)` 只是无 OPFS 时的降级兜底路径）。
- **暂停语义**：close 可写流而**不** abort，让半成品留存；断点清单
  `{ receivedBytes, totalBytes, opfsName }` 经 adapter 落盘。
- **续传**：先发 `Range: bytes=<received>-`；响应非 206 说明端点不支持 Range →
  作废半成品、从零重拉。
- **中止/丢弃**：`opfsTmpCleanup` 删临时文件；成功路径由下游 `opfsHandleToFile()` 取 File
  交给 zip.js（其原生接受 File），随后清理。
- catch 块里引用的变量必须在 `try` **之外**声明——声明在 `try` 内的 `opfsName` 会在错误路径
  触发 TDZ `ReferenceError`。

### 共享 Worker + AbortSignal 陷阱（2026-09-07 实际踩过）
`worker-client.js` 复用一个 `Worker` 实例。暂停/中止时调用 `worker.terminate()`——
被 terminate 的 Worker 会**静默忽略**此后所有 `postMessage`。
**规则**：`terminate()` 之后必须 `workerInstance = null`，让下一个任务重建 Worker
（现行实现见 `src/core/worker-client.js` 里 `terminate()` 与 `workerInstance = null` 相邻两行）。
漏掉这一步会让**此后每一次转换永久静默挂死**（不报错，只是不动）。
另外 `AbortSignal` 本身**不能** `postMessage`——须从序列化 options 里剥离，改在主线程监听。

### 高频进度回调必须 rAF 合帧（2026-09-07 实际踩过）
流式拉取约 50 chunk/秒；每个 chunk 同步调 `setProgress` 在 20 秒内累积出 14 个 80–107ms
长任务（实机测量），宿主整页卡顿。**规则**：进度类 DOM 写入必须经 `requestAnimationFrame`
合帧（取最新值）。现行合帧点只有三处，改动高频回调时对照检查：
`src/ui/view.js`（进度）、`src/ui/export-queue.js`（队列表格）、`src/ui/log-console.js`（日志批量 flush）。
任何新增的 per-chunk / per-entry 回调只要接 DOM，同样必须合帧。

### Luker 备份 selection 陷阱
`selection.settings = true` 会让服务端连带打包 `data/<user>/backups/`（历史快照目录）——
2GB 的 backups 目录能把「只要设置」的拉取变成 1.4GB 全量下载（实测约 16MB/s，服务端
archiver deflate-6 是上限）。拉取前须提示用户；解法是裁剪快照或取消勾选 settings，
而非改插件。
「待验证」：该行为来自 2026-09-07 实机测量，未在本仓代码中体现（代码只是原样发送
selection）；复测方法：在 Dev Luker（8003）勾选 settings 后观察响应 `Content-Length`。
