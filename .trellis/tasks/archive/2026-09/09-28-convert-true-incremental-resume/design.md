# 技术设计 · 转换路径真增量续传

> 需求与验收见 `prd.md`。本文件写**边界、契约、数据流、权衡、回滚**。
> 所有 `file:line` 为 2026-09-28 现场核对值。

## 0 设计的支点：一条不变量

整个改动围绕一条不变量展开：

> **跳过 ↔ 丢数据 的解耦**：*「跳过一个条目」的充分条件，从「断点清单说它做过了」改为「目标包里真的有它」。*

一句话就能推出全部行为：

| 情形 | 旧行为 | 新行为 |
| --- | --- | --- |
| 传了 crc 清单，**没**传半成品（旧的全部调用点、批量、降级路径） | 跳过 ⇒ **丢条目** | 清单降级为候选集 ⇒ **一条都不跳过** ⇒ 完整重做（正确） |
| 传了清单 **且** 传了同源半成品 | 跳过 ⇒ 丢条目 | 跳过 ⇒ 条目**已在输出里** ⇒ 完整且免重压缩（增量） |

**这就是为什么不必再争论「断点记的是读到的还是写入的」**：判据不再是任何记账，而是产物的字节事实。台账与事实不一致时，以事实为准——这是本缺陷类的**结构性**消灭，不是打补丁。

## 1 边界与分层

```
src/core/transform.js        ← 唯一改动的纯逻辑层
   ├─ 新增 options.appendFrom / options.finalizeOnAbort
   ├─ 新增「同源校验」预备遍历（仅在有 appendFrom 时）
   └─ 跳过判据：writer.has(outPath) （清单只作冗余校验）

src/core/zip-io.js           ← IO 适配层新增两个方法
   ├─ writer.appendFrom(source)  → 读源清单 + appendZip + 登记 written + 回传清单
   └─ writer.has(name)           → 目标包是否已含该条目

src/core/worker-client.js    ← 协作式暂停协议（主线程侧）
src/core/converter-worker.js ← 协作式暂停协议（worker 侧，自持 AbortController）

index.js                     ← 半成品持久化 + 续传接线（唯一碰 OPFS 的层）
src/core/task-manager.js     ← 允许 PAUSED 态写断点（一行语义放宽）
```

`src/core/**` 仍无 DOM 依赖：OPFS 只在 `index.js` 与 worker 的浏览器分支出现，`convert()` 只见 `Blob|File|string`。

## 2 契约变更（逐条）

### 2.1 `zipIo.createWriter()` 的返回对象（加性）

```js
{
  add(name, data), addLazy(name, openFn, byteSize), waitForRoom(maxPending),
  getStoreStats(), close(), abort(),              // 既有，语义不变
  async appendFrom(source): { entries: [{name, crc32, compressedSize}] },  // 新增
}
```

> ⚠️ **不提供 `writer.has(name)`**（初版设计里有，实测后删除）。决策依据：
> `writer` 的名单同时含「**本轮已写入**」与「**搬运来的**」两种条目，而**两个不同的源条目可能映射到
> 同一个产物路径**（PT 目标下用户级 `extensions/<x>/**` 与第三方 `extensions/third-party/<x>/**`
> 是同一条产物路径）⇒ 用「writer 是否已含该名字」当跳过门，会把「本轮先写的那份」误当成
> 「半成品里已有」，从而**提前 `continue` 掉本该走「保留第三方副本」分支的条目**。
> 2026-09-28 实测：由此误跳过 2 个用户级扩展条目，且只有**全量**测试才暴露（单跑新用例文件全绿）。
> ⇒ 跳过门只认 `appendFrom` **回传的清单**（`convert` 侧记为 `appendedNames`）：一个概念、一个用途。

`appendFrom(source)` 的实现步骤（顺序不可颠倒，理由逐条写死）：

1. `openReader(source)` 取**中央目录**（不解压、不读数据流）⇒ 得到 `entries`；
2. 调 vendor `writer.appendZip(new zip.BlobReader(blobOrFile))`
   —— **必须传 `zip.BlobReader` 实例**（实测：裸 `Blob` / `Uint8Array` 抛
   `TypeError: Cannot read properties of undefined (reading 'getReader')`，读数见 `research/appendzip-probe.json`）；
