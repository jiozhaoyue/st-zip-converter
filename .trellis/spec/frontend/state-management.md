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

长任务由 `src/core/task-manager.js` 管理——**纯状态机**，持久化经
注入的 adapter（OPFS 或 Authority KV），core 无 DOM / 存储依赖；UI 控制在 `src/ui/task-controls.js`。
状态：`running | paused | aborted | done | failed`（`TASK_STATES`）。

⚠️ **接线路数（2026-09-27 逐条取证，勿凭印象）**：已接 `TaskManager` 的是
**宿主拉取**（`handleHostExport`，`index.js`）与**转换 / 批量转换**（`handleExternalConvert` /
`handleBatchConvert`，R-16 修复后接入）。
**「写回宿主」不走 `TaskManager`** —— 它有自己的状态机 `src/core/restore-batch.js`
（`createRestoreBatch`，`index.js` 顶部 import）与 `host-bridge` 的 `restoreInFlight` 互斥标志；
`taskControls` 一次只展示一个**任务**，而写回批次由待导出区的 `.eq-restore-bar` 呈现
（见 `component-guidelines.md` 的 Export Queue 一节）。
（原句写作「长任务（宿主拉取 / **转换** / **写回**）由 `TaskManager` 管理」——
「写回」那半句**从来不是事实**，2026-09-27 更正。）

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

---

## 转换路径的断点续传（2026-09-27 · R-16 修复后定稿）

**结论先行**：`TaskManager` 现在**真的**接管了三条路径（宿主拉取 / **转换** / **批量转换**）——
上方 §Long-Task State 的那句话（「长任务（宿主拉取 / 转换 / 写回）由 `TaskManager` 管理」）
在 R-16 之前**只对宿主拉取成立**（转换路径压根不碰 TaskManager，`onResume` 只认 `fetch-` 前缀）。
本节记录**为什么这条容易写成假的**。

### 1. 断点落盘**只能**挂 `onProgress`（本仓最隐蔽的一处）

`runConversionTask({source, target, options, onProgress, onEntryDone})` 的 `onEntryDone`
是**顶层参数**（`src/core/worker-client.js:92`），只被传进**主线程降级分支**（`:107`）；
Worker 分支走 `postMessage`，**函数过不了结构化克隆** ⇒ **真浏览器里永不触发**。
`worker-client.js:89` 的 JSDoc 原文：

> `@param {function} [params.onEntryDone] (源条目名, crc32)`——主线程路径直通；**Worker 路径由 onProgress 累积**

而 `supportsWebWorker()`（`worker-client.js:9-11`）=
`typeof window !== 'undefined' && typeof Worker !== 'undefined'`
⇒ **浏览器 = Worker 路径（该回调死）/ Node·Vitest = 主线程路径（该回调活）**。

**若把落盘改挂到 `onEntryDone`**：浏览器里断点**永不落盘** ⇒ 暂停后无法续传（= R-16 原样未修），
而 `npm test` **全绿** —— **缺陷被测试掩盖**。这正是本仓最怕的形态。

**守护必须两条，缺一不可**（单测跑不到 Worker 路径）：

1. `test/convert-resume-wiring.test.js` 的「Worker 路径回调契约」：**只按 Worker 的签名调用**
   （只调 `onProgress`）并断言断点仍被喂到。实测判别力：去掉 `maybeCheckpoint` 调用 ⇒ **2 项转红**。
2. **E2E（真浏览器 / 真 Worker）**：矩阵 M-7b 真实 pause → resume，断言日志含「沿用断点跳过 N 项」。

### 2. 断点清单的方向纪律：**滞后可以，超前不行**

快照**只含已完成条目**。滞后 ≤63 条 ⇒ 续传时那 ≤63 条被**重做**（安全）；
若**超前**（把未完成条目也算进去）⇒ 续传时被**错误跳过** ⇒ **产物缺条目**。

### 3. 落盘必须节流，且**首次一定落**（两条都是载荷属性）

- **节流**（`createCheckpointThrottle`，`index.js`）：`Object.fromEntries(doneEntries)` 是 O(n)，
  每 tick 都建 = **O(n²) + 大量短命对象**（8683 条目 ≈ 7500 万次属性分配 ⇒ GC 压力与长任务）。
  节流常数与 `src/core/task-manager.js:23-25` **同源**（64 条 / 2000ms），**不另立一套数字**。
  **未到窗口连 `onCheckpoint` 都不调** —— 这是与「只在 `adapter.save` 处节流」的关键差别。
