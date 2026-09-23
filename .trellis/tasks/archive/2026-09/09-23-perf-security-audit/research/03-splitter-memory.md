# CH3 审计报告：智能分卷内存模型（`splitter.js`）

- **任务**：`.trellis/tasks/09-23-perf-security-audit`
- **审计对象**：链路③「分卷内存模型」——`src/core/splitter.js` + 消费方 `src/ui/split-deliver-modal.js`（及**实际消费方** `src/ui/export-queue.js`、`index.js`）
- **审计时间**：2026-09-23
- **审计方式**：只读源码审计（**未运行** `npm test` / `npm run build`，**未连接**任何酒馆实例 8001–8004）；vendor 压缩产物字节偏移用于定位实现
- **主要文件**：`src/core/splitter.js`、`index.js`、`src/core/zip-io.js`、`src/core/worker-client.js`、`src/ui/split-deliver-modal.js`、`src/ui/export-queue.js`、`src/vendor/zip.js`（单行压缩产物）
- **发现条数**：11 条（高 2 / 中高 1 / 中 5 / 低 2 / 信息 1）
- **最高严重度**：**高**

---

## 结论摘要

> **一句话结论：分卷是全内存模型**——调用方先把**整包解压成内存数组**（`U` ≈ 未压缩总量），`splitArchiveEntries` 再把**全部分卷 Blob 累积进 `parts` 数组一次性返回**，随后全部 `enqueue` 进 `ExportQueue` 长期驻留；无上限保护、无流式直通、无进度、无中止。峰值 ≈ **2×（未压缩总量）量级**，对 2GB 级源包即越过浏览器单页堆的实际可用上限。

逐问回答（对应任务 A 的 5 个必答项）：

| # | 问题 | 结论 |
| --- | --- | --- |
| 1 | 是否把所有分卷 Blob 同时留在内存？ | **是**。`splitter.js:98` 定义 `const parts = []`，`splitter.js:135-144` 逐卷 `parts.push({... blob ...})`，函数返回后 `index.js:948` / `index.js:1224` 把**全部分卷** `exportQueue.enqueue({ blob: p.blob, ephemeral: true })` 长期驻留 |
| 2 | 单卷目标大小常量 / 流式还是一刀切？ | 常量 `DEFAULT_THRESHOLD_MB = 100`（`splitter.js:15`）+ `SAFETY_MARGIN = 0.95`（`:16`），有效阈值 `thresholdBytes = MB×1024²×0.95`（`:87`）。UI 预设 50/100/200MB（`index.html:243-247`、`src/ui/workbench-template.js:161-165`）。**非流式直通**：逐条目 `await currentWriter.add(name, data)`（`:177`）把内存数据整体交给 zip.js，`addLazy` 零拷贝流式路径**未被 splitter 使用** |
| 3 | >2GB 行为 / 上限保护 | **无任何上限保护**。唯一"保护"是 `SAFETY_MARGIN`（防单卷超 100MB 上传限制，与内存无关）与 `isOversized` **提示徽标**（`:173`）。失败模式是**底层抛错或浏览器 OOM**，不是明确失败：`Uint8ArrayWriter` 倍增分配 `RangeError` / Chrome 单 Blob ~2GB 上限 / tab 堆耗尽 |
| 4 | 内存峰值量化公式 | **JS 堆峰值 ≈ `U` + `2·K·M` +（Blob 未落盘时 `C`）**，其中 `U` = 未压缩总量（≈ `1.0–1.3 × 源包`，文本/JSON 为主可达 `3–10×`）、`K` = 并发窗口 `2–8`、`M` = 单条目最大未压缩体积、`C` = 分卷压缩后总量（≈ 源包体积）。**相对原始文件：约 2×~10×**（详见第四节） |
| 5 | 与 `zip-io.js` / `worker-client.js` 缓冲叠加？ | **是，多路叠加**。`zipIo.add` 每条目 `new Uint8Array(data)` **全量拷贝**（`zip-io.js:192/197`）；并发窗口 `K≤8`；`zip` 线程池 `maxWorkers = max(4, HW)`（`zip-io.js:28`）；Worker 路径下转换产物 Blob 回传后仍被 `lastConvertedBlob` 持有（`index.js:1188`）与 `entries` 同时存活 |