3. 把 `entries` 的名字登记进既有的 `written` 集合（`zip-io.js:182`）
   —— `appendZip` **不回传**条目名，不登记则后续 `add` 同名条目会走 `written.has` 早返……
4. 回传 `entries`（供上层做同源校验与读数）。

> ⚠️ 第 3 步与「同源校验」是**互锁**的：第 3 步让同名 `add` 静默早返（`zip-io.js:273` / `:307`），
> 所以**同源校验必须发生在这之前**（在 `convert()` 里、调 `appendFrom` 之前）。
> 若源已变而仍搬运，产物会混入陈旧条目且**不报错**——这正是 `prd.md` R4 要防的。

### 2.2 `convert()` 的新选项

| 选项 | 类型 | 语义 |
| --- | --- | --- |
| `appendFrom` | `Blob\|File\|string\|null` | 同源半成品；提供时先校验再搬运，随后按「存在即跳过」续写 |
| `finalizeOnAbort` | `boolean`（默认 `false`） | 中止时把 writer `close()`（产出合法半成品）而非 `abort()`；**非中止错误仍走 `abort()`** |

`finalizeOnAbort` 落点在 `transform.js:662-668` 的 `try/catch/finally`：
现在的 `catch (error) { await writer.abort(); throw error; }` 改为按错误类型分流
（`err.name === 'AbortError' && finalizeOnAbort` ⇒ `close()`，其余 ⇒ `abort()`）。
**不得**把真失败也收尾成一个「看着完整」的包——那会把「失败」伪装成「暂停」。

`finalizeOnAbort` 下**跳过 `emitSynthesized`**：合成条目（manifest 等）由**续传那一轮**在末尾统一产出；
否则半成品里会留下一份「按半量数据合成的 manifest」，续传后又不重合成 ⇒ 元数据与内容不符。

### 2.3 跳过判据（`transform.js:364-371` 重写）

```
旧： if (resumedCrc && entry.crc32 != null) { 命中 doneCrc === entry.crc32 ⇒ skip }
新： const outPath = targetEntryPath(routeSource(entry.fileName, layout).hubPath, target);
     if (appendedNames.has(outPath)) {                      // appendedNames 只含「搬运来的」
        const doneCrc = resumedCrc?.get(entry.fileName) ?? resumedCrc?.get(skipHub);
        if (doneCrc == null || doneCrc === entry.crc32) { skip; report.resumed(outPath); continue; }
     }
```

- `appendedNames.has(outPath)` 是**必要**条件（即使没给台账）；
- 台账降级为**冗余校验**：给了且 crc 不等 ⇒ 不跳过（保守，宁重做）；
- `report.resumed` 仍记名字 ⇒ 既有计数读数（`report.totals.resumed`）不变。
- ⚠️ 判据的锚点从「台账的 target 标签」改成了「**名字 + 内容能对上**」：实测 ST 半成品续传到
  L 目标是**合法**的（名字仍落在 L 的产物路径上、crc 也对得上）⇒ 判据不该因「标签不同」而无脑作废；
  真正错位的布局（ST 半成品 → TT 目标）会整批成为孤儿，由 §2.4 的①拦下。

### 2.4 同源校验（仅 `appendFrom` 存在时）

在创建 writer **之前**做一次只读预备遍历：

1. 打开源包 reader，遍历中央目录，对每条算 `outPath = targetEntryPath(routeSource(...).hubPath, target)`；
2. 与半成品清单求交：`mapped = { outPath → crc32 }`；
3. 判定 **同源成立** 当且仅当：
   - `mapped.size === partial.entries.length`（半成品每条都能对应到一个源条目，无孤儿）；
   - 且对每条 `mapped`，`partial.crc === source.crc`；
   - 且 `checkpoint.target === 当前 target`（布局不同则名字空间不同，必然错位）。
4. 任一不成立 ⇒ **作废半成品**：`onDiscardPartial()` 回调（由调用方清 OPFS + 清断点）+
   `logger.warn` + 从零重做（即 `appendFrom = null`，继续正常转换 ⇒ 产物完整）。

