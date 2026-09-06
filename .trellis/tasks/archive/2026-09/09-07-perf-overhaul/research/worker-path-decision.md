# Worker 路径判定与基准数据（Phase 1 产出）

> 日期：2026-09-07 · Node v24.14.1 实测

## 1. vendor zip.js 内部机制（逐字节分析结论）

- `zip.configure({ createWorker })` **自定义工厂钩子可用**（内部 `if(a)o=a()` → `vn=!0`），且支持 `data:`/`blob:` URL worker —— 无需依赖 `workerURI` 相对路径文件（默认 `./core/web-worker-wasm.js` 相对页面解析，打包后必 404，虽有 fallback 但白跑）。
- Worker 启用门控：`useWebWorkers = !(全量读入/crc/加密) && codecOK && config.useWebWorkers`——**流式 add 天然走 Worker**。
- deflate 实现分层：优先原生 `CompressionStream('deflate-raw')`（`useCompressionStream:!0` 默认开），不可用时退到内嵌纯 JS 表 + worker/wasm。
- `chunkSize` 默认 65536，可通过 configure 调大。

## 2. 判定结论

**方案 A'（融合方案）**：
1. **主收益来自并发**，不是 Worker：串行队列是逐文件等待，zip.js `ZipWriter.add` 本身支持并发调用。改为 6 路滑动窗口即消除"一个一个文件处理"。
2. **压缩引擎用原生 CompressionStream**（浏览器/Node 18+ 均有，`useCompressionStream` 默认开启），它走独立内部线程池实现，无需自建 worker 池。vendor 的 worker 仅在"非原生 CompressionStream 回退到纯 JS 时"才有价值——为覆盖该场景，通过 `createWorker` 钩子注入 blob-URL 内联 worker 工厂（vendor 自带 worker 代码通过 import 拉取 codec，风险点是 wasm URI——留待失败时自动 fallback，不硬依赖）。
3. `configure` 调整：`useWebWorkers: true` + `createWorker` 内联工厂 + `chunkSize: 262144`。

## 3. 基准数据（Node 主线程，同机同负载）

### 微基准（20×256KB，level 5）
- 串行 createWriter：80ms

### 真实形态基准（500 条目 / 219MB：60×2MB 卡图 + 40×1.5MB 聊天 + 400×100KB 资产）

| 管线 | 耗时 | 产物 |
|------|------|------|
| 当前串行 level5 | **1257 ms** | 6 MB |
| 6 路并发预压缩 + Store 打包 | **370 ms**（238+132） | 5 MB |

**并发管线 3.4x 提速**（且此基准未含 UI 线程解放收益——并发 CompressionStream 在浏览器中不占主线程）。

### 500×~60KB 聊天文件（43MB）
- 当前串行管线 152ms；6 路并发预压缩 213ms（小文件场景并发收益被调度开销抵消，但也不劣化；实际收益来自与写入重叠）。

## 4. 设计修正（相对 design.md）

- 基准显示**预压缩 + Store 打包**（两阶段）比"边压边写"更优：压缩阶段全并发，打包阶段顺序写已压缩字节，互不阻塞。transform.js 的 addLazy 流式直通路径保留（pass-through 零拷贝场景），内存压缩条目改走"预压缩池"。
- `waitForRoom` 语义保持：等待在飞条目 < 高水位（预压缩池大小）。
- manifest 首条保序：add 队列首槽位。