- **首次调用一定落盘**（`lastFlushAt` 初值 0 ⇒ 时间条件立刻成立）——**不是 bug，别「修掉」**：
  `TaskManager.pause()` 落盘的是**内存里的 `task.checkpoint`**，它只在 `onCheckpoint`
  **被调用时**才更新 ⇒ 若首次被节流掉，「任务刚开始就暂停」会因 `checkpoint === null`
  而 `resume()` 返回 null ⇒ **无法续传**。`test/convert-resume-wiring.test.js` 有专门用例锁定。

### 4. 续传命中怎么观测

字段是 **`report.totals.resumed`**（计数；`report.resumed` 是命中条目**名单**）。
**没有 `resumedCount` 这个字段** —— 仓里曾有 JSDoc 与用例名这么写，**全仓零赋值零读取**
（2026-09-27 订正）。`index.js` 的 `resumedNote(report)` 把它渲染进成功日志，E2E 据此断言。

### 5. 任务类型判据是**唯一**的：`taskKindOf(id)`

`index.js` 的 `TASK_KINDS` / `TASK_PREFIX` / `taskKindOf` 是**全仓唯一**的任务类型判据；
`onResume` 经 `RESUMABLE_HANDLERS` **查表分派**。**任何地方都不得再写 `id.startsWith('fetch-')`**
（同一判据两处实现 = 立即漂移）。

⚠️ **必须按前缀长度降序匹配**：`convert-batch-` 与 `convert-` **前缀重叠**，
按声明顺序遍历会让 `convert-batch-<ts>` 被 `convert-` 先吃掉 ⇒ **静默降级成单包语义**
（断点字段读不到、恢复走错执行体，且**不报错**）。实现里**显式 `sort`**，
**不依赖对象字面量的插入顺序**（有人重排常量时会无声失效）。
`test/task-kind.test.js` 有一条性质断言锁定这一点。

### 6. 批量转换：一个任务 + 子项游标（**两条前提 + 一条中止纪律**）

形态：**一个** `convert-batch-<ts>` 任务（不是每子项一个任务 —— `taskControls` 一次只展示一个
活动任务，N 个控制条会让用户心智断裂）。断点清单
`{kind, itemIndex, outputs, doneEntries, itemIds, totalItems}`。

1. **`doneEntries` 每个子项必须重置**（`seedEntriesFor`）：不同源包几乎必然含**同名条目**
   （`settings.json`、`characters/*.png`）⇒ 跨子项复用 crc 清单会让第二个子项**错误跳过**
   ⇒ **产物缺条目**。
2. **续传前必须验「产物还在」**（`batchResumeVerdict`）：产物是 `ephemeral`（**只在内存**
   `ExportQueue.items` 里），断点却**持久化** ⇒ 两者可能不一致。
   判据取**真实依赖**（按 `taskId` 数内存队列里的产物），**不用**「会话是否同一个」这类**代理量**
   —— 代理量在「同会话但用户手动删了产物」时误判为可续。
   不成立即**作废断点并重跑整批**，**绝不硬续**：硬续会跳过产物已丢失的子项 ⇒
   **静默产出残缺批次**（无回滚，只能前置拦截）。
3. ⚠️ **循环内 `AbortError` 必须终止批次**：其余错误「记日志继续」是既有语义
   （单个坏包不该打断整批），但暂停/中止是**用户意图** —— 而现状的 `catch { logger.error }`
   会**吞掉 `AbortError` 并继续跑下一个包** ⇒ 界面显示「已暂停」而后台还在跑，
   且断点游标与实际进度脱节。实现：`runBatchItems` **原样上抛** `AbortError`（可观测结果与 `break` 等价）。

### 7. 批量的**入口**曾是死代码（U-7 的教训）

`runBatchConversion` 在 2026-09-27 之前是**无调用者的死代码**（`grep -rn runBatchConversion`
只有定义 + 注释），而 `README.md:74` 承诺了「批量转换」—— 与 R-16 同族的「承诺有、入口无」。
现入口在**暂存区批量栏**（`src/ui/stash-list.js` 的 `onBatchConvert` 接缝，
启用判据 `cap.canBatchConvert = n > 0`）。

⚠️ **不要复用 `cap.canLoad` 作批量判据**：它是 `n === 1` 的**单选**语义，
误用会让「选 2 个以上」时按钮被**禁用** —— 而批量恰恰只在多选时才有意义。
`test/stash-list.test.js` 有专门用例锁定。**新增面向用户的能力时，先确认它有可达入口**，
否则「修好了但用户碰不到」也是一种未完成。
