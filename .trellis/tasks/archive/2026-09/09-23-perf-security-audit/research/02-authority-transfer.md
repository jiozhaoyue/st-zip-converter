# 链路② 审计报告：`src/storage/authority-store.js` 传输实现

- **审计日期**：2026-09-23
- **审计范围**：`src/storage/authority-store.js`（247 行，全文）及其调用方 `src/core/task-manager.js`（持久化 adapter 接缝 `{save,load,remove}`）、`src/ui/export-queue.js`（镜像调用方）、`index.js`（adapter 注入点）
- **性质**：只读审计。未连接任何酒馆实例，未运行 `npm test` / `npm run build`，未做任何 git 写操作。
- **唯一写入文件**：本报告。
- **最高严重度**：**高**（2 条）

---

## 结论摘要

### 第 1 问量化公式结论（一句话）

> **base64 的内存代价是 `4/3 × N` 字节而不是 `8/3 × N`（V8 对纯 ASCII 字符串使用 Latin-1 单字节表示，已实测：4 MiB 二进制 → Latin-1 中间串驻留 4.00 MB，base64 串 5 592 408 字符 → 驻留 5.33 MB）；但 `putArtifact` 仍在第 132 行把**整个 Blob 全量 `arrayBuffer()` 读进内存并持有到写入结束**，因此峰值 ≈ `N + 2.33 × chunkSize`（默认 4 MiB）——即「整包常驻 + 9.3 MB 常数」，4 MiB 包约 **3.33×**，100 MiB 包约 **1.09×**，700 MiB 包约 **1.013×**。题设的「≈3.67×」不成立：分块把 base64 的常数项封顶在 2.33×chunkSize 而非 2.33×N。**

公式明细（`C` = `CHUNK_SIZE` = 4 MiB，`N` = Blob 原始字节数）：

| 路径 | 峰值公式 | 说明 |
| --- | --- | --- |
| `putArtifact`（典型） | `P_put ≈ N + (1 + 4/3)·C ≈ N + 2.33C` | `N`＝全量 ArrayBuffer；每块 transient `bin`(C) + `b64`(4/3C) 同时存活 |
| `putArtifact`（最坏） | `≈ N + (2 + 4/3)·C ≈ N + 3.33C` | 字符串拼接绳索扁平化瞬时再多一份 `bin` |
| `putArtifact`（若引擎用 UTF-16 字符串） | `≈ N + (2 + 8/3)·C ≈ N + 4.67C` | 上限情形，base64 字符集为 ASCII，实际不触发 |
| `getArtifact`（**更差**） | `P_get ≈ 2N`（下界）～ `3N`（含 Chromium Blob 内部拷贝） | 分块数组 `buffers` 累计 N + 合并缓冲 `merged` 再 N |
| 假设的「不分块一次性编码」 | `≈ N + (1 + 4/3)·N = 3.33N`（单字节串）／`5.67N`（UTF-16） | 本实现未走此路径 |

代入值：

- `N = 4 MiB` → put 峰值 ≈ 13.3 MB（**3.33×**）
- `N = 100 MiB` → put 峰值 ≈ 109.3 MB（**1.09×**）
- `N = 700 MiB`（Real Luker 单包量级）→ put 峰值 ≈ 709.3 MB（**1.013×**）+ get 路径 ≈ 1.4–2.1 GB

### 五问结论速览

| # | 问题 | 结论 | 严重度 |
| --- | --- | --- | --- |
| 1 | base64 内存峰值量化 | 公式见上；**分块未降低峰值**，整包仍全量入内存 | 高 |
| 2 | 是否一次性全量读入 | **是**（`arrayBuffer()` 全量）；分块 4 MiB、**严格串行**、天然背压、无显式限流 | 高 |
| 3 | 失败清理 | **无清理路径**：中途失败留无主分块；同名覆盖中途失败可致清单与数据不一致 | 中 |
| 4 | 降级链 | 导出接口自身**安全降级成立**；但 checkpoint adapter **写入失败无回退**，会把 Authority 变成主路径失败源 | 高 |
| 5 | 敏感面 | 链路内无 token/密钥处理、无 DOM 写入；仅 `console.warn(err)` 与产物名进控制台 | 低 |

