# 调研：导出性能瓶颈分析与重写方案依据

> 调研日期：2026-09-07 · 基于插件源码逐行分析 + 本地实例端点实现

## 1. 用户报告的症状

1. 宿主导出"时间太长"（日志 `向宿主发起数据包导出请求...` 后长时间无响应）。
2. "直出写入太慢……一个一个文件处理？"——属实，见 §2。
3. "插件弄得特别卡"——主线程被压缩计算占满，见 §3。

## 2. 写入管线瓶颈（已证实）

`src/core/zip-io.js` 关键事实：

1. **`zip.configure({ useWebWorkers: false })`（第 11 行）**：所有 deflate 压缩在 UI 主线程执行。zip.js 本身支持 Web Worker 多线程（vendor 内 `useWebWorkers: !0` 默认开启、`maxWorkers` = hardwareConcurrency），被这行显式关死。
2. **`createWriter` 串行队列（第 106-137 行）**：`enqueue` 把每个 `writer.add` 挂到 `queue = queue.then(task)` 链上，严格逐文件执行。大包（数万文件）时每个文件都要等前一个完成。
3. **全量读入内存再写（第 120 行）**：`writer.add(name, new zip.Uint8ArrayReader(new Uint8Array(data)))`——`transform.js` 走 `addLazy` 时是流式 pipe（这部分尚可），但 `writer.add` 路径（manifest、合成 JSON、`emitSynthesized`）与 `addLazy` 的 TransformStream（`highWaterMark: 1`）背压极小，实际仍近似串行。
4. **level 默认 5**：deflate-5 在主线程单核上对 1GB+ 数据包耗时分钟级。
5. **宿主导出慢的另一层**：`fetchHostBackup` 是宿主端点同步生成整个 zip 再返回（ST `src/users.js:1152` archiver 流式，但浏览器 `response.blob()` 要等全量收完才 resolve）——宿主生成时间 + 网络传输时间 + 插件后续 transform 重压缩时间三段叠加，UI 上只显示一条 10% 进度日志。

## 3. "实例卡顿"插件侧嫌疑清单（待排查证实）

- 压缩在主线程 → 转换/导出期间宿主 UI 整体冻结（60fps 掉光）。converter-worker.js 存在但 `useWebWorkers: false` + zip 内部 worker 关闭，收益被抵消。
- 日志洪泛：`logger` 对每个条目/每步都 `logger.info`，大包时 DOM 追加数千行（log-console.js 滚屏渲染）。
- IndexedDB 大 Blob 读写发生在主线程事件循环（blob.slice 分块 put），大包暂存时阻塞。
- zip.js `chunkSize: 65536` 偏小，大文件条目流式循环次数多。
- 内存峰值：`read()` 全量读入 + Uint8Array 拷贝两份。

实例侧（非插件）因素只出报告：其他扩展、宿主自身、GPU 合成等，用 Playwright Performance trace 定位。

## 4. 重写方案要点（子任务 2 design 输入）

1. **启用 zip.js Web Worker**：`zip.configure({ useWebWorkers: true, maxWorkers: navigator.hardwareConcurrency })`；vendor 自带 `core/web-worker-wasm.js` 但作为 ES module 内联打包时 workerURI 需指向可访问 URL——需验证 vite build 后 worker 路径（`worker.format: 'es'` 已配置）。若 vendor 内联导致 workerURI 失效，方案 B：自建 worker 池，把 deflate 流送入 OffscreenCanvas 不可行，改为 `new Worker(new URL('./converter-worker.js', import.meta.url), { type: 'module' })` 模式（vite 原生支持）。
2. **并行写入**：zip.js `ZipWriter.add` 天然支持并发调用（内部有锁），移除自建串行队列，改为并发度 N（4~8）的滑动窗口；保持 `written` 去重与顺序敏感条目（manifest.json 首条）的特殊处理。
3. **流式直通**：pass-through 条目（直通/复制类）用 `entry.getData(writable)` 直接 pipe 到 `writer.add(name, readable)`，零拷贝不落内存；仅合成/转换条目走内存。
4. **存储级别**：level 0（Store）时跳过 deflate 完全直通字节。
5. **日志节流**：log-console 渲染按帧合并（requestAnimationFrame 批量 flush），单条日志限流。
6. **回归底线**：105 项测试全绿 + zipjs-io 同构性测试 + secrets 字节一致测试必须保留通过；用 `fixtures/gen.js` 生成 1GB 级基准包，Playwright 采集转换耗时与主线程长任务（Long Task >50ms 计数）对比优化前后。

## 5. 宿主导出慢的缓解（配合 ui-unify）

- `fetchHostBackup` 期间展示宿主生成→传输→处理三段式进度（用 `response.body` 流式读取 + Content-Length 估算下载进度）。
- 宿主拉全量包后，ST 宿主的类目筛选改在插件内 transform 过滤（Luker 透传 selection）——见 host-detect 调研 §3。