补充要点：

| 维度 | 结论 |
| --- | --- |
| 消费方 | 任务给定的 `split-deliver-modal.js` **是死代码**：`renderSplitDeliveryModal` 在 `index.js:60` 被 import 但**全仓无调用点**。真实消费方是 `export-queue.js`（+ 用户点「存工作区」后的 IndexedDB） |
| 进度 | 分卷阶段 **完全无进度回调**：`splitter.js:57` 定义了 `onProgress`，但 `index.js:939` / `:1215` 两个调用点**都没传** → 进度条固定停在 92% / 95% |
| 中止 | `splitArchiveEntries(entries, options)` **不接受 `AbortSignal`**，循环内无任何 `signal` 检查 → 分卷阶段**不可暂停 / 不可中止** |
| 生命周期 | 分卷完成后 `entries` 随函数返回释放，但 `exportQueue.items[].blob` 与 `lastConvertedBlob`（外部转换路径）**长期不释放**，直到用户手动移除/清空 |

---

## 审计范围与判定口径

- **「内存驻留」判定**：该数据结构在分卷返回后仍被外层引用（`ExportQueue.items`、`lastConvertedBlob`）= 长期驻留；仅函数内局部 = 过程驻留。
- **JS 堆 vs 浏览器 Blob 存储**：`Blob` 的**载荷**由浏览器管理（Chrome 可落盘），JS 堆只持句柄；但 `Uint8Array`（条目数据、`Uint8ArrayWriter` 缓冲、`new Uint8Array(data)` 拷贝）**全部在 JS 堆**。凡是无法在静态源码中断言的浏览器行为，一律标 **「待验证」** 并给出验证方法（依任务约束禁连实例）。
- vendor `src/vendor/zip.js` 是**单行压缩产物**（约 179,717 字符），无法用行号定位；本报告用**字节偏移**作锚点。

---

# 一、Blob 累积策略（Q1）

## 1.1 锚点链

```js
// src/core/splitter.js:98
const parts = [];
...
// src/core/splitter.js:124-144（closeCurrentPart 内）
const blob = await currentWriterTarget.getData();
...
parts.push({
  partIndex: currentPartIndex,
  partName: partFilename,
  blob,                                  // ← 每卷 Blob 全部累积进同一数组
  fileCount: currentPartFiles.length,
  sizeBytes: blob.size,
  isOversized: isCurrentPartOversized,
  files: [...currentPartFiles],
});
```

```js
// index.js:948-955（宿主导出分卷路径）
for (const p of splitResult.parts) {
  exportQueue.enqueue({
    name: p.partName,
    blob: p.blob,        // ← 全部分卷 Blob 进入 ExportQueue.items，长期驻留
    targetLayout: targetLayout,
    origin: 'split-part',
    ephemeral: true,
  });
}
```

```js
// src/ui/export-queue.js:130-140（enqueue 实现）
enqueue({ blob, name, targetLayout = '', origin = ORIGINS.CONVERTED, ephemeral = true, autoDownload = false }) {
  const item = { id: `eq_${Date.now()}_${++seq}`, name, blob, targetLayout, origin, ephemeral, autoDownload, storedId: null };
  this.items.push(item);     // ← blob 引用长期保留至 remove()/clear()
```

**结论**：分卷 Blob **不是**逐卷交付即释放，而是「数组累积 → 一次性返回 → 全量入队 → 长期驻留」四段式。

### S-01 · 严重度：高 · 全部分卷 Blob 同时驻留（`parts` 数组 + `ExportQueue.items`）