---

## 逐问结论

### 第 1 问：base64 内存峰值量化

**结论**：公式见摘要。关键点是**两个不同的问题被混为一谈**——「单请求体积」确实被 4 MiB 分块限住了（好），但「进程内存峰值」并没有（坏）：第 132 行的 `await blobToBytes(blob)` 把整包读成 `Uint8Array` 并持有整个循环期间，分块只切了「发送单元」，没有切「驻留单元」。

### 第 2 问：是否一次性全量读入 / 分块参数 / 并发与背压

**结论**：
- **是，一次性全量读入**。`blobToBytes()` 内部 `await blob.arrayBuffer()`（`authority-store.js:118`）→ `putArtifact` 第 132 行调用，整包入堆。
- 分块常量 **4 MiB**（`authority-store.js:15`），可被 `opts.chunkSize` 覆盖（第 131 行，测试用 512 KiB）。
- **严格串行**：`for` 循环内 `await client.storage.blob.put(...)`（第 138 行）逐块等待，天然形成背压；**无并发、无显式限流、无重试**。
- `parts` 数组只累积 `{id, name}` 元数据，不是内存大头。
- `getArtifact` 同样是**串行**逐块 `await client.storage.blob.get(...)`（第 173 行），但把**全部**块同时留在 `buffers` 里（第 191 行）。

### 第 3 问：失败清理

**结论**：**无清理路径。** 具体机制见 F-D（无 `try/catch`、清单最后才写、同名覆盖有混合损坏窗口）。唯一存在的清理函数 `deleteArtifact()` 在产品代码中**零调用方**（F-E），因此即使成功路径也没有回收机制。

### 第 4 问：降级链

**结论**：`window.STAuthority.AuthoritySDK` 不存在时，**导出接口逐条安全降级成立**（下表），调用方确实无需分支——**但有一个例外**：`createCheckpointAdapter()` 返回的是「会抛错的 adapter」，`TaskManager` 侧无失败回退；Authority 抖动时断点写入异常会沿 `onCheckpoint` / `pause()` 传播，**把可选后端变成主路径失败源**（F-B，严重度高）。

| 导出 | 不可用/失败时返回 | 锚点 | 调用方需要分支吗 |
| --- | --- | --- | --- |
| `getAuthorityClient()` | `null` | `authority-store.js:29,31,44` | 否（内部已判） |
| `isAuthorityAvailable()` | `false` | `authority-store.js:54-58` | 否 |
| `createCheckpointAdapter()` | `null` | `authority-store.js:83-84` | 否（`index.js:302` 用 `\|\| undefined`） |
| `putArtifact()` | `null` | `authority-store.js:129-130` | 否 |
| `getArtifact()` | `null` | `authority-store.js:167-168` | 否 |
| `deleteArtifact()` | `false` | `authority-store.js:226-227` | 否 |
| `mirrorArtifact()` | `false`（内部吞错） | `authority-store.js:207-219` | 否（`export-queue.js:165` 的 `.catch()` 冗余） |
| adapter 的 `save/load/remove` | **会 reject**（无保护） | `authority-store.js:86-95` | **需要**（当前无） |

### 第 5 问：敏感面

**结论**：链路内**不处理任何 token / 密钥 / 凭据**（`init()` 仅传 `extensionId` 等非敏感元数据，`authority-store.js:33-40`；鉴权由 SDK 内部完成），**也没有任何 DOM 写入**（全程只用 `console.*`，不经 `logger` → 不可能进 `log-console` 面板）。残留面见 F-I：`console.warn(err)` 可能整体打印 SDK 错误对象（含上游请求上下文的风险，**待验证**）；`console.info` 打印产物逻辑名（用户聊天包/角色名）到控制台（低）。

