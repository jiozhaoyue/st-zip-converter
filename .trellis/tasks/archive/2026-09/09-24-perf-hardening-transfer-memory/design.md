# 设计：恢复链路有界等待与传输/分卷内存峰值

> 需求与验收标准见 `prd.md`；执行步骤见 `implement.md`。
> 证据来源：`.trellis/tasks/archive/2026-09/09-23-perf-security-audit/research/`
> 的 `00-audit-index.md` §2 与分片报告 `01-restore-chain.md` / `02-authority-transfer.md` /
> `03-splitter-memory.md`。**本文件不重新推导审计结论，只定义修法。**

## 1. 目标与非目标

**目标**：让恢复链路与 Authority 传输链路的每个网络 `await` 都有界（超时或 abort 可兜底），
并消除已确认的内存峰值驻留，**不改变**纯前端为主、后端可选增强的产品定位。

**非目标**（PRD 已明确排除）：
- 恢复进度可见化（`XHR.upload.onprogress`）→ 属 `09-23-batch-restore-refresh`。
- 分卷流式重构（`AsyncIterable` + `addLazy`）→ 属 `09-23-authority-cloud-transfer`。
- 宿主 UI 落点合规性（R-22/23/26）与日志脱敏（R-24）。
- 内存基线自动化门禁。

## 2. 有界等待封装（R1 / R3）

### 2.1 新增 `src/ui/net.js`？——不新增模块

`host-bridge.js` 是宿主桥接层（L0-9 要求平台差异集中于此），超时封装属于**通用 IO 关注点**
而非宿主差异。但现有代码里 `src/core/` 禁止 DOM 依赖，而 `fetch` 是 Web API。

**决策**：封装放在 **`src/ui/fetch-bounds.js`**（新模块，UI 层，允许 Web API）：

```js
export class TimeoutError extends Error {}          // name = 'TimeoutError'
export const DEFAULT_FETCH_TIMEOUT_MS = 120000;     // 2 分钟

/**
 * 带超时的 fetch。signal 与超时任一触发即 abort 并抛错。
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{ timeoutMs?: number, signal?: AbortSignal, label?: string }} [opts]
 */
export async function fetchWithTimeout(url, init = {}, opts = {}) { ... }
```

**关键实现约束**：
- 用 `AbortController` + `setTimeout` 组合；**超时与外部 signal 必须合流**（把外部 signal 的
  abort 转发到内部 controller，或直接用 `AbortSignal.any` 的可用性检测 + 回退）。
- `finally` 中**必须** `clearTimeout`，否则 Node/Vitest 下会挂住进程。
- 超时抛 `TimeoutError`（`name` 可判别），与用户主动 abort 的 `AbortError` 区分开——
  UI 文案不同：「取消」vs「超时」。

> `AbortSignal.any` 在 Chromium 116+ / Node 20+ 可用。**不假设其存在**：特征检测，
> 不可用时回退为手动 `addEventListener('abort', ...)` 转发。

### 2.2 `restoreToHost` 逐点改造

| 锚点 | 现状 | 改为 |
| --- | --- | --- |
| `getCsrfToken()` | 裸 `fetch` | `fetchWithTimeout(..., { signal, timeoutMs: SHORT })` |
| `getHandle()` | 裸 `fetch` | 同上 |
| `POST /api/users/restore` | 裸 `fetch`，大包上传可能数分钟 | `fetchWithTimeout(..., { signal, timeoutMs: UPLOAD_TIMEOUT })` |
| `response.json()` | `.catch(() => ({ success: true }))` **伪成功** | 解析失败 → 抛错（见 §2.3） |

**超时值**：恢复上传是长操作，`DEFAULT_FETCH_TIMEOUT_MS`（2 分钟）偏紧。
签名改为 `restoreToHost(zipBlob, { mode, platform, signal, timeoutMs })`，
`timeoutMs` 默认 `0`（不超时，仅靠 `signal`）——**保留用户主动取消的能力，但不给长上传
硬塞超时**；凭证类短请求用 `SHORT_FETCH_TIMEOUT_MS`（10 秒）。

> 这是对 PRD「每个网络 await 都有超时或 AbortSignal 兜底」的**读法选择**：验收措辞是
> 「超时**或** AbortSignal」，上传走 AbortSignal 满足要求。理由：120MB 包在慢速上行下
> 超过 2 分钟是正常的，硬超时会打断正常恢复。

### 2.3 修掉伪成功（R3）

现状（`host-bridge.js` 恢复尾部）：

```js
const result = await response.json().catch(() => ({ success: true }));   // ❌ 解析失败当成功
```

改为：

```js
let result;
try {
  result = await response.json();
} catch (err) {
  // 请求已发出但响应体不可解析：不得当作成功
  logger.warn('宿主恢复响应体解析失败，无法确认结果:', err);
  return { success: false, unconfirmed: true, reason: '响应体不可解析' };
}
```

UI 层（`index.js` 的恢复确认回调）区分三态：

