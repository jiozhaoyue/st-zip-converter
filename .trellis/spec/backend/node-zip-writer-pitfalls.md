# Node 侧 zip 写入的坑（`src/core/zip-io.js`）

> **来源**：2026-09-26，任务 `09-26-all-instance-data-sync-e2e`。在**真实包规模**
> （1602.7 MB / 8683 条目）上跑 Node 侧 `convert()` 时暴露，四处缺陷互为表里。
> 原始证据链与逐项排除记录见 `research/build-packs-blocker.md`（**本文件自包含**，
> 不依赖任务目录）。
>
> **为什么必须写下来**：这四处缺陷的可见形态都是「**无报错、退出码 0、产物半截**」，
> 排查成本极高；且仓内既有的真实包往返用例**长期处于 skip**（样本包不在仓内），
> 所以这条路径在本机**从未被真正跑过**。

## 1. 症状速查：看到这些先怀疑本文件

| 症状 | 八成是 |
| --- | --- |
| Node 进程**静默 exit 0**，无任何错误输出，产物只有几 MB | 某个 promise 永不 settle + 事件循环空转 |
| 落点文件**字节数恒为 0**，`close()` 永不返回，RSS 涨到 1–1.5 GB | `bufferedWrite: true` 整条缓冲 |
| 控制台只有 `ERR_INVALID_STATE: ReadableStream is locked`，看不到真正的错误 | `openStream` 在已锁流上 `cancel` |
| 条目数写了几千条后停滞，RSS 稳定不动 | 背压窗口把排队者也算进去了（自锁） |
| 循环里大批投递后**几乎没有并发上限** | 背压窗口被放在了首条目分支之后 |
| 进程报 `FATAL ERROR: … near heap limit … out of memory`，落点停在几百 MB | **投递积压**把内存峰值推到 GB 级（见 §5）。**不是「堆不够」** —— 加堆只是掩盖 |

## 2. 四条硬约束（违反即复现上述症状）

### 2.1 `openStream` 的失败路径不得在已锁流上 `cancel`

```js
// ✗ 错误：readable 被消费方 pipeTo 锁定后，cancel() 自身抛 ERR_INVALID_STATE；
//   该抛出在 .catch() 回调里 ⇒ 升级为**未处理拒绝** ⇒ Node 直接杀进程，
//   且把真正的主错误彻底掩盖。
entry.getData(writable).catch((err) => readable.cancel(err));

// ✓ 正确
entry.getData(writable).catch((err) => {
  if (!readable.locked) readable.cancel(err).catch(() => {});
});
```

流被锁定时**不需要**再 cancel —— 错误本就会经 TransformStream 自然传播给消费方。

### 2.2 `bufferedWrite` 不得默认开

`zip.js` 的 `bufferedWrite: true` 会为**每个条目**建一个 `highWaterMark: Infinity`
的临时流，把整条数据缓冲完才写目标。实测对照（同源包、同落点、唯一变量是该标志）：

| `bufferedWrite` | 结果 | 落盘 | RSS | 耗时 |
| --- | --- | --- | --- | --- |
| `true` | ❌ `close()` 永不返回 | **0 字节** | 1.0–1.5 GB | 挂死 |
| `false` | ✅ 8572 条全过 | **614 MB** | ~330 MB | **82.4 s** |

⇒ `createWriter` 的默认值必须是 `false`，且保留为可覆盖选项。

### 2.3 背压窗口**只能**统计「正在写入」的条目

```js
// ✗ 错误：排队者也被 track 进 inflight，而排队者本身永不 settle
//   ⇒ 排队数一超 CONCURRENCY，inflight.size 就永远降不下来
//   ⇒ waitForSlot() 在等待一批永不 settle 的 promise 上**永久自锁**。
function track(promise) { const w = promise.finally(() => inflight.delete(w)); inflight.add(w); return w; }
async function waitForSlot() { while (inflight.size >= CONCURRENCY) await Promise.race(inflight); }
```

**纯形态复刻实测**（不涉及 zip，100 条任务 × 5 ms 延时、`CONCURRENCY=6`）：
**2 s 后只完成 6 条（= CONCURRENCY），`inflight` 仍挂 94 条** —— 自锁成立。

⇒ 必须**分两个集合**：`inflight`（只在跑，供背压）与 `pending`（全部未完成，供
`close()` / `abort()` 等齐）。**只等 `inflight` 的 `close()` 会漏掉排队者，
产出「少了条目却看着完整」的包。**

### 2.4 取背压窗口必须发生在「首条目闸门」**之后**