- **锚点**：`src/core/splitter.js:98`、`src/core/splitter.js:135`、`index.js:948`、`index.js:1224`、`src/ui/export-queue.js:134`
- **证据**：见上 1.1 三段代码。
- **量化**：分卷 Blob 总量 `C` ≈ 中间包体积（≈ 源包体积 `S`）。在 `ExportQueue` 中**无上限**，用户不点「删除/清空」就一直占用。
- **是否落盘**：**待验证**。vendor `BlobWriter` 走 `new Response(stream).blob()` 路径时，Chrome 在保存期间/内存压力下会把 Blob 载荷移到浏览器 blob 存储（可能落盘）；但**不支持 `Blob.prototype.stream` 的环境会回退为全内存数组累积**（见 S-03）。
- **修复方向**：① 分卷改为**逐卷交付**（产出即下载/即写 OPFS/即 `stash`），不在内存累积；② `ExportQueue` 对 `origin === 'split-part'` 设总量上限（超出时强制先落盘到 IndexedDB/OPFS 再释放内存引用）；③ 至少提供「分卷完成后立即释放中间包 `lastConvertedBlob`」。

---

# 二、单卷目标大小常量与写出方式（Q2）

## 2.1 常量

| 常量 | 位置 | 值 |
| --- | --- | --- |
| `DEFAULT_THRESHOLD_MB` | `src/core/splitter.js:15` | `100` |
| `SAFETY_MARGIN` | `src/core/splitter.js:16` | `0.95`（预留 5%） |
| 有效阈值 | `src/core/splitter.js:87` | `Math.floor(thresholdMB * 1024 * 1024 * 0.95)` |
| UI 预设 | `index.html:243-247`、`src/ui/workbench-template.js:161-165` | `none` / `100` / `50` / `200` MB |
| 调用方取值 | `index.js:927`、`index.js:1203` | `parseInt(splitVal, 10) \|\| 100` |

> **注意**：`index.html:121-125` 还有一个 `host-split-select`（宿主侧分卷下拉），但**全仓 JS 无任何读取点**（`host-split-select` / `hostSplitSelect` 均 0 命中）→ 疑似独立模式模板与插件模板的**双入口不一致**（L1-MR-10 同类问题）。**待验证**：独立模式下该控件是否影响行为。验证方法：`grep -rn "host-split-select" src/ index.js` + 独立模式实测切换该下拉观察行为差异。

## 2.2 是流式写出还是一刀切？

**逐条目「内存条目整体写入」，非流式直通**：

```js
// src/core/splitter.js:146-179
for (let i = 0; i < sortedEntries.length; i++) {
  const entry = sortedEntries[i];
  const data = typeof entry.read === 'function' ? await entry.read() : entry.data;   // ← 已全量在内存
  const entrySize = data.byteLength || data.length || entry.size || 0;
  ...
  await currentWriter.add(entry.path, data);      // ← 整体交给 zip.js（内部 new Uint8Array(data) 再拷一份）
  currentPartFiles.push(entry.path);
  currentPartEstimatedBytes += entrySize;
}
```

对比 `zip-io.js` **已具备**的零拷贝流式接口（未被 splitter 使用）：

```js
// src/core/zip-io.js:206-235
addLazy(name, openFn, byteSize = 0) {          // 流式直通（pass-through 大文件零拷贝）
  ...
  const { readable, writable } = new TransformStream({}, { highWaterMark: 16 });
  const addPromise = writer.add(name, readable, { level: entryLevel });
  openFn((err, source) => { ... source.pipeTo(writable) ... });
```

而 `zipIo.openReader` 提供的就是**流**（`src/core/zip-io.js:107-112`）：

```js
openStream: async () => {
  const { readable, writable } = new TransformStream({}, { highWaterMark: 16 });
  entry.getData(writable).catch((err) => readable.cancel(err));
  return readable;
},
```

### S-02 · 严重度：高 · 分卷前把整包解压进内存（`U` 常驻），且与中间包 Blob 叠加

- **锚点（解压物化）**：`index.js:934-938`、`index.js:1210-1214`

```js
// index.js:931-938（宿主导出分卷路径）
const reader = await zipIo.openReader(finalBlob);
const entries = [];
for await (const e of reader.entries()) {
  if (e.isDirectory) { e.skip(); continue; }
  entries.push({ path: e.fileName, data: await e.read(), size: e.uncompressedSize });   // ← 全量物化
}
```

- **证据（`e.read()` 的实现，全内存 `Uint8Array`）**：`src/core/zip-io.js:114-116`

