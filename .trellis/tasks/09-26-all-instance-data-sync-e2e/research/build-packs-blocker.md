# 阶段 2 阻塞：Node 侧 `convert()` 在真源包规模上静默挂死

> 日期：2026-09-26 ｜ 发现于 `implement.md` 2.1 实跑产包
> 状态：**阻塞中** ｜ 影响：AC-4（产包）与阶段 3（同步）无法按原设计推进

## 症状

对真源包 `backup-real-luker-20260926-010422.zip`（1602.7 MB / 8683 条目）执行
`convert(src, out, { target: 'l', includeBackups: false, io })`：

- 进程**无任何错误输出**，**退出码 0**，只留下一个 8.6 MB 的半成品包；
- 有界等待心跳显示 heap 在 6 s 内涨到 **1552 MB**（≈ 源包体积）后停滞，
  18 s 时 heap 塌回 9 MB，而 convert 的 promise **永不 settle**。

## 关键机制（已定位）

1. `convert()` 对绝大多数条目调用 `writer.addLazy(...)` 而**不 await**
   （`transform.js:409/426/438/451/550/574/597/621/627`），靠末尾 `await writer.close()` 收口；
   `close()` 内部是 `await Promise.allSettled([...inflight])`（`zip-io.js:250-255`）。
2. 因此只要**任一在飞写入永不 settle**，`close()` 就永不 settle。
3. 而 async 主流程悬在一个永不 settle 的 promise 上时，**Node 的事件循环一旦空转就以退出码 0 静默收工**。
   ⇒ 现象是「无报错、退出码 0、产物半截」，不是崩溃。

## 已排除的原因（逐条实测）

| 假设 | 实验 | 结论 |
| --- | --- | --- |
| 我的 `FileWriter` 有问题 | `node-zip-io` 自证：与产品 `zipIo` 产物**逐条 CRC32 一致**，且 `close()` 前已落盘 | ❌ 排除 |
| 产品 io 没问题、只是我的适配器 | **用产品自身的 `zipIo`（字符串目标）跑同一源包** → 同样静默挂死、无产物、日志 0 行 | ❌ **产品路径同样挂** |
| 磁盘惰性 Blob 读不出来 | `pre-sync` 探针：顺序读 521 条 OK；逐条 `read()` 第 476–499 条全 OK（含 28 MB 条目，310 ms） | ❌ 排除 |
| `openStream()` 与 `read()` 不一致 | 对拍第 3–6 条：`read` 与 `stream` 字节数**逐条相等**（磁盘 Blob 与内存 Blob 都一样） | ❌ 排除 |
| 并发窗口死锁 | 60 条 `addLazy` **完全不 await** + `close()` 收口 → **0.8 s 正常完成** | ❌ 小规模不成立 |
| 写管线本身不通 | 顺序/并发写 12 条（23 MB）均正常；40 条 `openStream` 顺序写正常 | ❌ 排除 |
| 某条数据有毒 | 抽出第 478–520 条（含 3 个 28 MB `backups/` 条目）造 84 MB 小包 → `convert` **正常** | ❌ 排除 |

⇒ **只有「真源包全量规模」这一条件能复现**：小到 84 MB / 60 条都正常，1602 MB / 8683 条必挂。

## 一个本体重要的发现（与阻塞无关但必须记下）

`zipIo.createWriter` 返回的 `add(name, data)` 内部是
`new zip.Uint8ArrayReader(new Uint8Array(data))`（`zip-io.js:193/198`）。
**把 `ReadableStream` 传给 `add()` 不会报错，而是静默写成 0 字节条目** ——
我的第一版「顺序重打包」实验就踩了这个坑：8572 条产出仅 2.0 MB，看着「成功」实际全是空条目。
**流式写入必须走 `addLazy(name, openFn, byteSize)`。**
这类「静默产出错误结果」比报错危险得多，值得进 spec。

## 根因（已确证，2026-09-26）

两个缺陷叠加，都在 `src/core/zip-io.js`：

### Bug A（致命掩盖层）— `zip-io.js:119-122`

```js
openStream: async () => {
  const { readable, writable } = new TransformStream({}, { highWaterMark: 16 });
  entry.getData(writable).catch((err) => readable.cancel(err));   // ← :121
  return readable;
},
```