**代价**：多一次中央目录遍历（不读数据流、不解压）。与既有 `detectFromReader` 的检测遍历同量级。

**为什么用「中央目录」而不是「重跑一遍路由」**：路由是纯函数，但遍历条目流会触发数据读取；
只读中央目录即可拿到 `fileName + crc32`，成本可忽略。

### 2.5 协作式暂停协议

**主线程侧（`worker-client.js`）**

```
onAbort():
  settled = false
  finish(partial):
    if settled return; settled = true; clearTimeout(t)
    try { worker.terminate() } catch {}
    workerInstance = null                      // L1-MR-8，不得回归
    cleanup()
    if (partial) { await onPaused(partial) }   // 有界；失败 ⇒ 视作无半成品
    reject(new DOMException('…', 'AbortError'))  // C-3：对外仍是 AbortError
  t = setTimeout(() => finish(null), PAUSE_FINALIZE_TIMEOUT_MS)   // L1-MR-7 有界兜底
  worker.postMessage({ type:'PAUSE', id })
  handler 收到 PAUSED ⇒ finish({ partialBlob, manifest })
```

- **超时兜底是正确性的一部分**：`finish(null)` ⇒ 无半成品 ⇒ 续传完整重做（`prd.md` R5）。
  没有它就会出现「等不到半成品又不终止」的挂死。
- `onPaused` 在 `reject` **之前** await ⇒ 用户刚点暂停就立刻点继续时，半成品已落盘。
- `terminate()` 一律发生（无论有无半成品）⇒ 死 worker 不会留活（`L1-MR-8` 原始教训）。

**worker 侧（`converter-worker.js`）**

- 每条 `CONVERT` 消息创建**自己的** `AbortController`，把 `signal` 真正传进 `convert()`
  （现状 `worker-client.js:130` 删掉了 `signal`——AbortSignal 不可 `postMessage`，所以必须由 worker 自持）；
- 收到 `{type:'PAUSE', id}` ⇒ `controller.abort()`；
- `convert()` 抛 `AbortError` 且 `finalizeOnAbort` ⇒ 关包 ⇒ 读半成品中央目录 ⇒
  `postMessage({ type:'PAUSED', id, partialBlob, manifest })`；
- 非 `AbortError` 的失败仍走 `ERROR`（不得伪装成暂停）。

**Node / 无 Worker 路径**：同一条语义在主线程内联完成——
`convert()` 的 `finalizeOnAbort` 关包 ⇒ 主线程分支 `catch (AbortError)` ⇒
`await onPaused({ partialBlob: await destination.getData(), manifest })` ⇒ 重新抛 `AbortError`。
测试可直接驱动这条路径（无需浏览器）。

## 3 半成品持久化（`index.js`）

- **位置**：OPFS `fetch-tmp/`，名字 `convert-<taskId>.partial.zip`
  —— 复用 `host-bridge.js:663 opfsTmpHandle()` / `:679 opfsTmpCleanup()` 与 `:696 opfsHandleToFile()`；
  `index.js:993-995` 的 `opfsCleanupId/Name` 已是「当前任务半成品归属」的既有登记位，本任务共用。
- **写入**：`handle.createWritable()` → `write(partialBlob)` → `close()`（GB 级不占内存）。
- **断点清单**（`TaskManager.onCheckpoint` 的 manifest）：

```js
{
  partialOpfsName: 'convert-<taskId>.partial.zip' | null,
  target: 'st'|'l'|'tt'|'pt',
  sourceId, sourceName, sourceSize,        // 同源可信度（R4 的第 3 条判据）
  partialEntries: [{ name, crc32 }],       // 半成品清单（同源校验的输入）
  totalEntries,
}
```

- **续传**：`taskManager.resume(id)` 取清单 ⇒ `opfsHandleToFile` ⇒
  `runConversionTask({ ..., options: { appendFrom: file, resumeCrcMap, finalizeOnAbort: true } })`。
- **清理**：成功 ⇒ `complete`（既有）+ 清 OPFS；中止 ⇒ `abort`（既有）+ 清 OPFS；作废 ⇒ 清 OPFS。