```js
read: async () => {
  return await entry.getData(new zip.Uint8ArrayWriter());
},
```

  `Uint8ArrayWriter`（vendor 导出别名 `Jr as Uint8ArrayWriter`，`src/vendor/zip.js` 字节偏移 ≈ 38,809）：

```js
class Jr extends Sr{constructor(t){super(),this.Bt=t||262144}
  init(t=0){Object.assign(this,{offset:0,qt:new Uint8Array(t>0?t:this.Bt)}),super.init()}
  writeUint8Array(t){const e=this,n=e.offset+t.length;
    if(n>e.qt.length){let t=e.qt.length?2*e.qt.length:e.Bt;for(;t<n;)t*=2;      // ← 倍增扩容
      const r=e.qt;e.qt=new Uint8Array(t),e.qt.set(r)}                          // ← 旧+新缓冲同时存活
    e.qt.set(t,e.offset),e.offset+=t.length}
  getData(){return this.offset===this.qt.length?this.qt:this.qt....}
```

- **并存的第二/第三份**：`lastConvertedBlob = resultBlob`（`index.js:1188`）在外部转换路径**不释放**；`ExportQueue.items` 持有全部分卷；`currentFile` 持有源包。→ 同一份数据在存续期上有 **≥3 个引用**。
- **修复方向**：① splitter 改吃**流**（`reader.entries()` 的 `openStream()` + `addLazy`），彻底消除 `entries` 物化；② 若必须保留物化路径，逐条目写入后立即 `entries[i].data = null` 释放；③ 外部转换路径分卷成功后置 `lastConvertedBlob = null`。

---

# 三、超大文件（>2GB）行为与上限保护（Q3）

## 3.1 现有"保护"清单（逐项判定）

| 机制 | 位置 | 实际保护对象 | 是否防内存 |
| --- | --- | --- | --- |
| `SAFETY_MARGIN = 0.95` | `splitter.js:16` | 防单卷超过**云酒馆上传限制** | ❌ 与内存无关 |
| `entrySize > thresholdBytes → isOversized` | `splitter.js:172-173` | 仅打**徽标**（`split-deliver-modal.js:118` 有对应 UI，但该弹窗未被调用） | ❌ 仅提示 |
| 超大文件"独占成卷" | `splitter.js:181-188` | 避免把超大文件塞进别的卷 | ❌ 不改变内存 |
| `LARGE_BLOB_THRESHOLD`（16MB）串行写入队列 | `src/storage/db.js:172` | 避免 IndexedDB 写入抖动 | ❌ 仅在入队时生效 |
| 无阈值上限校验 | — | — | ❌ **不存在** |

## 3.2 失败模式

- 单条目 >2GB：`Uint8ArrayWriter` 倍增时 `new Uint8Array(t)` 需要**连续**大缓冲 → 极易 `RangeError: Invalid typed array length` / `Array buffer allocation failed`。V8 的 TypedArray 长度上限与浏览器实际可用堆远低于 2GB 的**单块连续**分配。
- 单卷 >2GB：`currentWriterTarget.getData()` 走 vendor `Ce` → `new Response(stream).blob()`；Chrome 单 Blob 上限约 2GB，超限行为**待验证**（推测抛错或 OOM）。
- 总量 >可用堆：进程级 OOM，`catch` 只能捕获 JS 异常，**捕获不到崩溃**。

### S-03 · 严重度：中高 · `BlobWriter` 的 `getData()` 在两代实现间行为分叉，旧环境退化为全内存累积

- **锚点**：`src/vendor/zip.js` 字节偏移 ≈ 32,656（`class Ur extends gr`＝`BlobWriter`）、≈ 15,152（`function Ce`）
- **证据**：

```js
// src/vendor/zip.js（字节偏移 ≈ 32,656）
class Ur extends gr{constructor(t){super();const e=this,n=new TransformStream;
  Object.defineProperty(e,yr,{get:()=>n.writable});
  e.contentType=t,e.Nt=Ce(n.readable,t),e.Nt.catch(()=>{})}
  getData(){return this.Nt}}            // ← getData 返回 Promise<Blob>
```