当 `entry.getData(writable)` 拒绝时，`readable` **已被消费方 `pipeTo` 锁定** ⇒
`readable.cancel(err)` 自己抛 `ERR_INVALID_STATE: ReadableStream is locked`。
该抛出发生在 `.catch()` 回调里 ⇒ 变成**未处理拒绝** ⇒
**Node 24 直接杀死进程**，且**原始错误被彻底掩盖**。实测栈：

```
TypeError [ERR_INVALID_STATE]: Invalid state: ReadableStream is locked
    at InternalReadableStream.cancel (node:internal/webstreams/readablestream:322:9)
    at file:///…/src/core/zip-io.js:121:63 { code: 'ERR_INVALID_STATE' }
```

**正向验证**：把该行换成「已锁则不 cancel」后，进程**不再崩溃**（心跳持续 180 s 以上），
但写入仍为 0 字节 —— 说明 A 只是「把静默挂死变成崩溃」，背后还有 B。

### Bug B（真正阻断层）— `zip-io.js:145`

```js
const writer = new zip.ZipWriter(writerTarget, { level, bufferedWrite: true });
```

**`bufferedWrite: true` 在真源包规模上让 zip.js 一直囤数据、永不落盘。** 表现为：
落点文件被创建（说明 `init()` 已被调用）但**字节数恒为 0**，RSS 稳定在 ~1.0–1.5 GB。

**决定性 A/B**（同一源包、同一 8572 条、同一 `FileWriter` 落点，唯一变量是 `bufferedWrite`）：

| `bufferedWrite` | 结果 | 落盘 | RSS | 耗时 |
| --- | --- | --- | --- | --- |
| **`true`**（产品现值） | ❌ 永不落盘、`close()` 永不返回 | **0 字节** | 1.0–1.5 GB | 挂死 |
| **`false`**（对照） | ✅ `entries=8572` | **643,051,564 字节（614 MB）** | **~330 MB**（有界） | **82.4 s** |

⇒ 两条都是**产品缺陷**，且 Bug A 是「静默数据/进程损坏」形态：
在浏览器里它的可见形态会是「转换卡死、无任何报错」。

## 与既有证据的呼应

`test/roundtrip.test.js:23` 的真实包往返用例写的是：

```js
const L_SOURCE = 'default-user-2026-08-25-172056.zip';
describe.skipIf(!existsSync(L_SOURCE))('真实往返 l→st→l', ...)
```

该样本包**不在仓内** ⇒ 这些真实包往返用例在本机**长期处于 skip 状态**
（本仓当前 2 个 skipped 用例很可能就是它们）。
**产品在 Node 侧对真源包规模的 `convert()` 很可能从未被真正跑过。**

## 完整机制（2026-09-26 定稿）—— 三个缺陷互为表里

修掉前两个之后 `convert()` **仍然挂死**（实测：`--large` 自检写到 37 MB 后静默退出）。
继续二分后拿到完整因果链：

### Bug C（真正的无界并发源）— `zipIo.createWriter` 的 `firstEntryDone` 门

`addLazy` 的形态（`zip-io.js`）：

```js
const task = (async () => {
  if (!firstEntryDone) {          // ← 只有「首个条目写完」才置位
    ……………… 直接 writer.add(…) …… // ← 这条分支**不经过 waitForSlot()**
    await addPromise;
    firstEntryDone = true;
    return;
  }
  await waitForSlot();            // ← 真正的背压只在这里
  …
})();
return track(task);               // ← track 在 IIFE 之后，任务已在执行
```

`convert()` 在**紧凑的 `for await` 循环里同步调用 `addLazy` 且不 await**
（`transform.js` 的 9 处调用点）。于是：**在所有任务真正开跑之前，`firstEntryDone` 一直是 `false`**
⇒ **全部 8572 个任务都走进「首条目」分支**，**无一经过 `waitForSlot()`**
⇒ **无界并发**：8572 个 `writer.add(readable)` 同时压向 zip.js
⇒ 内存囤积 → 落点字节数长期为 0 或停滞 → `close()` 永不返回
⇒ async 主流程悬空 + 事件循环空转 ⇒ **Node 静默 exit 0，不留任何错误**。

