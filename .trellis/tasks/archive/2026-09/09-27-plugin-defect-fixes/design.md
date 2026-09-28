# 技术设计 · 插件已知缺陷修复

> 父任务 `09-27-instance-sync-and-plugin-hardening`；本子任务 `09-27-plugin-defect-fixes`。
> 规范条文最终落 `.trellis/spec/`。**本文只写技术设计，需求与验收见 `prd.md`。**

## D0 现场取证结论（决定设计形态）

三条缺陷的**真实形态**与 PRD 的初判有出入，先把事实钉住：

### D0.1 R-16：**核心层已完备，缺的只在 `index.js` 的接线**

| 层 | 现状 | 位置 |
| --- | --- | --- |
| `TaskManager` | **本就是为三路径设计的纯状态机** —— 文档字符串写着「宿主拉取 / **转换** / 写回共用」 | `src/core/task-manager.js:2` |
| `transform.js` | **已支持** `signal`（每条目边界检查）/ `resumeCrcMap`（命中即跳过、计 `resumedCount`）/ `onEntryDone` | `src/core/transform.js:243-246`、`:266-268`、`:284`、`:651-652` |
| `worker-client.js` | **已支持** `options.signal`；abort 时 `terminate()` **并置空 `workerInstance`**（`034b7ab` 的修复在位）；reject `DOMException(…, 'AbortError')`；用 `doneEntries` 累积 `filename→crc32` | `src/core/worker-client.js:117`、`:136-148`、`:155`、`:164` |
| `index.js` | ❌ **未接线**：`btnConvert`（`:1543`）不建任务、不传 signal、不调 `taskControls.showRunning`；`onResume`（`:515`）只认 `fetch-` 前缀 | — |

⇒ **R-16(a) 的实际工作量 = 一处接线 + 一处回调泛化 + 测试**，不是「重写转换管线」。
风险面因此**显著小于** PRD 初判（不必动 `core/` 的任何执行逻辑）。

### D0.2 R-16 的**关键设计约束**：Worker 路径下 aborted 时 `doneEntries` 会丢

`runConversionTask` 在 `DONE` 分支才 `resolve({..., doneEntries})`（`:161-165`）；
**abort 分支直接 reject，`doneEntries` 随 Promise 一起丢弃**（`:136-143`）。

⇒ **续传清单必须由调用方（`index.js`）自行累积**，不能依赖返回值的 `doneEntries`。
`onProgress` 的回调签名带 `crc32`（`:157` `onProgress(current, total, filename, crc32)`），
故调用方可在自己的 `onProgress` 里累积 `Map<fileName, crc32>`。

### D0.2b ⚠️ **`onEntryDone` 在 Worker 路径上永不触发**（2026-09-27 设计复核新增，**本设计最容易致命的一处**）

`src/core/worker-client.js:89` 的 JSDoc 明文写着：

> `@param {function} [params.onEntryDone] (源条目名, crc32)`——**主线程路径直通；Worker 路径由 onProgress 累积**

从实现看得更死：`onEntryDone` 是 `runConversionTask` 的**顶层参数**（`:92`），
只被传进**主线程降级分支**（`:107` 的 `convert(..., { onEntryDone })`）；
Worker 分支走 `postMessage`，函数**根本不能过结构化克隆**，故该路径**没有任何机制**触发它。

而 `supportsWebWorker()`（`:9-11`）= `typeof window !== 'undefined' && typeof Worker !== 'undefined'`
⇒ **浏览器 = Worker 路径（`onEntryDone` 死）**，**Node/Vitest = 主线程路径（`onEntryDone` 活）**。

**后果（若不修正）**：D1.2 原先把 `onCheckpoint`（断点落盘）只挂在 `onEntryDone` 上 ⇒
**浏览器里断点永不落盘** ⇒ `taskManager.pause()` 时 `task.checkpoint` 为 `null` ⇒
`resume(id)` 返回 `null` ⇒「暂停后无法续传」**依旧不可达**，即 **R-16 原样未修**；
而 `npm test` **全绿**（跑的是主线程路径）⇒ **缺陷被测试掩盖**。