```js
// src/vendor/zip.js（字节偏移 ≈ 15,152）
function Ce(t,e){t=Ne(t);const n=e?{type:e}:{};
  if(typeof Blob.prototype.stream!=j||new Blob([]).stream()instanceof ReadableStream)
    return new Response(t).blob().then(t=>e?new Blob([t],n):t);   // ← 流式→Blob（可能由浏览器落盘）
  const r=[ ... ]                                                 // ← 回退分支：数组全量累积
```

- **含义**：现代浏览器走 `Response(...).blob()`（载荷由浏览器 Blob 存储承载，是否落盘**待验证**）；`Blob.prototype.stream` 不可用或 `Blob([]).stream()` 非 `ReadableStream` 的环境，走 `const r=[]` 的**纯内存累积**分支 → 分卷总量 `C` 100% 落在 JS 堆。
- **修复方向**：不依赖 vendor 的隐式行为——分卷时把每卷直接写出到 **OPFS / IndexedDB**（`export-queue` 已有落盘路径），只在内存保留「句柄 + 大小」。
- **验证方法**：合成 >500MB 数据，在 `closeCurrentPart` 前后读取 `performance.memory.usedJSHeapSize`（Chromium only）对比；或在 `Ce` 两分支各打一次日志确认走了哪条（临时改 vendor **仅用于本地验证**，不入库）。

## 3.3 缺失的保护

### S-04 · 严重度：中 · 无内存预检、无条目数上限、无明确失败

- **锚点**：`src/core/splitter.js:75-89`（函数签名与初始化，无任何预算校验）
- **证据**：`entries` 为空只抛 `待切分条目列表不能为空`（`:84`）；对 `entries.length`、`Σsize`、单条目大小**均无上限校验**，也未读取 `navigator.deviceMemory` / `navigator.storage.estimate()`。
- **修复方向**：函数入口做预算检查（`ΣuncompressedSize > budget` → 抛可读错误或切到流式路径），并把错误信息透出到 UI（当前 `index.js` 的 `catch` 只有 `view.setProgress(100, '导出失败: …')`）。

---

# 四、内存峰值量化公式（Q4）

## 4.1 变量定义

| 符号 | 含义 | 典型关系 |
| --- | --- | --- |
| `S` | 中间包（`finalBlob` / `resultBlob`）体积 = 源包量级 | 基准 |
| `U` | **Σ 条目未压缩体积**（`entries[].data`，JS 堆常驻） | `U = r·S`，压缩率决定 `r` |
| `C` | Σ 分卷 Blob 体积（≈ 中间包体积） | `C ≈ S` |
| `M` | 单个最大条目的未压缩体积 | 常见 `M ≪ U`，极端时 `M ≈ U` |
| `K` | `zipIo` 并发窗口 | `clamp(hardwareConcurrency, 2, 8)`（`zip-io.js:19`） |
| `W` | zip.js 压缩线程数 | `max(4, hardwareConcurrency)`（`zip-io.js:28`） |
| `B` | 单条目瞬时缓冲系数 | 倍增扩容最坏 ≈ `2`（`new` + `old` 并存，见 4.2） |

## 4.2 峰值公式

```
JS 堆峰值 ≈ U                          ← ① entries 全量 Uint8Array（splitter 全程驻留）
          + B·M                        ← ② Uint8ArrayWriter 倍增瞬时超额（B ≈ 2，最坏 < 3）
          + K·M·2                      ← ③ zipIo.add 的 new Uint8Array(data) 全量拷贝（每条目 1 份，K 条并发）
          + (K ≤ 128MB 级)             ← ④ K 个 TransformStream/Reader 分片缓冲（chunkSize=262144B）
          + [C 若 Blob 未落盘]           ← ⑤ 分卷 Blob 载荷（浏览器托管，待验证是否落盘）
          + [S 若中间包未释放]           ← ⑥ lastConvertedBlob / ExportQueue 持有的中间产物

相对原始文件大小（S）的倍数：
   峰值 / S ≈ r + (B·M + 2·K·M + C′) / S
   r（未压缩/压缩比）：媒体为主包 ≈ 1.0–1.3；含大量 JSONL/文本/世界书 的包可达 3–10
   C′ = C 或 0（取决于 Blob 是否落盘）
```