---

## 发现清单

### F-A 全量 `arrayBuffer()`：分块未降低内存峰值，大包有 OOM 风险【高】

- **锚点**：`src/storage/authority-store.js:116-119`（`blobToBytes`）、`:132`（`const bytes = await blobToBytes(blob)`）、`:137-147`（循环）
- **证据**：
  ```js
  async function blobToBytes(blob) {
    return new Uint8Array(await blob.arrayBuffer());   // :118 整包入堆
  }
  ...
  const bytes = await blobToBytes(blob);               // :132 整个写入过程持有 N
  for (let i = 0; i < total; i++) {
    const content = uint8ToBase64(bytes.subarray(i * chunkSize, (i + 1) * chunkSize)); // :137
    const put = await client.storage.blob.put({ name: partName, content, ... });        // :138
  ```
  峰值 ≈ `N + 2.33 × chunkSize`（默认 4 MiB → +9.3 MB）。分块只限制单请求体积，**没有**限制驻留体积；注释（`:11-12`）声称「避免……base64 内存峰值」，实际只避免了「单请求超限」，**峰值避免的说法不准确**。
- **修复方向**：改用 `blob.stream().getReader()` + `BlobReader`（见 `.trellis/spec/frontend/state-management.md:63` 已有约定）流式按 `chunkSize` 切块，块内 base64 编码后立即释放；或改走二进制/base64 以外通道（见 `.trellis/tasks/09-23-authority-cloud-transfer/design.md` 的 transfer 方案）。

### F-B checkpoint adapter 无失败回退，违反「后端不得阻塞纯前端主路径」【高】

- **锚点**：`src/storage/authority-store.js:86-95`（`save/load/remove` 直连 `kvSet`，无 `try/catch`）、`src/core/task-manager.js:110`（`await this.adapter.save`）、`:124-131`（`pause` 内 `save` 失败则 `controller.abort()` 永不执行）、`index.js:301-302`
- **证据**：
  ```js
  // index.js:301-302 —— Authority 可用即无条件采用，且无回退
  const authorityCheckpointAdapter = await createCheckpointAdapter();
  const taskManager = new TaskManager(authorityCheckpointAdapter || undefined);
  ```
  ```js
  // task-manager.js:124-131
  async pause(id) {
    ...
    task.state = TASK_STATES.PAUSED;
    if (task.checkpoint) {
      await this.adapter.save(id, task.checkpoint);   // :129 Authority 网络失败 → 抛出
      task._dirtyEntries = 0;
    }
    task.controller.abort();                          // :131 —— 被跳过，任务 state=paused 但仍在跑
    return true;
  }
  ```
  ```js
  // task-manager.js:110（onCheckpoint 内）
  await this.adapter.save(id, manifest);              // reject → 传播进任务执行体循环
  ```
  后果有二：① **状态机不一致**——`state=PAUSED` 但 signal 未 abort，界面显示已暂停而拉取/转换仍在继续消耗；② **主路径失败**——Authority 抖动时整个长任务直接失败，本应「静默降级」（L0-11 / L1-MR-1）。此前默认 `memoryAdapter`（`task-manager.js:45-51`）不会抛错，接入 Authority 后引入了新的失败源。
- **修复方向**：`createCheckpointAdapter()` 内包 `try/catch`，写失败返回 `false` 并降级为内存/本地；或 `TaskManager` 侧对 `adapter.save` 做「失败即回退 `memoryAdapter` 且不中断任务」的包装（`pause` 的 `abort()` 必须无条件执行 → 移到 `await` 之前或 `finally` 中）。

### F-C `getArtifact` 峰值 2N～3N，比写入路径更差【中】