**修正**：`onCheckpoint` **只能挂 `onProgress`** —— 它是**唯一**在两条路径上都活的回调。
`onEntryDone` 可保留（主线程路径更精确），但**不得**作为落盘的唯一入口。

**这一条的守护只能靠两处，缺一不可**：
1. **E2E（真浏览器 = Worker 路径）**—— 唯一能真正暴露该缺陷的地方（AC-B3 / AC-B7）；
2. **「假执行体」单测**（D1.5 新增）：注入一个**只调 `onProgress`、从不调 `onEntryDone`**
   的执行体（**模拟 Worker 路径的回调契约**），断言 `onCheckpoint` 仍被调用。
   —— 这条把「Worker 路径契约」变成可在 Vitest 里断言的**显式契约**，
   否则同一类缺陷下次仍会被单元测试放过。

### D0.3 R-17：确证为**入口守卫 URL 拼接**，与平台相关

`fixtures/gen.js:144`：

```js
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
```

Windows 上 `import.meta.url` 是 `file:///D:/…`（**三个**斜杠），模板拼出 `file://D:/…`（**两个**）
⇒ **永不相等**。**实测复现**：`node fixtures/gen.js /tmp/…` → 退出码 0、零输出、零产物。

### D0.4 R-19：模块级 `let`，无 `window` 出口

`src/ui/host-bridge.js:85` `let restoreCapability = 'unknown';`，
出口仅 `getRestoreCapability()`（`:91`）/ `isRestoreUnsupported()`（`:96`）/
`getRestoreUnsupportedReason()`（`:101`）。**无任何全局暴露** ⇒ Playwright 读不到。

---

## D1 R-16(a) 设计：转换路径接入断点续传

### D1.1 任务类型分派（替换硬编码前缀判断）

**现状**（`index.js:515`）：

```js
onResume: (id, checkpoint) => {
  if (id.startsWith('fetch-')) handleHostExport({ resumeCheckpoint: checkpoint, resumeTaskId: id });
},
```

**问题**：加转换续传若照抄，会变成第二个 `if`；第三个路径（写回）再加一个 —— 正是
`code-reuse-thinking-guide` 点的「同一模式重复 3+ 次」。

**设计**：新增**唯一**的任务类型判据 + 分派表（放 `index.js`，不进 `core/`）：

```js
/** 任务 id 前缀 ↔ 类型（唯一判据，勿在别处再写 startsWith） */
const TASK_KINDS = Object.freeze({
  FETCH: 'fetch',
  CONVERT: 'convert',
  CONVERT_BATCH: 'convert-batch',   // 批量转换：独立类型（见 D1.3）
  RESTORE: 'restore',
});
const TASK_PREFIX = Object.freeze({
  [TASK_KINDS.FETCH]: 'fetch-',
  [TASK_KINDS.CONVERT]: 'convert-',
  [TASK_KINDS.CONVERT_BATCH]: 'convert-batch-',
  [TASK_KINDS.RESTORE]: 'restore-',
});

/**
 * ⚠️ **必须按前缀长度降序匹配** —— `convert-batch-` 与 `convert-` 是**前缀重叠**的：
 * 若按声明顺序遍历，`convert-batch-1680000000` 会被 `convert-` 先吃掉 ⇒ **静默降级成单包语义**
 * （路径错、断点字段读不到）。故此处**显式排序**，不依赖对象字面量的插入顺序 ——
 * 依赖插入顺序的写法会在有人重排常量时无声失效。
 * @returns {'fetch'|'convert'|'convert-batch'|'restore'|null}
 */
function taskKindOf(id) {
  const entries = Object.entries(TASK_PREFIX).sort((a, b) => b[1].length - a[1].length);
  for (const [kind, prefix] of entries) if (id.startsWith(prefix)) return kind;
  return null;
}
```

`onResume` 改为查表：

```js
onResume: (id, checkpoint) => {
  const kind = taskKindOf(id);
  const handler = RESUMABLE_HANDLERS[kind];
  if (!handler) { logger.warn(`无可续传的执行体: ${id}`); return; }
  handler({ resumeCheckpoint: checkpoint, resumeTaskId: id });
},
```