| 返回值 | UI 文案 |
| --- | --- |
| `success: true` | 「恢复成功」（现有） |
| `success: false, unconfirmed: true` | 「请求已发出但**未确认**结果——宿主可能仍在处理，请稍后核对数据」 |
| 抛错 | 「恢复失败」（现有） |

**兼容性**：`success: false` 的新增字段是**增量**的，既有调用方只判 `result` 真伪；
`unconfirmed` 是纯新增键，不会让旧调用方误判。

## 3. 恢复并发互斥（R2）

**问题**：两个 `restoreToHost` 并发写同一用户目录，宿主侧行为未定义。

**方案**：模块级 `restoreInFlight` 标志 + 导出查询函数：

```js
let restoreInFlight = false;
export function isRestoreInFlight() { return restoreInFlight; }
```

`restoreToHost` 入口：

```js
if (restoreInFlight) throw new Error('已有恢复任务正在进行，请等待完成后再试');
restoreInFlight = true;
try { /* 全链路 */ } finally { restoreInFlight = false; }
```

**UI 层**：`index.js` 在恢复在途时禁用全部「写回宿主」入口——`export-queue.js` 渲染的
每项「写回宿主」按钮与 `#btn-confirm-restore`。做法是在 `renderExportQueue` 的
render props 传入 `restoreInFlight`，由渲染层 `disabled`。

> **为什么用「抛错」而非「排队」**：排队会让用户在不知情下积累多次覆盖操作，
> 且宿主侧无事务语义可依赖。显式拒绝 + 明确文案更符合「可观察、可降级」的产品基调。

## 4. `authority-store` 去整包驻留（R4）

### 4.1 写入：`blob.stream()` 逐块切分

现状峰值来源（`putArtifact`）：

```js
const bytes = await blobToBytes(blob);           // ① 整包 Uint8Array 常驻
const content = uint8ToBase64(bytes.subarray(...)); // ② 每块 base64 串（+33%）
```

**峰值 ≈ N（整包） + 2.33C（当前块的 bin 串 + base64 串）**，N 为包体积。

改为按 `blob.stream()` 的 `reader.read()` 累积到 `CHUNK_SIZE` 再切块：

```js
const reader = blob.stream().getReader();
let pending = [];        // 只持有「不足一块」的余量
let pendingLen = 0;
let index = 0;
while (true) {
  const { done, value } = await reader.read();
  if (value) {
    // 把 value 拆成能填满当前块的部分 + 余量
    ...
    while (pendingLen >= chunkSize) { await putBlock(pending.slice(0, chunkSize), index++); ... }
  }
  if (done) break;
}
```

**峰值降至 O(C)**（C = `CHUNK_SIZE` = 4MB），与整包体积无关，且**每块立即释放**。

**必须保留的语义**：
- 块大小、块命名（`__part_NNNNNN`）、清单字段（`size` / `chunkSize` / `chunks` / `parts`）
  **完全不变**——读取端与既有已存数据必须无感。
- `onProgress(done, total)`：`total` 由 `Math.ceil(blob.size / chunkSize)` 预先算出
  （不再依赖先读完全包才知道长度）。

### 4.2 读取：流式重组

现状 `getArtifact` 把全部块的 `Uint8Array` 推进 `buffers[]`，最后 `merged.set(...)`
再 `new Blob([merged])` —— 峰值 ≈ 2N。

改为**边读边产出 Blob**：`new Blob(chunkBlobs, { type })` 直接吃数组，由浏览器管理底层，
避免中间的 `merged` 整包副本。峰值 ≈ N + C（Blob 内部实现仍可能持有引用，但免除一次
显式整包拷贝）。

> 更彻底的 Streaming Blob 需要 `Blob` 的 `stream()` 与用户侧消费方式配合，
> 超出本任务范围（属 `09-23-authority-cloud-transfer` 的流式重构）。

### 4.3 失败清理与新旧隔离（R7）

现状：逐块直写目标名，中途失败留下**孤儿块**；且「先写新块后换清单」顺序若颠倒，
会出现新旧混合。

改为「**新 part 命名空间 → 成功后换清单 → 清旧 part**」：

```
1. 生成写入代际标识 gen = <时间戳>（或递增序号）
2. 逐块写入 `<name>__part_<gen>_<NNNNNN>`
3. 全部成功后：kv.set(清单) —— 清单里的 parts 指向新代际
4. 清单写入成功后：删旧代际的所有 part（清单里记录的上一版 parts）
5. 任一步失败：删本次已写的 part（回滚），清单保持指向旧代际 → 旧数据仍可读
```

**兼容性**：既有已存清单的 `parts[].name` 是旧命名（无 gen），步骤 4 按清单里记录的
`parts` 删除即可，**不依赖命名规律**——所以新旧命名可以共存，读取端只认清单。

**幂等**：重复 `putArtifact(name)` 最终只留最新代际。

## 5. 分卷与 Blob 即时释放（R6）

| 锚点 | 现状 | 改为 |
| --- | --- | --- |
| `index.js:1252` `lastConvertedBlob = resultBlob` | 赋值后**永不置空**，整个会话持有 | 用后置空（见下） |
| `index.js:934-938` 分卷前读全部条目 | `entries.push({ data: await e.read() })` 全量驻留 | 分卷完成/失败后释放 `entries` |
| `index.js:1188/1232` 分卷产出 | `lastConvertedBlob` 仍被持有 | 分卷路径结束后置空 |