- **锚点**：`src/storage/authority-store.js:171`（`const buffers = []`）、`:191`（`buffers.push(chunkBytes)`）、`:194`（`const merged = new Uint8Array(totalLen)`）、`:197`（`new Blob([merged])`）
- **证据**：全部分块解码后同时驻留（累计 `N`），再整块合并进 `merged`（再 `N`，`merged.set` 期间两块同时存活），最后 `new Blob([merged])` 在 Chromium 内部通常再拷贝一份 → 瞬时 `2N ~ 3N`；每块另有 `4/3·chunkSize` 的 base64 串与 `chunkSize` 的 `atob` 中间串（`:110`）。
  - **当前无产品调用方**：全仓 grep 显示 `getArtifact` 仅被 `test/authority-store.test.js` 引用（`design.md` 的云端迁移方案计划启用它）。
- **修复方向**：改为流式回读（逐块 `Blob` 拼接，避免 `merged` 大缓冲），或提供 `openRead()` 返回 `ReadableStream`；启用前先补一条大包内存基线测试。

### F-D 传输失败无清理 / 同名覆盖存在静默混合损坏窗口【中】

- **锚点**：`src/storage/authority-store.js:135-158`（循环无 `try/catch`，清单在循环**之后**才写 `:158`）
- **证据**：
  ```js
  for (let i = 0; i < total; i++) { ... await client.storage.blob.put(...) }   // :136-147 任一块失败即抛出
  const manifest = { ... parts, ... };                                        // :149-157
  await kvSet(client, KV_MANIFEST_PREFIX + name, manifest);                    // :158 只有全部成功才落清单
  ```
  两种残留形态：
  1. **首次上传失败** → 已写入的 `name__part_XXXXXX` 无清单指向，`deleteArtifact()` 因「先读清单」而**永远无法回收**（`:228-231`），成为服务端孤儿块（存储泄漏 + 数据驻留）。
  2. **同名覆盖失败** → 旧清单仍在，但其指向的分块已被部分覆写为新内容 → 后续 `getArtifact` 返回**新旧混合的损坏 Blob**（且无长度校验，`:194` 按清单 `totalLen` 分配，能静默产出错误数据）。
- **修复方向**：`try/catch` + 失败回滚（删除本次已写的分块）；写入采用临时前缀 + 成功后原子改名/换清单（双写清单或用带版本号的 part 名），使「数据」与「清单」同生共死；`getArtifact` 补 `size` 校验。

### F-E 镜像产物无删除路径，Authority 侧数据只增不减【中】

- **锚点**：`src/storage/authority-store.js:225-239`（`deleteArtifact` 定义）、`src/ui/export-queue.js:128-141`（`remove`/`clear` 仅 `deleteFile`）、`src/ui/export-queue.js:165`（唯一镜像入口）
- **证据**：
  ```js
  // export-queue.js:128-135
  remove(id) {
    const [item] = this.items.splice(idx, 1);
    if (item.storedId) { deleteFile(item.storedId).catch(() => {}); }   // 只删本地 IndexedDB
    ...
  ```
  `deleteArtifact` 在全仓产品代码中**零调用方**（仅 `test/authority-store.test.js:94` 与被测文件本身）。用户在待导出区移除/清空、在工作区（`stash-list.js:141,197`）或存档管理（`archive-manager.js:188`）删除条目时，**Authority 镜像的分块与清单全部留存**。
- **修复方向**：在 `ExportQueue.remove/clear` 与 `db.deleteFile` 的成功路径上挂 `deleteArtifact(item.name)`（fire-and-forget、失败只告警）；并考虑加「清单 + 孤儿块对账」的一次性 GC 入口。

### F-F 同名覆盖留孤儿分块（块数变少时）【中】