**保守估算（媒体为主、Blob 落盘）**：`≈ 1.2·S + 2·K·M` → **约 1.2×~1.5× 源包**。
**悲观估算（文本为主、Blob 不落盘）**：`≈ 3~10·S + S` → **约 4×~11× 源包**。

## 4.3 分档实测估算表（合成数据推算，非实测）

| 源包 `S` | `r`（乐观/悲观） | `U` | `C` | 悲观 JS 堆峰值 | 风险 |
| --- | --- | --- | --- | --- | --- |
| 100 MB | 1.2 / 5 | 120 MB / 500 MB | 100 MB | ≈ 0.6 GB | 低 |
| 500 MB | 1.2 / 5 | 600 MB / 2.5 GB | 500 MB | ≈ 3 GB | 高（tab 堆紧张） |
| **2 GB** | 1.2 / 5 | **2.4 GB / 10 GB** | 2 GB | **≈ 4.4–12 GB** | **极高（必然 OOM）** |

> 表中 `r` 的区间来源：`STORE_EXTENSIONS`（`zip-io.js:33-38`）把图片/媒体按 level 0 直存，这类包 `r≈1.0–1.1`；而 `chats/*.jsonl`、`worlds/*.json`、`settings.json` 文本条目 deflate 压缩率高，`r` 可达 `3–10`。

### S-05 · 严重度：中 · `zipIo.add` 对每条目做一次**全量拷贝**

- **锚点**：`src/core/zip-io.js:192`、`src/core/zip-io.js:197`
- **证据**：

```js
await track(writer.add(name, new zip.Uint8ArrayReader(new Uint8Array(data)), { level: entryLevel }));
```

  `new Uint8Array(data)` 在 `data` 已是 `Uint8Array` 时是**内容拷贝**（非视图共享），大小 = 条目未压缩体积。并发窗口 `K` 条在飞 → 瞬时 `K × 条目大小` 额外占用（条目大小可有 MB~GB 级）。
- **修复方向**：对 `Uint8Array` 输入改用零拷贝视图（`new Uint8Array(data.buffer, data.byteOffset, data.byteLength)`）或直接 `zip.Uint8ArrayReader(data)`；真正的大文件改走 `addLazy` + `openStream`。

### S-06 · 严重度：中 · `Uint8ArrayWriter` 倍增扩容造成单条目瞬时 2× 超额

- **锚点**：`src/vendor/zip.js` 字节偏移 ≈ 38,809（`class Jr extends Sr`）
- **证据**：见 S-02 引用的 `writeUint8Array`：`let t = e.qt.length ? 2*e.qt.length : e.Bt; for(; t<n; ) t*=2; const r=e.qt; e.qt=new Uint8Array(t); e.qt.set(r)` → 分配新缓冲期间旧缓冲 `r` 仍存活。
- **修复方向**：调用 `getData(new zip.Uint8ArrayWriter(entry.uncompressedSize))` 或在读取前按中央目录的 `uncompressedSize` **预置初始容量**（vendor `init(t)` 支持传入初始长度 `t`），避免倍增。

---

# 五、与 `zip-io.js` / `worker-client.js` 的缓冲叠加（Q5）

**结论：是，且是多路叠加。** 叠加关系如下（同一时刻并存）：

```
[worker-client.js]  Worker 路径下 resultBlob 由 postMessage 回传
                    → 被 lastConvertedBlob 持有（index.js:1188，不释放）
        ↓
[index.js:1207]     zipIo.openReader(resultBlob) → reader（持有源 Blob 句柄）
        ↓
[index.js:1211]     逐条 e.read() → Uint8ArrayWriter（JS 堆，U = Σ 未压缩）
        ↓
[splitter.js:177]   zipIo.add → new Uint8Array(data) 拷贝 × K 条并发（zip-io.js:192/197）
        ↓
[zip-io.js:28]      zip 线程池 maxWorkers = max(4, HW)，每个 worker 持 chunkSize=256KB 缓冲 + deflate 状态
        ↓
[splitter.js:135]   parts[] 累积全部 Blob → exportQueue.items[] 长期驻留
```