原实现把窗口放在 `if (!firstEntryDone)` **之后**，而 `firstEntryDone` 只在首个条目
**写完**才置位。`convert()` 是在紧凑的 `for await` 循环里**同步、不 await** 地投递
全部条目（`transform.js` 的 9 处 `addLazy` 调用点）—— 于是所有任务开跑时该标志仍为
`false`，**全部走首条目分支、无一经过背压** ⇒ **无界并发**。

⇒ 首条目顺序语义要用**显式闸门**（`firstEntryClaimed` + 一个 promise + `finally` 放行）
表达，并把 `acquireWriteTurn()` 放在闸门之后；闸门必须在**同步段**认领，否则认领会飘。

## 3. `zipIo.createWriter` 的 `io` 契约（供自建适配器时对齐）

| 方法 | 契约 |
| --- | --- |
| `io.openReader(src)` | → `{ totalEntries, entries(): AsyncIterable<{fileName, uncompressedSize, openStream(), read(), skip()}>, close() }` |
| `io.createWriter(dest, {level})` | → `{ add(name, data), addLazy(name, openFn, byteSize), waitForRoom(), getStoreStats(), close(), abort() }` |

两条**静默陷阱**：

1. **`add(name, data)` 内部是 `new Uint8Array(data)`** ⇒ **把 `ReadableStream` 传给它不会报错，
   而是静默写成 0 字节条目**。流式写入**必须**走 `addLazy(name, openFn, byteSize)`。
   （首版「顺序重打包」就是这样产出 8572 条 / 仅 2.0 MB 的假成功。）
2. **字符串落点走 `Uint8ArrayWriter`** ⇒ 整个产物先进内存、`close()` 时才 `writeFile`。
   想要真流式落盘，必须传**非字符串**的自定义 `Writer`（`zipIo.createWriter` 对非字符串目标原样使用）。

## 4. 大包在 Node 上不进内存的可用做法（已实测）

```js
// 输入：fs.openAsBlob 给的是**磁盘惰性 Blob**，zip.BlobReader 按需切片读
// ⚠️ fs.openAsBlob 挂在 node:fs 上，**不在** fs/promises 上（Node v24 实测）
const blob = await require('node:fs').openAsBlob(path, { type: 'application/zip' });
const zipIo = await import('../src/core/zip-io.js');
const reader = await zipIo.zipIo.openReader(blob);

// 输出：自建文件 Writer（实现 init/writeUint8Array/getData），
//       注意 init() 里**必须调 super.init()**，否则首个条目就抛 "Writer not initialized"
class FileWriter extends zip.Writer { /* … */ }
const writer = await zipIo.zipIo.createWriter(new FileWriter(out), { level: 5 });
```

**可用的工作形态（实测跑通全量 8572 条 / 614 MB）**：

| 形态 | 耗时 |
| --- | --- |
| 顺序 `await` 每条 | 82.4 s |
| 批次 8 条、每批 `await` | 72.5 s |

## 5. 真源规模下的内存峰值：投递侧无背压 ⇒ 默认堆 OOM（**已修复**）

修完 2.1–2.4 之后，`convert()` 在真源包上**仍会失败**，形态是**明确的 OOM**：

```
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
```

### 5.0 根因与修复（**一行结论**）

> **根因**：`convert()` 在紧凑的 `for await` 循环里**同步、不 await** 地投递全部条目，
> 而 `addLazy` 是同步登记 —— 于是「已受理未完成」的条目可以积压到**近千条**（窗口本应只有 8）。
> **修复**：`transform.js` 每处理 `WRITE_BATCH`（16）个源条目就 `await writer.waitForRoom()`，
> 由 `zip-io.js` 的 `waitForRoom(maxPending = CONCURRENCY)` 把积压压回窗口量级。

**修复前后实测对照**（同一源包 1602.7 MB / 8683 条 → 产出 619.3 MB / 7748 条）：

| 指标 | 修复前（全量投递） | 修复后（分批投递） |
| --- | --- | --- |
| 「在飞」峰值 | **916 条** | **24 条** |
| `heapUsed` 峰值 | **6262 MB** | **123 MB** |
| RSS 峰值 | 6807 MB | **463 MB** |
| 耗时 | **182.0 s**（且**必须** 8 GB 堆） | **54.8 s**（**默认堆即可**） |
| 产出 | 619.3 MB / 7748 条 / 零丢失 | **完全一致** |

⇒ **这是内存与吞吐的双赢，不是拿速度换内存**：全量投递时 GC 剧烈抖动，落盘成片停滞
（实测同一批量下 `.partial` 每次停 5–10 s）；把积压压下去后反而**快 3.3 倍**。