### D1.2 `btnConvert` 的接线（**唯一改动点**）

在 `index.js:1543` 的 `btnConvert` 处理体内、`runConversionTask` 调用**之前**插入：

```js
const taskId = resumeTaskId || `convert-${Date.now()}`;
const { signal, onCheckpoint } = taskManager.start(taskId, '转换', {
  resumable: true,
  totalBytes: currentFile.size,
});
taskControls.showRunning(taskId, { totalBytes: currentFile.size });
const doneEntries = new Map(
  resumeCheckpoint?.doneEntries ? Object.entries(resumeCheckpoint.doneEntries) : []
);
```

并把三项传进 `runConversionTask`：

```js
const { report, resultBlob } = await runConversionTask({
  source: currentFile,
  target,
  options: {
    // …既有 options 原样保留…
    signal,                                   // ← 新增：暂停/中止的执行面
    resumeCrcMap: doneEntries,                // ← 新增：命中即跳过（transform 已支持）
  },
  onProgress: (current, total, filename, crc32) => {
    if (crc32 != null && filename) doneEntries.set(filename, crc32);
    // ⚠️ 落盘必须在这里（onProgress 是唯一在 Worker/主线程两条路径都活的回调，见 D0.2b）
    maybeCheckpoint(current === total);       // 末条强制落一次，保证小任务也有断点
    // …既有进度渲染保留…
  },
  // onEntryDone 仅主线程路径触发 ⇒ 只作冗余触发，**不得**作为唯一落盘入口（D0.2b）
  onEntryDone: (filename, crc32) => {
    if (crc32 != null && filename) doneEntries.set(filename, crc32);
    maybeCheckpoint(false);
  },
});
```

其中 `maybeCheckpoint` 用**与 `TaskManager` 同源**的节流常数（`src/core/task-manager.js:23-25`：
`CHECKPOINT_EVERY_ENTRIES = 64` / `CHECKPOINT_EVERY_MS = 2000`）：

```js
let lastFlushAt = 0;
const lastFlushedSize = { n: -1 };
/** @param {boolean} force 末条/收尾时强制 */
function maybeCheckpoint(force) {
  const now = Date.now();
  const due = force
    || doneEntries.size - lastFlushedSize.n >= 64
    || now - lastFlushAt >= 2000;
  if (!due) return;                       // 未到窗口：**连对象都不materialize**（省 GC）
  lastFlushedSize.n = doneEntries.size;
  lastFlushAt = now;
  onCheckpoint(
    { doneEntries: Object.fromEntries(doneEntries), totalEntries },
    { bytes: processedBytes, force },
  );
}
```

**为什么必须节流**：`Object.fromEntries(doneEntries)` 是 O(n)。不节流则在 n 个条目上做
n 次全量拷贝 = **O(n²) + 大量短命对象**（8683 条目的包 ⇒ 约 7500 万次属性分配），
会制造 GC 压力与长任务（L1-MR-9 的相邻风险）。
**不在窗口内连对象都不建**，是这条节流与「只在 `adapter.save` 处节流」的关键差别
（后者仍会每 tick materialize 一次）。

**断点滞后是安全的，且方向不可颠倒**：滞后窗口 ≤63 条 ⇒ 续传时这 ≤63 条被**重做**，
**绝不会**被错误跳过（错误跳过 = 产物缺条目）。**任何让断点「超前」的写法都是缺陷。**

**收尾语义**（与宿主拉取路径对称）：

| 出口 | 动作 |
| --- | --- |
| 成功 | `await taskManager.complete(taskId)` |
| 用户暂停 | `abort` 让 `runConversionTask` reject `AbortError`；`TaskManager.pause` 已置 `paused` 并把 `task.checkpoint` 强制落盘 ⇒ catch 里**按 `err.name === 'AbortError'`** 分派：`rec.state === PAUSED` ⇒ `taskControls.showPaused` + `setPausedCheckpoint`（**不得**调 `fail()`）；`rec.state === ABORTED` ⇒ `taskControls.hide()` |
| 中止 | `taskManager.abort(taskId)`（清断点）+ 既有清理 |
| 真失败 | `taskManager.fail(taskId, true)` —— `keepCheckpoint=true`，让暂停过的任务失败后仍可续（与 `:1245` 的既有用法一致） |