**置空时机**：`lastConvertedBlob` 的用途只有一处——`btnRestoreLuker` 的「恢复最新转换产物」
（`index.js:1121`）。因此**不能在转换完成后立即置空**，否则该按钮失效。

正确做法：**按「是否仍需要」收敛作用域**，而不是无脑置空：

- 不启用分卷时：`lastConvertedBlob` 保留（供 Luker 快速恢复按钮）——**保持现状**。
- 启用分卷时：分卷已把 `resultBlob` 拆成 parts 进待导出区，原始整包**不再有任何消费方** →
  分卷流程结束后 `lastConvertedBlob = null`。
- **`entries` 数组**：分卷内局部变量，`try/finally` 中 `entries.length = 0` 释放逐条目
  `data` 引用（这是 R6 的主要收益，实测 S-01/S-02）。

> **诚实标注**：PRD 验收写「分卷完成后 `lastConvertedBlob` 为 `null`」，
> 与非分卷路径保留该引用的需要**不矛盾**——验收针对「分卷完成」这一前提。
> 非分卷路径的持有是**有意的**（一个 `<button>` 的功能依赖它），不是遗漏。

## 6. TaskManager 断点回退（R5）

**问题**：`taskManager.pause(id)` 先 `adapter.save(...)` 再 `controller.abort()`。
若 `adapter` 是 Authority 的 `createCheckpointAdapter` 且 `kv.set` reject，
**异常在 `abort()` 之前抛出** → `signal.aborted` 为假 → 「暂停」失效（违反 L1-MR-1：
后端不可用时纯前端路径必须全功能）。

**方案**（改 `task-manager.js`，不依赖具体 adapter 实现）：

```js
async pause(id) {
  const task = this.tasks.get(id);
  if (!task || task.state !== TASK_STATES.RUNNING) return false;
  task.state = TASK_STATES.PAUSED;
  if (task.checkpoint) {
    try {
      await this.adapter.save(id, task.checkpoint);
      task._dirtyEntries = 0;
    } catch (err) {
      // 断点持久化失败不得阻断暂停语义（后端为可选增强层）
      console.warn('[task-manager] 断点持久化失败，暂停仍生效（内存断点保留）:', err);
    }
  }
  task.controller.abort();
  return true;
}
```

**关键**：`controller.abort()` 移出 `try`，**无论如何都执行**。
内存中的 `task.checkpoint` 仍在，本次会话内续传不受影响；只是跨会话/跨设备续传降级。

`abort(id)` 路径同理需检查——其 `adapter.remove` 失败同样不应阻断。**实施时逐处核对**。

## 7. 测试矩阵

| 文件 | 覆盖点 |
| --- | --- |
| `test/restore-chain.test.js`（新） | **超时**：mock fetch 挂起 → `fetchWithTimeout` 抛 `TimeoutError`；**abort**：外部 signal abort → 抛 `AbortError`；**合流**：外部 signal 触发内部 abort；**伪成功已修**：`response.json()` reject → 返回 `unconfirmed` 而非 success；**并发互斥**：在途时二次调用抛错、`finally` 正确复位 |
| `test/authority-store.test.js`（扩展） | 写入路径**不出现** `arrayBuffer()`（用 spy/计数断言）；块命名含代际且清单 parts 指向新代际；**中途失败回滚**：第 3 块 put reject → 断言已写块被删、清单未变；**KV 失败不阻断暂停**：mock `kv.set` reject → `pause()` 返回 true 且 `signal.aborted` 为真 |
| `test/splitter-memory` / `index.js` 相关 | 分卷后 `lastConvertedBlob === null`；`entries` 在 finally 释放（若可单测；否则在 `implement.md` 标注为手测项） |
| 基线 | 226 passed / 2 skipped **不退化**；两条守卫通过 |

## 8. 兼容与回滚

- **向后兼容**：Authority 已存数据读取路径不变（只认清单，与块命名无关）；
  `restoreToHost` 返回值新键是纯增量；`pause()` 语义只增强不减弱。
- **回滚**：改动集中在 3 个模块 + 1 处 UI 渲染 + 测试，无数据迁移，`git revert` 即可。

## 9. 开放风险

| 风险 | 处理 |
| --- | --- |
| `fetchWithTimeout` 在 Node/Vitest 下 `setTimeout` 泄漏导致进程挂住 | `finally` 强制 `clearTimeout`；测试中断言定时器不残留 |
| 上传超时设太短会打断正常的大包恢复 | 上传默认**不设超时**，只走 `signal`（§2.2） |
| 代际命名改动影响既有已存块 | 读取只按清单 `parts[]` 定位，不解析命名；删除也按清单记录 |
| `blob.stream()` 在两块交界处的切分边界错误 | 单测用「非块整数倍」的合成数据（如 `CHUNK_SIZE + 1`、`3 * CHUNK_SIZE - 7`）逐一断言重组字节一致 |