### S-07 · 严重度：中 · 与 `zip-io` 并发窗口 / zip.js 线程池叠加放大峰值

- **锚点**：`src/core/zip-io.js:19`（`CONCURRENCY`）、`:21`（`CHUNK_SIZE = 262144`）、`:23`、`:28`（`maxWorkers: Math.max(4, HW)`）、`:174-179`（`waitForSlot` 背压）
- **证据**：

```js
const CONCURRENCY = Math.max(2, Math.min(8, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 6));
const CHUNK_SIZE = 262144;
zip.configure({ useWebWorkers: true, chunkSize: CHUNK_SIZE, maxWorkers: Math.max(4, HW) });
```

- **保守量级**：线程池 `W×256KB`（≈ 1–4MB，小头）+ `K×条目大小`（大头）。真正放大的是③项（见 4.2 公式）。
- **未叠加的部分（澄清）**：`addLazy` 的 `TransformStream({}, { highWaterMark: 16 })` → `16 × 256KB = 4MB`/条，**splitter 未走此路径**；`inspect`/`plan-preview` 路径不在分卷链路，不叠加。

### S-08 · 严重度：中 · Worker 路径的中间产物与分卷产物双持

- **锚点**：`index.js:1188`（`lastConvertedBlob = resultBlob;`）、`index.js:1215-1233`（分卷分支 `return` 前未清空 `lastConvertedBlob`）
- **证据**：外部转换分卷分支执行完 `exportQueue.enqueue` 后直接 `return`（`index.js:1232`），**没有** `lastConvertedBlob = null`；`btnRestoreLuker` 的旧路径（`index.js:1071-1076`）仍会用到它，故不能简单删除 → 需要显式生命周期设计。
- **修复方向**：分卷产物入队成功后置空 `lastConvertedBlob`（并同步禁用/隐藏依赖它的旧按钮），或把该引用改为 `WeakRef`/惰性重取。

---

# 六、附加发现（消费方与生命周期）

### S-09 · 严重度：信息 · 任务指定的消费方 `split-deliver-modal.js` 是死代码

- **锚点**：`index.js:60`（`import { renderSplitDeliveryModal } from './src/ui/split-deliver-modal.js';`）、`src/ui/split-deliver-modal.js:43`（定义）
- **证据**：全仓 `grep -rn "renderSplitDelivery"` 仅命中 import 与定义 + `test/plugin.test.js` 的存在性断言，**无任何调用点**。分卷产物实际走 `exportQueue.enqueue`（`index.js:948/1224`）→ `export-queue.js` 渲染 → 用户手动「下载/存工作区」。
- **影响**：① 报告 A 的"消费方"结论应改挂 `export-queue.js`；② 该弹窗内的 `downloadBlob`（`:24`，`URL.createObjectURL` + `setTimeout(revoke, 1000)`）与「一键按序下载」（`:158-166`，450ms 间隔）**从未被执行**，其潜在缺陷（见 S-10）当前不可触发。
- **修复方向**：删除该模块（含 `test/plugin.test.js` 对应断言）或把它接回分卷流程——二选一，不要留悬空。

### S-10 · 严重度：低 · `downloadBlob` 的 ObjectURL 在 1s 后即 revoke（若接入将不可靠）

- **锚点**：`src/ui/split-deliver-modal.js:25`（`createObjectURL`）与 `:32`（`revokeObjectURL`）
- **证据**：

```js
// src/ui/split-deliver-modal.js:25-33
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = filename;
document.body.appendChild(a);
a.click();
setTimeout(() => {
  URL.revokeObjectURL(url);
  a.remove();
}, 1000);
```

  GB 级 Blob 的下载尚未开始/未完成时 revoke 可能中断下载（对比 `export-queue.js:34` 用 60s、`stash-list.js:58` 用 60s、`archive-manager.js:162` 用 60s、`setDragOutPayload`（`export-queue.js:74`）用 120s）。
- **修复方向**：若接回流程，统一改为 ≥60s 或监听下载完成再 revoke。