**必须逐行对照既有实现**：`index.js:1227-1243`（宿主拉取路径的 catch 块）就是**同一张表的现成实现**
（`AbortError` → 判 `PAUSED`/`ABORTED` → `showPaused` + `setPausedCheckpoint` / `hide`）。
**照抄其形状**，不要另发明一套 —— 两条路径的暂停/中止语义必须**逐字节同构**，否则用户在两处看到不同行为。

**为什么 `AbortError` 必须「静默」**：`pause` 是**正常用户操作**，不是失败。
「静默」指的是**不调 `fail()`、不 `logger.error`、不显示「失败」**；
**不是**「什么都不做」—— 正相反，必须**显示暂停态**（`showPaused` + `setPausedCheckpoint`），
否则用户点了暂停却看不到任何反馈。若误走 `fail()`：`fail` 会 `adapter.remove(id)`
清掉刚写好的断点 ⇒ **续传能力当场失效**，且 UI 会显示"失败"。
这是本设计里**最容易写错的一处**。

### D1.3 批量转换路径（`runBatchConversion`，`index.js:393`）—— **本轮接线**（用户裁决 U-5）

> **行号更正**：本设计上一版把该函数记为 `index.js:1129`，**是错的**
> （`:1129` 是宿主拉取路径的转换段）。实测 `grep -n "runBatchConversion" index.js` ⇒ **`:393`**。
> 引错行号会让实现者读错文件段 —— `L0-17` 的「spec 页面必须自包含且引用准确」同形要求。

**用户裁决**：批量的「断点续传」也一并接上（README 特性 2 的承诺对批量同样成立）。

#### 形态：**一个任务 + 子项游标**（不采用「每子项一个任务」）

理由：`taskControls` 一次只展示**一个**活动任务（`showRunning(taskId, …)`）；
若每子项建一个任务，用户会看到 N 个控制条/断点，而他的心智是「这一批活」。
⇒ **一个 `convert-batch-<ts>` 任务**，断点里带子项游标。

#### 断点清单（`convert-batch-` 的 manifest）

```js
{
  kind: 'batch',
  itemIndex,                       // **下一个**待处理子项下标（不是已完成的个数，避免 off-by-one 歧义）
  outputs: [ { index, name } ],    // 已完成子项的产物清单（用于失效检测，见下）
  doneEntries: { '<条目名>': crc32 },  // **仅属于 itemIndex 那个子项**的条目级断点
  totalItems,
}
```

**`doneEntries` 每个子项必须重置** —— 不同源包的条目名可能重名，跨子项复用 crc 清单会
**错误跳过**（产物缺条目）。恢复时**只在 `itemIndex` 相同时**才把清单喂给该子项。

#### ⚠️ **可验证前提**：跨页面重载的失效检测（用户裁决 U-6）

`ExportQueue` 是**纯内存**的（`src/ui/export-queue.js:92` `this.items = []`），
而 `ephemeral: true` 的产物**只在内存**（`enqueue` 默认 `ephemeral = true`）；
断点却经 adapter **持久化**。⇒ 若暂停后页面重载，断点说「前 k 个子项已完成」，
但它们的产物**已不在** ⇒ 直接续跑会**跳过那 k 个子项 ⇒ 产物缺失**。

**做法（检测真实依赖，而非猜）**：

1. `enqueue` 增一个**可选**字段 `taskId = null`（**加性改动**，`this.items` 的既有消费者只读已知字段）；
2. `handleBatchConvert` 给本批每个产物打上自己的 `taskId`；
3. 续传**前**核对：
   ```js
   const present = exportQueue.items.filter((it) => it.taskId === taskId).length;
   if (present !== checkpoint.outputs.length) {
     // 前提不成立 ⇒ 断点作废（清掉），提示「产物已不在内存（页面可能已重载），无法续传，将重跑整批」
     await taskManager.abort(taskId);
     logger.warn(...);
     return;                     // **不得**带着残缺前提硬续
   }
   ```