- **锚点**：`src/storage/authority-store.js:135-140`（part 名按序号生成，无「旧块清理」步骤）
- **证据**：分块名固定为 `${name}__part_${String(i).padStart(6,'0')}`。若上一版有 5 块、新一版只有 3 块，则 `__part_000003`、`__part_000004` **不再被 manifest 引用也永不删除**。测试 `test/durable-mirror.test.js:106-116`（「同名覆盖保留最新产物」）只断言 `manifest.size === 1024` 与 `part_000000` 存在，**未断言旧块被清理**，因此该行为被测试「认可」为现状。
- **修复方向**：写新版本前先按旧清单删除剩余块，或 part 名带内容哈希/版本号并在成功后清旧版本（同 F-D 的原子改名方案）。

### F-G `getAuthorityClient()` 无缓存，与自身注释不符；每次操作都重跑 `sdk.init()`【中】

- **锚点**：`src/storage/authority-store.js:23`（注释「结果缓存」）vs `:26-48`（实现无任何 memo 变量）
- **证据**：
  ```js
  /**
   * 探测并初始化 Authority client（结果缓存）   // :23 与实现不符
   */
  export async function getAuthorityClient() {
    if (testClient !== undefined) return testClient;      // :27 仅测试钩子
    ...
    return await sdk.init({ ... });                       // :33-40 每次调用都执行
  }
  ```
  调用频次：`putArtifact`/`getArtifact`/`deleteArtifact` 各 1 次、`createCheckpointAdapter()` 1 次、以及 adapter 的每次 `load/remove`。`mirrorArtifact` 是 fire-and-forget，因此**每个产物入库都触发一次 `sdk.init()`**（跨操作/跨会话重复握手）。
- **修复方向**：用 promise 级单例缓存（`let clientPromise`），失败时清空以允许重试；或修正注释承认无缓存。

### F-H `putArtifact` 无 `AbortSignal` / 超时，不满足「有界等待」约定【低】

- **锚点**：`src/storage/authority-store.js:128-160`（签名只有 `opts.chunkSize` / `opts.onProgress`）
- **证据**：无 `signal` 参数、无超时；`client.storage.blob.put` 若悬置，`putArtifact` 永久 pending。相对缓和的因素：唯一生产调用方 `export-queue.js:165` 是 fire-and-forget（`.catch(() => {})`），不会阻塞 UI 主路径——但会让 promise 与整包 `N` 字节内存**长期钉住**（与 F-A 叠加）。
- **修复方向**：接受 `opts.signal` 并在循环中检查；对每次 `put` 加超时；`mirrorArtifact` 侧加整体超时。

### F-I 控制台信息面：SDK 错误对象与产物逻辑名外泄【低】

- **锚点**：`src/storage/authority-store.js:43`（`console.warn('[authority-store] Authority 初始化失败…', err)`）、`:211`（`console.info(... ${name} ...)`）、`:216`（`console.warn(... ${name}, err)`）
- **证据**：链路全程不碰 token（`init()` 入参仅 `extensionId/displayName/version/installType/declaredPermissions`），也不写 DOM——**这一条是正向结论**。残留风险：
  1. `err` 整体入控制台，若 SDK 抛出包含请求头/授权上下文的错误对象则可能泄漏凭据 → **待验证**。验证方法：在 Dev 实例注入 stub SDK 抛出 `Error` 时附加 `headers` 字段，检查控制台输出；或查阅 `st-authority-sdk` 的错误构造实现（本仓无该源码）。
  2. `console.info/warn` 打印产物名（形如用户聊天包/角色名派生）→ 文件名级隐私信息进 DevTools（对照 `test/private-configs.test.js` 的隐私基线，判断是否需要保守化）。
  - 交叉核对（范围外但相关）：`src/ui/host-bridge.js:159` 的错误消息只含 HTTP 状态码、不含 token；token（`:256,429,516,579`）仅进入请求头，未被日志或 DOM 使用。
- **修复方向**：`console.warn` 只打印 `err?.message`（或脱敏后的对象）；产物名在日志中改为截断/哈希摘要。

### F-J `onProgress` 同步逐块回调；`mirrorArtifact` 的 `.catch()` 冗余【低】