这解释了此前的全部观测：heap 涨到 1.0–1.5 GB、落点 0 字节、以及
「用 `bufferedWrite:false` 修掉一层后仍只写到 37 MB」——
因为**并发度并没有被限制**，换掉缓冲策略只是让内存上限低一些。

### Bug D（背压原语自锁）— `waitForSlot` 把排队者也算进窗口

```js
function track(promise) { const wrapped = promise.finally(() => inflight.delete(wrapped));
                          inflight.add(wrapped); return wrapped; }
async function waitForSlot() { while (inflight.size >= CONCURRENCY) await Promise.race(inflight); }
```

`track(task)` 在任务**开始排队时**就把它放进 `inflight`，而排队中的任务本身永不 settle
⇒ 一旦排队数 ≥ `CONCURRENCY`，`inflight.size` **永远降不到 `CONCURRENCY` 以下**
⇒ `Promise.race(inflight)` 从此在等待一批**永不 settle** 的 promise。

**忠实复刻判定**（不涉及 zip，纯形态复刻）：

```
100 条任务，CONCURRENCY=6，每条只做 5 ms 延时
→ 2 s 后完成数 = 6 /100   inflight = 94
⇒ 自锁成立
```

⇒ 两个缺陷互为表里：**当前路径没走 `waitForSlot`（Bug C），走了就自锁（Bug D）。**

### 已落地的两个修复（真缺陷，但**不足以解开阻塞**）

| 编号 | 位置 | 修复 | 效果 |
| --- | --- | --- | --- |
| A | `openStream` | 已锁流不再 `cancel`，且不吞原始错误 | 不再杀进程 / 不再掩盖主错误 |
| B | `createWriter` | `bufferedWrite` 默认 `true` → `false`（可覆盖） | 隔离路径下 0 字节 → **614 MB / 82.4 s / RSS 330 MB** |

**结论：A+B 是必要的，但不充分** —— 阻塞由 **C/D** 造成，修 C/D 需要动
`zipIo.createWriter` 的**并发原语**（属 L0-6 意义上的「大规模重构」，需先给设计+影响+回滚并经用户批准）。

## 候选出路（待用户裁决）

| 方案 | 说明 | 代价 |
| --- | --- | --- |
| **A（推荐）修 `src/core/zip-io.js`** | ① `:121` 的 `cancel()` 加锁保护且**不吞原始错误**；② `:145` 不再无条件 `bufferedWrite: true`（对流式/大包改为 `false`，或按落点类型选择）。诊断已确证、修法明确，且**这是插件自己的主机拉取路径**（真实 GB 级包的旗舰动作）——用户很可能已在浏览器侧遇到过同一形态的卡死 | 触碰产品代码（本任务 Out of Scope 声明「缺陷只登记不修」），需用户批准；可能需要独立任务承载 + 回归测试 |
| **B. 浏览器侧转换** | 用 Playwright 驱动插件自身 UI 完成转换（产品主战场，`BlobWriter` 使囤积可忍受） | 需写 UI 驱动；但**顺带完成 M-4 转换的功能验证**；仍不排除浏览器侧同样有囤积风险 |
| **C. 工具侧绕开** | 在 `scripts/` 内自建一个不改 `bufferedWrite` 语义等价的 writer 复刻 | 复刻产品并发窗口逻辑约百行，**与产品行为有漂移风险**，违背「同步即行使被验证功能」的设计意图 |
| **D. 缩小规模** | 先剔除 `extensions/**/.git`（823 条）再在 Node 转换 | 偏离「真源全量同源」 |
| **E. 登记为缺陷、本次改期** | 本任务降级为「备份 + 同步（用别的手段产包）」 | 主要目标落空 |

> **已确证可用的备用件**：`scripts/instance-sync/lib/node-zip-io.cjs` 暴露的 `makeFileWriter(zip)` +
> 自建 `zip.ZipWriter(fw, {bufferedWrite:false})` 组合，在同一源包上 **82.4 s 稳定产出 614 MB**（RSS 330 MB）。
> 方案 A 若获批，可直接用它作为「修复后」的对照基线。