4. **为什么用这个判据而不是「会话令牌」**：它检测的是**真正依赖的那个东西**（产物还在不在），
   而不是「会话是否同一个」这个**代理量** —— 代理量会在「同会话但用户手动删了产物」时误判为可续。

#### ⚠️ 循环内遇到暂停**必须 break**（现状会吞掉并继续跑下一个包）

现状（`index.js:447-449`）：
```js
} catch (err) {
  logger.error(`批量转换失败 [${srcMeta.name}]: ${err.message}`);   // ← 吞掉一切，继续 for
}
```
`pause` 会让 `runConversionTask` reject `AbortError` ⇒ **被这里吞掉 ⇒ 循环继续跑下一个包**，
任务却在 `paused` 态 ⇒ 用户看到「已暂停」但**还在往下跑**，且断点游标与实际进度脱节。

**修法**：`catch` 里先判 `err?.name === 'AbortError'` ⇒ **`break`**（退出循环，不再处理后续子项），
其余错误**沿用现状**（记日志、`continue`，不打断整批）。

**失败语义保持现状**：单个子项失败 ⇒ 记日志继续，**不**把整个任务标 `fail`
（`fail` 会 `adapter.remove(id)` 清掉断点，与「后续子项还要继续」矛盾）。
任务级 `fail` 只留给结构性错误（如存储不可用）。

#### 其余接线点（与单包路径同构）

- `taskManager.start(\`convert-batch-${Date.now()}\`, '批量转换', { resumable: true, totalBytes: 0 })`
  + `taskControls.showRunning(...)`；`totalBytes` 用 0（批量没有单一总量，进度以子项计）
- 每个子项的 `onProgress` 累积该子项的 `doneEntries` 并按 D1.2 的 `maybeCheckpoint` 节流落盘；
  **每完成一个子项强制落一次**（`force`）——子项边界是天然的断点，比 64 条节流更对齐语义
- 收尾四出口与单包**逐字节同构**（含 `AbortError` 的「静默但显示暂停态」，见 D1.2）
- `workbenchBusy` 必须在**暂停时也释放**（否则暂停后工作台一直卡在 busy）—— 沿用 `finally` + 判 `AbortError`

#### D1.3.1 ⚠️ 入口是前置条件：批量转换此前**不可达**（2026-09-27 执行中发现）

**取证**（`grep -rn runBatchConversion` 全仓）：

- 只有 `index.js:424` 的**定义** + 3 处**注释/测试注释**提及 ⇒ **零调用者**；
- 暂存区批量栏（`src/ui/stash-list.js:174-191`）只渲染「载入为源 / 下载 / 写回宿主 / 删除」；
- `src/ui/workbench-template.js` 检索 `btn-batch` / `批量` ⇒ **零命中**；
- 而 `README.md:74` 写着「…**批量转换**与自定义包名」。

⇒ 这是**与 R-16 同族的缺陷**：README 承诺的能力在产品里不可达。
**接在死代码上的续传无法端到端验证** ⇒ 用户裁定（U-7）**必须补上入口**。

**入口设计**（最小、复用既有件）：

1. 在 `src/ui/stash-list.js` 的批量栏增一个按钮
   `mkBtn('<i class="fa-solid fa-wand-magic-sparkles"></i> 批量转换', '把选中的包逐个转换为当前目标格式', cap.canLoad, …)`
   —— 放在「载入为源」之后、「下载」之前（语义相邻：都是"处理源包"）；
   启用条件复用既有 `cap.canLoad`（有产物才能转），**不新造能力判据**；
2. `renderStashList` 增一个可选回调 `onBatchConvert(fileRecords)`（与既有 `onRestoreToHost` 同形），
   由 `refreshArchiveManagerUI` 接到 `runBatchConversion`；