### 3.1 `task-manager.js` 的一处语义放宽

`onCheckpoint` 现在只在 `state === RUNNING` 时生效（`task-manager.js:104`）。
但**真断点只能在暂停收尾之后才知道**（半成品是暂停时才生成的）⇒ 必须允许 **PAUSED 态** 写入。

放宽后的守卫：`RUNNING | PAUSED` 可写。**理由写进代码注释**：若不放宽，
暂停后写的才是「能续传的断点」这件事永远做不到（旧实现下暂停存的是「读到哪」的假断点）。
`abort()` 之后（`ABORTED`）仍不可写。

## 4 权衡

| 取舍 | 选择 | 理由 |
| --- | --- | --- |
| 半成品由 worker 直写 OPFS（`WritableWriter`）还是「worker 产出 Blob → 主线程落盘」 | **后者** | ① 复用既有 OPFS 助手，只有一处落盘实现；② 消息通道已在传 `resultBlob`，形状一致；③ Node 路径同形可测。代价是一次内存中转，OQ-1 实测后用读数决定是否改前者 |
| 同源校验用「中央目录比对」还是「源包身份（name+size+mtime）」 | **中央目录比对为主**，身份字段作辅助记录 | 身份字段可能相同而内容已变（重新导出同名包）；crc 比对是真正的同源证据 |
| 半成品缺 `emitSynthesized` 的合成条目 | **接受** | 合成条目在续传那轮末尾统一产出；避免「按半量数据合成的 manifest」留在半成品里 |
| 批量路径本任务内是否也做真增量 | **先只做 R1（安全）**，R6b 视余量 | R1 落地后批量已**不可能丢数据**（无半成品 ⇒ 完整重做）；R6b 是速度优化，可独立交付 |

## 5 兼容性与迁移

- **无迁移**：半成品是临时物，旧版本留下的 `test-results/` / `fetch-tmp/` 残留由既有清理负责；
  旧断点清单（含 `doneEntries` 而无 `partialOpfsName`）在新逻辑下**自然降级**为「完整重做」——不改写、不识别、不报错。
- **对外契约**：`convert()` 中止仍抛 `AbortError`；`runConversionTask` 成功返回形状不变；新增 `onPaused` 回调是**可选**的。
- **规格**：`task-manager.js:6` 的「半成品保留待续传」在转换路径上**由假变真**；
  `.trellis/spec/frontend/state-management.md` 与 `guides/standalone-web-and-cloud-e2e.md` §4.6
  的 `KNOWN-DEFECT` 段必须同步改写（否则规格变假事实，`P-3` 同形）。

## 6 回滚

| 点 | 动作 |
| --- | --- |
| 整体 | `git revert` 本任务提交；改动面 = `transform.js` / `zip-io.js` / `worker-client.js` / `converter-worker.js` / `index.js` / `task-manager.js` + 测试 |
| ⚠️ **不可回滚项** | **「存在即跳过」这一条不得回滚**——回滚它 = 恢复静默数据损失。若必须回退增量部分，只回退 `appendFrom` + 协作式暂停（两条），保留存在门 |
| 半成品残留 | 回滚后 `fetch-tmp/convert-*.partial.zip` 成孤儿 ⇒ 收尾时 `opfsTmpCleanup` 显式清理 |

## 7 实施顺序（先立判据，后接执行体）

1. `zip-io.js` 的 `has` / `appendFrom` + 单测（含 BlobReader 形态、重名、坏包负例）；
2. `transform.js` 的跳过判据改为存在门 + 单测（**AC-1 判别力证明先做**：旧行为转红）；
3. `transform.js` 的 `finalizeOnAbort` + 同源校验 + 单测（AC-4/AC-5/AC-6）；
4. 协作式暂停协议（worker + 主线程 + 超时兜底）+ 单测（AC-7）；
5. `index.js` 接线与半成品持久化 + 降级可观测（AC-10）；
6. E2E 翻转 `KNOWN-DEFECT` + 判别力证明（AC-8/AC-9）；
7. R6b（批量真增量）视余量；规范落库（AC-13）。
