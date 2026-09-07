# 技术设计：传输提速 + 任务中止/暂停/断点续传 + 统一文件树

> 2026-09-07 · brainstorming 产出 · 用户已逐节确认
> 前置：`2026-09-07-workbench-two-block-redesign.md`（已实施）。本设计在其两块式结构上继续演进。

## 0. 背景与调研结论

### 0.1 传输慢的根因定位（实测源码证据）

用户反馈宿主拉取"传输中"速度 <5MB/s。链路排查：

- **服务端压缩是主因**：Luker `src/users.js:1475` 与 ST `src/users.js:1152` 的
  `createBackupArchive` 均为 `archiver('zip')` **默认 deflate-6**，GB 级聊天记录/角色卡图片
  边压边发。进度条"宿主正在打包"阶段实际在等服务端压缩，"传输中"速度 = 压缩+传输混合速度。
- **插件端内存放大**：`src/ui/host-bridge.js:229` `chunks.push` → `new Blob(chunks)`，
  GB 级包全量缓冲内存，引发拷贝卡顿。
- **vendor 并发未拉满**：`zip-io.js` 自算 CONCURRENCY（2~8）但未传 `zip.configure({ maxWorkers })`，
  vendor 默认 2 个压缩 Worker。
- 两宿主端点均无压缩等级开关（源码确认无 store 选项、无 Range 续传支持；
  Luker 是 archiver 动态流，固定文件+Range 下载需要服务端新增端点）。

### 0.2 服务端改造方案（正文交付，不在本插件实施）

```js
// Luker / ST src/users.js — createBackupArchive
const archive = archiver('zip', { store: true });
// 或可配: { zlib: { level: getConfigValue('backups.zipLevel', 6) } }  // config.yaml: backups.zipLevel: 0
```

`store` 后服务端只读文件塞容器不压缩，速度受限于磁盘+网络（千兆内网基本跑满）。
建议做成 `config.yaml` `backups.zipLevel` (0~9)。需 Docker 重建或 git pull 实例。
本插件提速不依赖此项。

### 0.3 已验证的底层能力

- vendored zip.js 原生支持：`signal`（AbortSignal，add/getData 均可传）、
  `configure({ maxWorkers })`、per-entry `level` 覆盖（Store 0）、`passThrough`、
  reader 条目 `crc32` 属性。
- `convert()` 已支持 `excludedPaths`（文件级排除）与 `selection`（类目级）双通道。
- `inspectArchive` 只读中央目录，扫描成本低。
- 现有 file-tree-picker + category-filter 已有逐文件勾选/排除/半选逻辑，
  但只在"上传包有当前源"时出现，宿主拉取路径未接。
- OPFS（`navigator.storage.getDirectory()`）浏览器支持良好，Firefox 旧版需回退。

## 1. 传输提速（提交 ①）

### 1.1 拉取流直写 OPFS

`src/ui/host-bridge.js` fetchHostBackup 改造：

- 浏览器且 `navigator.storage.getDirectory` 可用时：
  `response.body.pipeTo(opfsWritable)`（`getDirectoryHandle('fetch-tmp', {create:true})`
  → `getFileHandle(<taskId>.zip, {create:true})` → `createWritable()`），
  reader 循环改为手写（keep onPhase 回调），收完返回 OPFS FileHandle 句柄描述
  `{ kind: 'opfs', name, size }` 而非 Blob。
- 回退路径：无 OPFS 时维持现有内存 Blob 逻辑。
- 下游（handleHostExport）统一接受 Blob | OPFS 句柄：转换入口
  `runConversionTask` 增加源适配（OPFS File → blob 直传，zip.js 原生吃 File）。
- OPFS 临时文件在任务完成（产物入待导出区）或中止后清理；
  断点续传场景下保留至续传完成/用户丢弃。

### 1.2 智能压缩（已压缩内容 Store 直存）

`src/core/zip-io.js`：

```js
const STORE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico',
  '.mp4', '.webm', '.mp3', '.ogg', '.wav', '.flac',
  '.db', '.sqlite', '.sqlite3', '.zst', '.7z', '.zip', '.gz', '.br', '.rar',
]);

export function entryCompressionLevel(fileName, userLevel) {
  const dot = fileName.lastIndexOf('.');
  if (dot === -1) return userLevel;
  return STORE_EXTENSIONS.has(fileName.slice(dot).toLowerCase()) ? 0 : userLevel;
}
```

- `add/addLazy` 内部：`writer.add(name, data, { level: entryCompressionLevel(name, level) })`。
- 用户选择的压缩率仍作用于文本/配置类条目；报告（report）新增
  `storeBypassCount/storeBypassBytes` 统计。
- 单测：扩展名分流断言（含无扩展名、大写扩展名）。

### 1.3 Worker 并发拉满

`zip-io.js` 配置区：

```js
const HW = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
const CONCURRENCY = Math.max(2, Math.min(8, HW));
zip.configure({
  useWebWorkers: true,
  chunkSize: CHUNK_SIZE,
  maxWorkers: Math.max(4, HW),   // vendor 压缩/解压线程池
});
```

## 2. 任务管理器：中止 / 暂停 / 断点续传（提交 ②）

### 2.1 核心模块 `src/core/task-manager.js`