3. `runBatchConversion(sourceRecords, { resumeCheckpoint, resumeTaskId })` 增第二个参数，
   使其可被 `RESUMABLE_HANDLERS` 直接分派（与 `handleHostExport` 同形）；
4. **不加新控件**：目标格式取当前 `#target-select`（与单包转换同源），
   文件名模板取 `#filename-template`（既有 `resolveFilename` 路径）——
   不引入第二套参数面，避免与单包路径漂移。

**为什么不做一个"批量面板"**：`C-6` 与 Out of Scope 都要求不把缺陷修复扩成新功能；
本入口的价值在于让**已有实现可达**（并让 README 的承诺成立），不在于新增交互面。

### D1.4 必须守住的既有约束

- **L1-MR-8**：`worker.terminate()` 后置空引用 —— **`worker-client.js:140` 已经做了**，
  本设计**不得**在 `index.js` 侧引入第二处 terminate（那会绕过该保护）。续传只经 `signal`。
- **L1-MR-9**：高频进度回调必须 rAF 合帧 —— 既有 `onProgress` 已合帧，新增的累积逻辑
  **只做 Map.set**（无 DOM 触碰），不得在回调里加渲染。
- **L1-MR-7**：有界等待 —— 不新增裸 `await`；`runConversionTask` 的 Promise 已由
  abort/error/DONE 三出口保证 settle。
- **`core/` 禁 DOM**：`taskKindOf` / 分派表放 `index.js`（根控制器），**不进 `src/core/`**。

### D1.5 测试设计

| 测试 | 层次 | 断言 |
| --- | --- | --- |
| `taskKindOf` 分派 | 单测（新文件 `test/task-kind.test.js`） | 三个前缀各自解析正确；未知 id 返回 `null`；**前缀重叠负例**（`fetch-` 不得吃下 `convert-`） |
| 状态机续传契约 | 单测（既有 `test/task-manager.test.js` 扩写） | `resume` 仅在 `paused && resumable` 时返回清单；`abort` 后返回 `null` |
| 断点命中跳过 | 单测（`transform` 层，既有夹具） | 给出 `resumeCrcMap` ⇒ `report.resumedCount > 0` 且产物条目数不变 |
| **Worker 路径回调契约**（D0.2b 的守护） | 单测（新） | 注入**只调 `onProgress`、从不调 `onEntryDone`** 的假执行体（**模拟 Worker 路径**）⇒ `onCheckpoint` **仍被调用**。**判别力证明**：把落盘改回只挂 `onEntryDone` ⇒ 本用例转红 |
| 节流与「不超前」 | 单测（新） | 累积 ≤63 条时**不** materialize（`onCheckpoint` 调用次数 < 条目数）；末条 `current === total` 强制落一次；**断点内容 ⊆ 已完成条目**（方向断言） |
| `AbortError` 静默 | 单测（新） | 执行体 reject `AbortError` ⇒ **不调 `fail()`、断点仍在**，且调了 `showPaused`（这条是 D1.2 的守护） |
| 端到端续传 | E2E（矩阵 M-7 升级） | 真实 pause → resume ⇒ `resumedCount > 0` 可观测；控制条状态机 `running→paused→running` |
| **批量：前缀重叠**（D1.1） | 单测（`test/task-kind.test.js`） | `convert-batch-<ts>` ⇒ `'convert-batch'`（**不得**被 `convert-` 吃掉）；`convert-<ts>` ⇒ `'convert'` |
| **批量：子项游标续传**（D1.3） | 单测 | 断点 `itemIndex = k` ⇒ 恢复时**跳过**前 k 个子项、**从第 k 个开始**；`outputs.length` 与已入队产物一致 |
| **批量：跨重载失效检测**（D1.3 / U-6） | 单测 | 队列中该 `taskId` 的产物数 ≠ `outputs.length` ⇒ 断点**作废**（`abort` + clear），**不得**硬续。**判别力证明**：去掉判据 ⇒ 用例转红 |
| **批量：循环内 AbortError 必须 break**（D1.3） | 单测 | 第 k 个子项 reject `AbortError` ⇒ **第 k+1 个子项不得被处理**（断言执行体的调用次数 == k+1） |
| **批量：`doneEntries` 每子项重置**（D1.3） | 单测 | 两个子项含**同名条目**时，第二个子项**不得**因第一子项的 crc 清单而跳过该条目 |
| 批量端到端续传 | E2E | 多包批量 → 中途 pause → resume ⇒ 已完成子项**不重跑**、产物齐、`resumedCount` 可观测 |