### S-11 · 严重度：低 · 阈值判定用「未压缩体积」，与实际分卷体积语义不一致

- **锚点**：`src/core/splitter.js:156`（`const wouldExceed = (currentPartEstimatedBytes + entrySize) > thresholdBytes;`）、`:179`（`currentPartEstimatedBytes += entrySize;`，`entrySize` 取自 `data.byteLength` = 未压缩）
- **证据**：判定依据是**未压缩**累计值，而分卷实际大小 `blob.size` 是**压缩后**值（`splitter.js:141`）。对可压缩文本条目，这会让分卷**远小于**阈值（多切几卷、多几份 `_convert/split-manifest.json`）；对 `STORE_EXTENSIONS`（level 0 直存）条目则估算准确。
- **修复方向**：改用 writer 的已写出字节数（vendor 可提供）或按 `entryCompressionLevel` 分支估算；至少把该语义写进函数文档。
- **附加**：`splitter.js:152` 的 `onProgress(currentPartIndex, Math.max(currentPartIndex, 1), entry.path)` 把 `currentPartIndex` 同时当 `current` 与 `total` 传，**totalParts 在结束前不可知**，进度语义本身不可用（且当前无人传 `onProgress`）。

---

## 立即修复建议

> 依任务约束，本审计**不改代码**；以下按「先止血、后结构性」排序，供实施任务直接引用。

| 序 | 动作 | 锚点 | 预期收益 |
| --- | --- | --- | --- |
| A1 | 分卷成功后立即释放中间产物引用：`lastConvertedBlob = null`（并处理旧按钮依赖） | `index.js:1188`、`index.js:1232` | 回收 1× 源包体积 |
| A2 | 条目写入后即时释放：循环内 `entries[i].data = null` / 改用 `for await` 直接流式喂给 writer | `index.js:934-938`、`index.js:1210-1214` | 回收 `U`（最大头） |
| A3 | `zipIo.add` 去掉冗余全量拷贝（`new Uint8Array(data)` → 视图或直传） | `zip-io.js:192`、`zip-io.js:197` | 消除 `K×条目` 瞬时占用 |
| A4 | `Uint8ArrayWriter` 传入 `uncompressedSize` 预置容量 | `zip-io.js:115` | 消除 2× 倍增超额 |
| A5 | `ExportQueue` 对 `split-part` 设总量上限 + 超限提示 | `export-queue.js:130-140` | 防长期驻留累积 |
| A6 | 分卷阶段接入 `onProgress`（两个调用点都补传）+ 接 `AbortSignal` | `index.js:939`、`index.js:1215`、`splitter.js:75` | 恢复可见性与可中止性 |
| A7 | 明确失败而非静默 OOM：入口预算检查 + 可读错误透出 | `splitter.js:84-89` | 可诊断 |

## 建议纳入后续优化任务

1. **流式分卷重构**：`splitArchiveEntries` 改吃 `AsyncIterable<{path, openStream, uncompressedSize}>`，内部用 `zipIo.addLazy`，彻底消除 `entries` 物化与 `U`。→ 与 `09-23-authority-cloud-transfer`（分块落盘思路）复用同一接缝。
2. **分卷产物落盘优先**：每卷产出即写 OPFS 或 IndexedDB，`ExportQueue` 只保存句柄；配合 `navigator.storage.estimate()` 做配额预检与降级提示。
3. **超大单文件的专用路径**：`M > thresholdBytes` 的条目跳过"解压到内存"，改为 `openStream → addLazy` 直通（当前 `isOversized` 仅提示）。
4. **死代码清理**：处置 `src/ui/split-deliver-modal.js`（接回或删除），同步更新 `test/plugin.test.js`。
5. **双入口一致性核查**：`host-split-select`（`index.html:121`）无消费点问题，纳入 L1-MR-10 自查清单（`index.html` 与 `workbench-template.js` 同源同改的机器化校验）。
6. **合成数据基准**：用 `test/fixtures` 生成 100MB/500MB/2GB 合成包，测 `usedJSHeapSize` 峰值，把本报告第 4 节的**估算**升级为**实测**（禁连真实实例）。