- **锚点**：`src/storage/authority-store.js:146`（`opts.onProgress(i + 1, total)` 同步调用）、`src/ui/export-queue.js:165`（`mirrorArtifact(...).catch(() => {})`）
- **证据**：`onProgress` 目前只被测试使用（产品代码无调用方），故**暂无 rAF 合帧问题**（L1-MR-9 未触发）；若将来接入 UI 进度条，需按 rAF 合帧。`mirrorArtifact` 内部已 `try/catch` 吞错（`:207-219`）永不 reject，因此调用方的 `.catch()` 属死代码（无害，但会误导后续维护者认为它可能抛）。
- **修复方向**：接 UI 时加 rAF 合帧；删除冗余 `.catch()` 或在 `mirrorArtifact` 注释中明确「永不 reject」。

---

## 立即修复建议

按「改动小 × 收益大」排序，均为可选后端范畴，不涉及架构转向：

1. **F-B（阻断级）**：在 `createCheckpointAdapter()` 的三个方法内加 `try/catch`，失败返回 `null`/`undefined` 并让 `TaskManager` 回退内存 adapter；同时把 `task-manager.js:131` 的 `controller.abort()` 移出 `await` 之后（或放 `finally`），保证「暂停」语义不依赖后端可用性。—— 这是唯一会把可选后端变成**主路径失败源**的问题，优先做。
2. **F-D + F-F（数据一致性）**：`putArtifact` 加 `try/catch` 回滚本次已写分块；写入改为「新 part 名（带版本/哈希）→ 成功后换清单 → 清旧 part」，消除混合损坏与孤儿块。
3. **F-E（数据驻留）**：在 `ExportQueue.remove/clear` 与工作区删除路径挂 `deleteArtifact(name)`（fire-and-forget）。
4. **F-G**：`getAuthorityClient()` 加 promise 单例缓存（顺带修正 `:23` 注释）。
5. **F-I**：`console.warn(err)` 收敛为 `err?.message`；产物名日志做截断。

## 建议纳入后续优化任务

1. **F-A + F-C（流式化，收益最大）**：写入改 `blob.stream()` 逐块切分（去掉整包 `arrayBuffer()` 与整包 base64 中间串）；读取改流式重组（去掉 `merged` 大缓冲）。这与已存在的 `.trellis/tasks/09-23-authority-cloud-transfer/` 方案（transfer + 流式块）方向一致，建议在该任务中一并落地，避免重复设计。目标：把 put 峰值从 `N + 2.33C` 降到 `O(C)`、get 从 `2N~3N` 降到 `O(C)`。
2. **内存基线测试**：为大包（如 256 MiB / 1 GiB）补一条内存峰值断言测试（Node 下 `process.memoryUsage().heapUsed` 采样），把 F-A/F-C 变成可回归的量化指标，而不是靠人工判断。
3. **F-H**：为 Authority 全部网络调用统一引入 `AbortSignal` + 超时封装（可复用 `host-bridge.js` 侧未来的超时工具），并纳入「有界等待」约定（L1-MR-7）自查清单。
4. **孤儿块对账 GC**：清单扫描 + 无主 `__part_*` 清理的一次性入口，处理 F-D/F-E/F-F 的历史残留。
5. **待验证项**（本轮无法证实，需环境/源码支持）：
   - SDK 是否在 `blob.put` 内部保留/复制传入的 base64 字符串（影响 F-A 的实际峰值上限）。验证方法：Dev 实例 + `performance.measureUserAgentSpecificMemory()` 或 DevTools Memory 快照，在 `putArtifact` 前后取样。
   - SDK 错误对象是否携带授权上下文（F-I-1）。验证方法：stub SDK 抛错并检查输出，或审阅 `st-authority-sdk` 实现。
   - Authority KV 写入失败时是 reject 还是静默失败（直接决定 F-B 的触发概率）。验证方法：mock client 让 `kv.set` reject，观察 `pause()` 后的 `signal.aborted`。