```js
/**
 * 长任务管理器：宿主拉取 / 转换 / 写回共用。
 * state: running | paused | aborted | done | failed
 */
export class TaskManager {
  /** 注册任务，返回 { signal, pausePromise?, onCheckpoint } */
  start(id, label, { resumable = false } = {})
  pause(id)    // 触发 checkpoint → abort，state=paused，清单持久化
  resume(id)   // 携带断点清单重新入队（由调用方实现续跑）
  abort(id)    // abort + 清理半成品，state=aborted
  get(id)      // { state, label, receivedBytes, totalBytes }
}
```

- 每任务一个 `AbortController`；`signal` 透传给 fetch（拉取）与 zip.js
  add/getData（转换）。
- 断点清单持久化在 OPFS `checkpoints/<id>.json`：
  - 拉取任务：`{ receivedBytes, opfsName }`；
  - 转换任务：`{ sourceName, sourceCrcRef, doneEntries: { path → crc32 } }`。
- 模块为纯状态机（可单测），浏览器副作用（OPFS 读写）注入 adapter。

### 2.2 拉取任务接入

- fetch 加 `signal`；reader 循环每 chunk 检查暂停请求 → 记 checkpoint →
  `reader.cancel()` + writable.close()。
- 续传：优先 `fetch(url, { headers: { Range: 'bytes=<received>-' } })` 从断点接
  （追加写 OPFS）；响应非 206 或端点不支持（Luker archiver 动态流大概率不支持）
  → **整包重拉**（半成品作废，提示用户）。中止/暂停始终可用；续传尽力而为。

### 2.3 转换任务接入

- `convert()`/`runConversionTask` 增加 `options.resumeCrcMap`
  （`{ path → crc32 }`）与 `options.signal`：
  - 循环开头 `if (signal?.aborted) throw new DOMException('', 'AbortError')`；
  - 源条目 crc32 ∈ resumeCrcMap 且值相等 → `entry.skip()`（已写入目标，跳过），
    report 计入 `resumedCount`（crc32 来源：zip-io reader 条目已透出
    `crc32` 字段，zip-io.js:90；dry-run/报告路径同源）；
  - 转换器每完成一个条目回调 `onEntryDone(path, crc32)` → TaskManager 更新清单
    （节流持久化，如每 64 条或每 2s）。
- Worker 路径：暂停/中止先 `worker.terminate()`（半成品 BlobWriter 丢弃），
  断点清单由主线程 onProgress 累积（onProgress 已有 filename，补 crc32 透传：
  converter-worker PROGRESS 消息增加 crc 字段）。
- 续传 UI：暂停态任务条显示【继续】【丢弃】；继续时以同一源文件 + 清单重跑。

### 2.4 UI（进度条旁任务控制条）

- `progress-container` 内加 `task-controls`：running →【⏸ 暂停】【✕ 中止】；
  paused →【▶ 继续】【🗑 丢弃】；状态文案（"已暂停于 45%（1.2GB/2.7GB）"）。
- 写回宿主：服务端单请求，仅支持【中止】（fetch signal），不支持暂停/续传。

## 3. 统一文件树：宿主拉取与上传同一套（提交 ③）

### 3.1 组件合并（去双轨）

- **类目卡片 = 文件树父节点**：类目行保留勾选框（聚合态：全选/半选/未选），
  展开（▸）后为 file-tree-picker 逐文件明细行（现有组件承担）。
  勾类目 = 全选其下文件；文件级排除使父呈半选态（现有逻辑保留）。
- 删除独立类目勾选框数组概念：`selection` 与 `excludedPaths` 由同一棵树派生
  （selection[cat] = 该类目"至少一个文件被勾选"）。
- 快捷按钮（仅角色卡/安全脱敏等）与规划预览条保留，作用于树。

### 3.2 宿主拉取接树（先扫描后拉取）

点【从宿主拉取】后流程：

1. `fetchHostBackup` 拉全量包（端点不支持文件级导出，ST/Luker 同）→
   落 OPFS（1.1 路径，顺便获得提速）；
2. 对包跑 `inspectArchive`（只读中央目录，成本低）渲染统一文件树；
3. 用户勾选文件/类目 → 确认 → `convert()` 以 `excludedPaths` 过滤
   （未勾选文件 = excludedPaths），产物进待导出区，原始宿主包按需入暂存区；
4. 【从宿主拉取】按钮语义变为"拉取并选择"：拉取本身不可文件级缩减
   （端点限制），但过滤发生在本地、零额外网络成本。

> 说明：若用户无需文件级选择，直接全选确认（默认态）＝现状行为。

### 3.3 降级路径

- 扫描失败/超时（>10s，如 Worker 不可用、超大包异常）：
  文件树**不可展开**（▸ 置灰 + 提示"明细不可用，按类目勾选"），类目勾选仍生效
  ——即"没法看文件树就降级为不可展开的文件树"。
- 独立模式/无源包：树为空态提示，类目卡片隐藏（现状行为保留）。

## 4. 测试与交付

- 单测：entryCompressionLevel 分流表；TaskManager 状态机（含并发/重复暂停）；
  convert resumeCrcMap 跳过与 resumedCount；文件树勾选聚合（父半选/子排除 → selection/excludedPaths）。
  全量 147+ 保持绿。
- 手动：vite dev（OPFS 拉取、暂停/继续/中止全流程、续传 crc 跳过、统一树宿主路径）；
  Luker 实例 Git 更新后真机复核拉取速度、暂停续传与文件树。
- 提交拆分：
  1. `perf(core): OPFS streaming fetch + smart store compression + max workers`
  2. `feat(core): task manager with abort/pause/resume for fetch and convert`
  3. `feat(ui): unified file tree for host fetch and uploads`
