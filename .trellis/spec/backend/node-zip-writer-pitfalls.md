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

## 5. 尚未定位的遗留（**别当成已解决**）

修完 2.1–2.4 之后，`convert()` 在真源包上**仍会停滞**：首次落盘 5.0 s、写到
**299.8 MB / 2000 条**后零增长（纯全量投递则 5.8 MB 后停滞，RSS 稳定 680 MB）。
成因未查明 ⇒ 大包转换**暂时不要**在 Node 侧跑全程；已登记的阻塞见任务
`09-26-all-instance-data-sync-e2e` 的残留 R-1。

## 6. 可执行守护

| 检查 | 命令 |
| --- | --- |
| 单测（零回退基线） | `npm test` → **45 passed / 1 skipped（46 文件）、429 passed / 2 skipped** |
| 大包流式自检（**唯一**能抓 2.2/2.3/2.4 的可执行检查） | `node scripts/instance-sync/selftest-node-zip-io.cjs --large <真源包.zip>` |

> ⚠️ **这套缺陷无法用快速单测守护**：单条目 4 MiB 时 `bufferedWrite` 真/假**都**边写边落盘；
> 4000 条 × 4 KB 两种模式也都 0.8 s 正常。唯一触发维度是**总字节**（GB 级），
> 注定进不了 `npm test`。故守护放在上表第二行的**显式大包自检**里
> （判据：落点字节在有界时间内持续增长，连续 90 s 零增长即判失败）。
> **不要**为此写一个在小规模下「无论怎样都通过」的测试充数。