> ⚠️ **为什么单测之外还必须有一条 E2E**：单测跑在 Node（主线程路径），
> **无法覆盖 Worker 路径**（D0.2b）。「Worker 路径回调契约」那条单测用**假执行体**把契约变成了
> 可断言的形式，但它断言的是**我们自己的接线**，不是真实的 `postMessage` 行为。
> ⇒ `AC-B3(a)` 的 E2E（真浏览器 / 真 Worker）**不可省**，它是这一类缺陷的唯一真守门人。

**负例纪律**（本仓「先证明判定能抓到违规」）：`AbortError` 那条必须**实测证明判别力** ——
把它改成 `fail()` 后测试转红，再改回。

---

## D2 R-17 设计：入口守卫

### D2.1 修法

用 `node:url` 内置的 `pathToFileURL`（**不引新依赖**，符合 L1-MR-11）：

```js
import { pathToFileURL } from 'node:url';

// 仅当作为 CLI 直跑时执行（被 import 时零副作用）
const isCliEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliEntry) { /* …既有 CLI 分支… */ }
```

`process.argv[1]` 的**存在性守卫**不可省：无参数调用（或某些测试环境）下它是 `undefined`，
`pathToFileURL(undefined)` 会抛。

### D2.2 双向负例守护（PRD AC-B2 要求）

「直跑产出 ✓」**与**「import 无副作用 ✓」是**两个方向**，缺一不可：

```js
// test/gen-fixtures-cli.test.js
it('作为 CLI 直跑：确实产出文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'genfix-'));
  execFileSync(process.execPath, [GEN_JS, dir], { cwd: REPO_ROOT });
  assert.ok(readdirSync(dir).length > 0, 'CLI 入口必须产生产物（修复前此处为空目录）');
});

it('作为模块 import：零副作用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'genfix-'));
  const before = readdirSync(dir).length;
  await import(url.pathToFileURL(GEN_JS).href);
  assert.equal(readdirSync(dir).length, before);
});
```

**为什么这条测试必须存在**：R-17 的失效形态是**静默空操作**（退出码 0、零输出）。
没有「确实产出」这个方向的断言，`gen.js` 未来再坏一次**仍然不会被发现**。

### D2.3 顺带排查（PRD OQ-3）

`npm test` 中是否有用例**依赖了「CLI 不产出」这个错误前提**（例如用 `npm run gen-fixtures`
作为前置步骤却实际拿到空目录）。**只读排查**，命中则登记并单独处置，不在本任务内顺手改测试语义。

---

## D3 R-19 设计：只读调试出口

### D3.1 出口形态（用户裁决：**新增**）

在 `src/ui/host-bridge.js`（**平台差异的唯一落点**，L0-9）内导出：

```js
/** 只读调试探针：供 E2E 断言恢复能力三态。**只读**，无任何副作用。 */
export function getRestoreProbe() {
  return Object.freeze({
    capability: restoreCapability,
    unsupportedReason: restoreUnsupportedDetail || '',
  });
}
```

`index.js` 侧把它挂到**一个命名空间对象**下（而非散落挂多个全局）：

```js
window.__stZipConverterDebug = Object.freeze({
  getRestoreProbe,          // 冻结对象，外部不可改写
  // 后续可加别的只读探针，但**只许加只读的**
});
```

### D3.2 三条硬约束

1. **只读**：返回 `Object.freeze` 的快照；**不得**暴露可写 setter（否则 E2E 能伪造状态，
   断言就失去判别力）。
2. **不成为攻击面**：只暴露**能力布尔/枚举**，**不得**暴露 CSRF token、handle、路径等
   （`host-bridge.js` 的 `getCsrfToken` / `getHandle` 已有自己的受控路径，**不得**从这里漏出）。