> **教训**：「拉大堆」只是**掩盖**问题（`--max-old-space-size=8192` 确实能让它跑完），
> 真正该问的是**为什么会有近千条在飞**。看到 OOM 先查投递/消费速率比，再考虑加堆。

### 5.1 定位过程（可复用的手法，**都是不改产品代码的**）

- **排除 worker 数**：伪造 `globalThis.navigator.hardwareConcurrency` 为 20/4/2 三档 ——
  低 worker **反而更早 OOM**，且三档**前 15 s 读数逐字相同**（投递节奏由源包读取决定，与并发配置无关）。
  该属性必须在 `import` 产品模块**之前**设置（产品在**模块顶层**就读它并 `zip.configure(...)`）。
- **排除 worker 通信**：`--no-workers`（在 `createNodeIo()` **之后**再 `zip.configure({useWebWorkers:false})`
  覆盖产品的顶层配置，zip.js 是「后设置生效」）—— heap **依旧冲到 6195 MB**，与 worker 无关。
- **排除数据 buffer**：同一时刻 `external` 仅 76 MB、`arrayBuffers` 仅 57 MB
  ⇒ 峰值是**纯 JS 堆对象**，不是二进制数据囤积。
- **排除源包整读**：`openReader` 返回后 `heapUsed` 仅 87 MB、`arrayBuffers` 2.3 MB
  （`fs.openAsBlob` 给的是磁盘惰性 Blob）。
- **排除条目处理逻辑**：全量 `dryRun` 只要 0.7 s、内存正常 ⇒ 问题在**数据流管道**而非遍历。

### 5.2 一个未能完成的定位手段（如实登记）

`--heapsnapshot-near-heap-limit=1` 在本机**不可用**：写快照本身的内存压力让进程直接死亡，
只留下 **0 字节**的 `.heapsnapshot` 文件（实测于 1536 MB 与默认堆两种配置）。
**不要**依赖它来诊断这条路径 —— 5.1 的对照手法更省事且够用。

### 5.3 守护与浏览器侧的连带收益

| 项 | 说明 |
| --- | --- |
| **守护** | `npm test`（**45 passed / 1 skipped（46 文件）、429 passed / 2 skipped**，零回退）+ 大包自检 `node scripts/instance-sync/selftest-node-zip-io.cjs --large <真源包.zip>`。⚠️ 本节的缺陷**无法用快速单测守护**：小规模下两种投递方式都正常，唯一触发维度是**总规模**。 |
| **堆自举（保险，非必需）** | `scripts/instance-sync/build-packs.cjs` 内置堆自举，阈值 **4096 MB** —— 低于默认堆上限（4288 MB），故**正常调用不触发**；只在调用方**显式**给了更小的堆时才介入。 |
| **浏览器侧** | `worker-client.js` / `converter-worker.js` 走的是**同一个 `convert()`**，故同受此修复保护。此前浏览器侧若在 GB 级包上「卡死、无报错」，很可能就是本节的投递积压（浏览器没有显式的堆上限闸门，表现为标签页卡顿乃至崩溃）。 |
| **不要再做的事** | 用「给足 8 GB 堆」绕过。它**掩盖**了真正的投递积压，且耗时（182 s）反而是修复后（54.8 s）的 **3.3 倍**。 |

> **遗留**：无。曾登记为「未解释」的那个 6.2 GB 瞬时峰值，已随根因明确而得到解释
> —— 它就是**近千条在飞任务及其链条上的临时对象**，压掉积压后峰值降到 123 MB。

## 6. 可执行守护

| 检查 | 命令 |
| --- | --- |
| 单测（零回退基线） | `npm test` → **45 passed / 1 skipped（46 文件）、429 passed / 2 skipped** |
| 大包流式自检（**唯一**能抓 2.2/2.3/2.4 的可执行检查） | `node scripts/instance-sync/selftest-node-zip-io.cjs --large <真源包.zip>` |
| 内存去向诊断（投递/完成/在飞 + heap/RSS 打点） | `node scripts/instance-sync/diag-convert-memory.cjs --target l`（`--hw N` 伪造核数做对照） |

> ⚠️ **这套缺陷无法用快速单测守护**：单条目 4 MiB 时 `bufferedWrite` 真/假**都**边写边落盘；
> 4000 条 × 4 KB 两种模式也都 0.8 s 正常。唯一触发维度是**总字节**（GB 级），
> 注定进不了 `npm test`。故守护放在上表第二行的**显式大包自检**里
> （判据：落点字节在有界时间内持续增长，连续 90 s 零增长即判失败）。
> **不要**为此写一个在小规模下「无论怎样都通过」的测试充数。