3. **命名冲突守卫**：挂载前检查 `window.__stZipConverterDebug` 是否已被占用，
   已占用则**不覆盖**并 `logger.warn`（宿主或别的扩展可能同名），单测覆盖该分支。

### D3.3 测试

| 测试 | 断言 |
| --- | --- |
| 单测 | `getRestoreProbe()` 初始为 `{capability:'unknown'}`；探测为不支持后变 `unsupported` 且 `unsupportedReason` 非空 |
| 单测 | 返回对象**冻结**（`Object.isFrozen === true`；写入静默失败/严格模式抛错） |
| 单测 | `window.__stZipConverterDebug` **已存在时不覆盖**，且发出 warn |
| E2E | 矩阵 M-8 从「仅验可见性契约」升级为**直接断言三态**（保留既有可见性断言作为互证） |

---

## D4 交付边界（本设计**不做**什么）

| 不做 | 理由 |
| --- | --- |
| 不重写 `core/` 任何执行逻辑 | D0.1 证明核心层已完备；重写是**无收益的风险** |
| 不修 `test/real-samples.test.js` 的满载超时（R-10） | 既有抖动、与本任务无关，独立登记 |
| 不改 `src/vendor/**` | L1-MR-11 / 仓群铁律 |
| 不把 `restoreCapability` 的**探测**行为改成自动触发 | 探测会对实例发真实 POST（R-19 已登记风险）；本轮**只加出口**，不改探测时机 |
| **不为批量续传改存储语义**（不把产物在暂停时自动入库） | 用户裁决 U-6：同会话可续 + 失效检测 ⇒ 无需动「临时产物下载/存工作区才入库」的既有契约 |
| 不改批量**单子项失败继续**的既有语义 | 只有 `AbortError`（暂停/中止）才 `break`；其余错误沿用现状（D1.3） |

## D5 风险与回滚

| 风险 | 缓解 | 回滚 |
| --- | --- | --- |
| 转换暂停后**无法续传**（断点被 `fail()` 清掉） | D1.2 的 `AbortError` 静默分支 + 专门单测 | 回到「不接线」状态（纯删改动，`core/` 未被触碰 ⇒ 回滚面=1 个文件） |
| **断点落盘挂在 Worker 路径不触发的回调上**（D0.2b） | 落盘挂 `onProgress` + **假执行体单测** + **真浏览器 E2E**（双重守护） | 同上一行 |
| 接线后**正常转换变慢**（每条目回调 + Map.set） | 累积只做 `Map.set`；**未到窗口连对象都不建**（D1.2 的 `maybeCheckpoint`） | 移除 `onProgress` 里的 `maybeCheckpoint` 调用即可 |
| **批量续传跳过产物已丢失的子项**（页面重载后） | D1.3 的**可验证前提**（核对队列中该 `taskId` 的产物数）+ 判别力单测 | 去掉失效检测 ⇒ **不可接受**（会静默产出残缺批次），故该项**无回滚、只有前置拦截** |
| **批量暂停后仍继续跑下一个包**（`catch` 吞掉 `AbortError`） | D1.3 的 `break` + 「执行体调用次数」单测 | 单文件（`index.js`）回滚 |
| `window.__stZipConverterDebug` 与宿主/他插件冲突 | D3.2 的占用检查 + 不覆盖 | 删除该挂载 |
| 改 `fixtures/gen.js` 触发既有测试的隐含前提 | D2.3 的只读排查先行 | `fixtures/gen.js` 单文件回滚 |
| **实例未更新导致 E2E 验证的是旧代码**（R-20） | 任何插件代码改动后，**先按 R-20 更新 Dev 实例再跑 E2E** | — |

**改动面预估**：`index.js`、`src/ui/host-bridge.js`、`src/ui/export-queue.js`（**仅加一个可选字段**）、
`fixtures/gen.js` 四个源文件 + 5–6 个测试文件。`src/core/**` **零改动**（这是本设计最重要的性质）。