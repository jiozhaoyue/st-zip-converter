# CH1 审计报告：`restoreToHost` 恢复链路（宿主导入/恢复）

- **任务**：`.trellis/tasks/09-23-perf-security-audit`
- **审计对象**：链路①「`restoreToHost` 恢复链路」
- **审计时间**：2026-09-23
- **审计方式**：只读源码审计（未运行 `npm test` / `npm run build`，未连接任何酒馆实例 8001–8004）
- **主要文件**：`src/ui/host-bridge.js`、`index.js`、`src/ui/export-queue.js`、`src/ui/stash-list.js`、`src/ui/archive-manager.js`、`src/ui/view.js`、`src/ui/log-console.js`、`src/storage/db.js`、`src/core/zip-io.js`、`src/ui/workbench-template.js`
- **发现条数**：25 条（高 2 / 中高 5 / 中 9 / 低 9），另附 1 条正面确认
- **最高严重度**：高

---

## 结论摘要

> **一句话结论：恢复链路存在无界等待** —— `restoreToHost` 的全部网络 `await`（凭证拉取、`POST /api/users/restore`、响应解析）以及通道入口的 IndexedDB `await` 均**没有超时、没有 `AbortSignal`、没有 destroy 兜底**，宿主或网络一旦挂起，promise 永久 pending，且 UI 没有任何取消入口（用户唯一能做的只有刷新页面）。

补充摘要要点：

| 维度 | 结论 |
| --- | --- |
| 1. 有界等待 | **不通过**。逐点 10 项锚点中，**网络类 await 无一项**有超时/abort 兜底（本地类 3 项为「准有界」）；其中 2 项为「高」级永久 pending 风险（`host-bridge.js:437`、`:158/:168`），1 项为「未 await 的 async 调用导致异常逃逸」（`:472`），1 项跨层（IndexedDB `open` 无 `onblocked`，`db.js:78-127`） |
| 2. 失败清理 | **部分通过**。UI 层有失败提示（`alert` + `logger.error`），但**无回滚、无中止入口**；服务端已开始写盘后的残留状态**无法在代码中断言**（标注待验证） |
| 3. 错误处理 | **不通过**。存在 1 处**伪成功**（`:459` 把响应解析失败当 `{success:true}`）、1 处空 `catch`（`:451-453`）、2 处仅 `logger.warn`/`console.warn` 吞掉 |
| 4. 进度回调 | **不通过（反向问题）**。不是「高频未合帧」，而是**完全没有进度回调**：进度条在恢复期间长期固定 15%（`index.js:1046-1050`），与「无界等待」叠加后用户无法区分「进行中」与「已挂死」 |
| 5. 敏感面 | **部分通过**。CSRF token 处理干净（仅入 header，全仓无 token 日志）；但**恢复包内清单字段直接 `innerHTML` 拼进宿主页面**（`:702/:706/:714`），构成注入面；用户名进入可导出的日志 |

---

## 审计范围与判定口径

- **「有界」判定标准**（依 L1-MR-7）：该 `await` 要么有显式超时（`Promise.race` + `setTimeout`）、要么接收 `AbortSignal`、要么由 destroy/取消信号兜底 settle。三者皆无 → 判「无界」。
- **「本地资源型 await」判定**：形如本地 Blob/CPU 解压的 `await`，若其 reject 路径已被上层捕获，则记为「准有界（无超时上限但不会永久 pending）」；若其可能既不 resolve 也不 reject（如 `open` 被 block），则仍记为「无界」。
- **无法在代码中证实的结论**一律标注 **「待验证」** 并给出验证方法（依任务约束，禁止连接实例，故验证方法留为文本方案）。

---

# 一、有界等待（Q1）

## 1.1 逐点清单

| # | 锚点 | await 对象 | 判定 | 依据 |
| --- | --- | --- | --- | --- |
| A1 | `src/ui/host-bridge.js:429` | `Promise.all([getCsrfToken(), getHandle()])` | **无界** | 两个 fetch 均无 `signal`/超时（`:158`、`:168`） |
| A2 | `src/ui/host-bridge.js:437` | `fetch('/api/users/restore', {...})` | **无界** | 未传 `signal`；无 `Promise.race` 超时；GB 级上传 + 宿主解包写盘期间可能长时间甚至永不返回 |
| A3 | `src/ui/host-bridge.js:449` | `await response.json()`（错误分支） | **无界** | 仅错误分支；响应体不结束时永久 pending（`catch` 只兜 reject，不兜 pending） |
| A4 | `src/ui/host-bridge.js:459` | `await response.json()`（成功分支） | **无界** | 同上；且 `.catch(() => ({success:true}))` 只兜 reject |
| A5 | `src/ui/host-bridge.js:464` | `await zipIo.openReader(zipBlob)` | **准有界** | 走 `BlobReader.getEntries()`（本地中央目录解析，CPU 密集）；无超时上限但会 resolve/reject。Node 字符串路径分支走 `fs.readFile`（`src/core/zip-io.js:85-89`）同样无超时 |
| A6 | `src/ui/host-bridge.js:469` | `await entry.read()`（解压 manifest） | **准有界** | 本地解压；异常被 `:480` catch 兜住 |
| A7 | `src/ui/host-bridge.js:477` | `await reader.close()`（`finally`） | **准有界** | 本地句柄释放 |
| A8 | `src/ui/host-bridge.js:472` | `renderExtensionInstallerModal(...)` | **无界 + 异常逃逸** | **未 `await` 的 async 调用**：其内部 `await deleteExtensionViaHost`（`:579-580` 无界）、`await installExtensionViaHost`（`:518` + `:158` 无界）；且因未 await，其 rejection 不会进入 `:480` 的 catch |
| A9 | `src/ui/host-bridge.js:746-753` | `await deleteExtensionViaHost('third-party', false)` | **无界** | 内部 `getCsrfToken()`（`:579`）+ `fetch`（`:580`）无超时；失败/挂起时按钮停在「清理中...」disabled 态（`:749-750`） |
| A10 | 入口前置：`src/ui/stash-list.js:132`、`src/ui/stash-list.js:191`、`src/ui/archive-manager.js:174` | `await getFile(file.id)` | **无界** | 经 `db.js:221` → `runTransaction`（`db.js:138-150`）→ `openDb`（`db.js:78-127`）：**无 `onblocked` 处理、无超时**，`indexedDB.open` 触发 `blocked` 后 promise 永不 settle |

> **澄清（非发现）**：恢复链路属于「Blob → multipart」路径，**不涉及 OPFS 文件句柄**（OPFS 句柄只出现在拉取链路 `fetchHostBackup`）；`opfsTmpHandle`/`opfsTmpCleanup` 不在此链路，故不列入上表。

## 1.2 发现明细

### R-01 · 严重度：高 · 恢复主请求无超时、无中止信号（永久 pending 风险）

- **锚点**：`src/ui/host-bridge.js:437`
- **判定**：无界
- **证据**：
  ```js
  const response = await fetch('/api/users/restore', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-CSRF-Token': token },
    body: formData,
  });
  ```
  对比同文件拉取链路**有** `signal`（`host-bridge.js:277-283`：`signal` 透传 + reader 循环可中止），恢复链路**完全没有** `signal` 参数，`restoreToHost(zipBlob, { mode, platform })` 签名（`:427`）也不接收 `signal`。
- **后果**：宿主 `/api/users/restore` 是「接收整包 → 解包 → 写盘」的长事务；一旦服务端在解包阶段卡住（大包、磁盘满、锁竞争）或反向代理不返回，插件侧 `await` 永久挂起：`btnConfirmRestore`（`index.js:1036`）永不复位、进度条永远停在 15%、用户除刷新页面外无任何出路。
- **修复方向**：给 `restoreToHost` 增加 `{ signal, timeoutMs }` 选项；`AbortController` + `Promise.race` 双兜底（默认超时可取「包大小自适应」或 5–10 分钟）；`index.js` 在恢复期间提供「取消」按钮，取消后强制回到 idle 并提示「已取消（宿主可能仍在处理，请稍后核对数据）」。

### R-02 · 严重度：高 · 前置凭证请求无超时（同属永久 pending 风险）

- **锚点**：`src/ui/host-bridge.js:158`、`src/ui/host-bridge.js:168`（调用点 `:429`）
- **判定**：无界
- **证据**：
  ```js
  // getCsrfToken()
  const response = await fetch('/csrf-token', { credentials: 'same-origin' });
  // getHandle()
  const response = await fetch('/api/users/me', { credentials: 'same-origin' });
  ```
  两处均无 `signal`、无超时；`Promise.all` 中任一永不 settle 则整体永不 settle。
- **后果**：即使恢复主请求尚无问题，**用户按下「确认恢复」后可能连请求都没发出去**（卡在拿 token 阶段），且无任何 UI 反馈（进度条停在 15%）。
- **修复方向**：统一封装 `hostFetch(url, { timeoutMs: 15000 })` 助手，凭证类短请求一律带超时；超时抛可辨识错误（如 `HostTimeoutError`）供 UI 提示「宿主无响应」。

### R-03 · 严重度：中 · 成功分支响应解析无超时

- **锚点**：`src/ui/host-bridge.js:459`
- **判定**：无界
- **证据**：
  ```js
  const result = await response.json().catch(() => ({ success: true }));
  ```
  `.catch()` 只拦 reject；若响应体 header 已到达但 body 迟迟不结束（连接半开、代理截断），该 promise 既不 resolve 也不 reject。
- **后果**：数据其实已写入宿主，但插件界面永久卡住，用户会重复点击/重复导入。
- **修复方向**：`await withTimeout(response.json(), 30000)`；并把「响应体解析失败」与「HTTP 成功」区分对待（见 R-15）。

### R-04 · 严重度：中 · 错误分支响应解析无超时

- **锚点**：`src/ui/host-bridge.js:449`
- **判定**：无界
- **证据**：
  ```js
  if (!response.ok) {
    let detail = '';
    try {
      const errJson = await response.json();
      detail = errJson.error ?? '';
    } catch { /* 忽略非 JSON */ }
  ```
- **后果**：错误详情提取本身也可能挂起，把「快速失败」变成「永久挂起」。
- **修复方向**：同上，`withTimeout(..., 10000)`，超时后按空 detail 继续走 `throw`。

### R-05 · 严重度：中 · 全链路无 AbortSignal，UI 无取消入口

- **锚点**：`src/ui/host-bridge.js:427`（签名无 `signal`）、`index.js:1028-1031`（取消按钮）、`index.js:1036-1060`（确认后逻辑）
- **判定**：无界（无兜底通道）
- **证据**：
  ```js
  // index.js:1028  取消按钮只在「确认之前」有效
  btnCancelRestore.addEventListener('click', () => {
    pendingRestoreFile = null;
    if (restoreModalOverlay) restoreModalOverlay.style.display = 'none';
  });
  // index.js:1049  确认后即 await，无任何取消/超时包装
  await restoreToHost(fileToRestore.blob, { mode, platform: host.platform });
  ```
- **后果**：L1-MR-7 要求「任何 await 都必须能 settle」，恢复链路恰好是唯一**完全没有 settle 兜底**的链路（拉取链路有 `signal`、转换链路有 `TaskManager` + `signal`）。
- **修复方向**：恢复纳入 `TaskManager` 状态机（或最小实现 `restoreAbortRef`），暂停/中止语义对齐拉取链路的 `AbortController` 模式。

### R-06 · 严重度：中 · 通道入口的 IndexedDB await 无 `onblocked` 兜底

- **锚点**：`src/ui/stash-list.js:132`、`src/ui/stash-list.js:191`、`src/ui/archive-manager.js:174`（`await getFile(...)`）；`src/storage/db.js:78-127`（`openDb`）、`src/storage/db.js:138-150`（`runTransaction`）
- **判定**：无界
- **证据**：
  ```js
  // db.js:82-127  openDb 只注册 onupgradeneeded / onsuccess / onerror
  const request = window.indexedDB.open(DB_NAME, DB_VERSION);
  ...
  request.onsuccess = () => { ... resolve(dbInstance); };
  request.onerror = () => { reject(request.error); };
  // 无 request.onblocked —— 触发 blocked 时 promise 永不 settle
  ```
  ```js
  // stash-list.js:189-193
  btns.appendChild(mkBtn('restore', '写回宿主', '', async () => {
    const full = await getFile(file.id);          // ← 可能永不返回
    if (full?.blob) onRestoreToHost(full);
  }));
  ```
- **后果**：当另一个标签页/旧版本连接持有 DB 时（`DB_VERSION 2` 升级窗口），「写回宿主」按钮点击后**毫无反应**（连失败提示都没有），用户会认为插件坏了。
- **修复方向**：`openDb` 增加 `request.onblocked` → reject 明确错误；`runTransaction` 增加超时兜底；UI 层把「读包失败」提示出来。

### R-07 · 严重度：中高 · 未 `await` 的 async 调用：异常逃逸 + 内部无界

- **锚点**：`src/ui/host-bridge.js:472`（调用）、`:598-609`（函数定义与首个 await）、`:579-580`、`:518`（内部无界 fetch）
- **判定**：无界
- **证据**：
  ```js
  // host-bridge.js:463-482
  try {
      const reader = await zipIo.openReader(zipBlob);
      ...
          if (Array.isArray(manifest.extensions) && manifest.extensions.length > 0) {
            logger.info(`检测到包内包含 ${manifest.extensions.length} 个扩展清单，正在呼出扩展安装面板...`);
            renderExtensionInstallerModal(manifest.extensions);   // ← 未 await
          }
      ...
  } catch (err) {
    logger.warn('检查扩展清单失败 (非阻塞):', err);   // ← 捕获不到上面这个 promise 的 rejection
  }
  ```
  `renderExtensionInstallerModal` 是 `async`（`:598`），其首个 await 是 `Promise.all([discoverHostExtensions(), checkHostThirdPartyAnomaly()])`（`:606-609`）——这两者内部自带 catch，安全；但其后的 `deleteExtensionViaHost`（`:751`）与 `installExtensionViaHost`（`:823`）内部 fetch 均无超时（`:580`、`:518`）。
- **后果**：① 该 promise 的 rejection 成为 unhandled rejection（逃出 `:480` 的 catch）；② 弹窗的「开始安装 / 一键清理」按钮会在宿主无响应时永久停在 disabled 态。
- **修复方向**：显式 `await renderExtensionInstallerModal(...).catch((err) => logger.warn('扩展安装面板异常', err))`；并为面板内每个 host fetch 加超时。

### R-08 · 严重度：低 · 本地 Zip 读取无规模上限（仅靠 catch 兜 reject）

- **锚点**：`src/ui/host-bridge.js:464`、`src/ui/host-bridge.js:469`、`src/core/zip-io.js:85-89`
- **判定**：准有界
- **证据**：`const text = new TextDecoder().decode(await entry.read());`（`:469`）——若包内 `_convert/extensions-manifest.json` 被构造为超大条目（zip 炸弹式），会在主线程同步解码并 `JSON.parse`，导致长时间阻塞（非 pending，但表现类似卡死）。
- **修复方向**：先判 `entry.uncompressedSize`（zip-io 已透出该字段）上限（如 1 MB），超限直接跳过并 warn。

### R-09 · 严重度：中 · 「一键清理残留 third-party」动作无界且按钮永久 disabled

- **锚点**：`src/ui/host-bridge.js:746-753`（`deleteExtensionViaHost` 调用）、`src/ui/host-bridge.js:579-580`（无界 fetch）
- **判定**：无界
- **证据**：
  ```js
  cleanAnomalyBtn.addEventListener('click', async () => {
        cleanAnomalyBtn.disabled = true;
        cleanAnomalyBtn.textContent = '清理中...';
        const ok = await deleteExtensionViaHost('third-party', false);   // 无 timeout / 无 signal
  ```
  且 `deleteExtensionViaHost` 只 `return response.ok;`（`:586`）——**非 2xx 被静默降级为 `false`，不区分 404/500/超时**。
- **后果**：宿主挂起 → 按钮永久停在「清理中...」；宿主返回 500 → 提示语只有「重试清理」，无法判断原因。
- **修复方向**：加超时；返回值改为 `{ ok, status, error }` 结构以便 UI 展示真实原因。

---

# 二、失败清理与回滚（Q2）

## 结论要点

- **无回滚机制**：`restoreToHost` 不做任何写前快照、不落任何事务标记，失败即抛错（`:456`）。
- **无「恢复前自动备份」**：`workbench-template.js:298-304` 的 `overwrite` 选项文案是「重置当前用户数据，完全替换为该数据包内容」，但**没有强制或提示用户先导出一份备份**。
- **失败必然告知用户（通过）**：`index.js:1056-1059` 同时 `view.setProgress(100, '恢复写入失败: ...')` + `logger.error(...)` + `alert(...)`；`host-bridge.js:455` 也写了 error 日志。这一条**符合预期**，不构成缺陷。
- **部分写入残留**：代码层面无法断言（写盘发生在宿主进程内，插件侧只看到 HTTP 状态码）。标注**待验证**。

### R-10 · 严重度：中 · 无回滚、无恢复前备份，且部分写入残留未定义

- **锚点**：`src/ui/host-bridge.js:427-489`（全函数无回滚路径）、`src/ui/workbench-template.js:298-304`（破坏性模式文案）
- **判定**：待验证（残留行为）/ 已知缺失（回滚）
- **证据**：
  ```js
  if (!response.ok) { ... logger.error('恢复数据包至宿主酒馆失败', err); throw err; }
  const result = await response.json().catch(() => ({ success: true }));
  logger.success(`数据包恢复至当前用户 (${handle}) 成功！...`);
  ```
  从 `!response.ok` 到最终 `success` 日志之间，**没有任何中间态标记**；若客户端在这期间断开（网络中断/标签页关闭/浏览器崩溃），插件侧没有任何记录可供恢复核对。
- **后果**：`overwrite` 模式下若宿主在「重置用户数据」与「写入新数据」之间失败，用户可能落到**数据被清空但新数据未写入**的状态，且插件无法探测、无法提示。
- **修复方向**：
  1. 恢复前强制/默认生成一次宿主全量导出到待导出区（一键勾选项「恢复前自动备份」，默认开）；
  2. 破坏性模式设二次确认（见 R-11）；
  3. 在 `logger` 中记录恢复开始/失败的 requestId（若有），便于事后核对。
- **验证方法（待验证，禁止连实例，仅记录方案）**：在 Dev Luker（8003）上构造一个「写入中途失败」的包（如超大包 + 中途断网），检查 `data/<user>/` 是否出现半量目录、`manifest.json` 是否残留。

### R-11 · 严重度：中 · `overwrite` 破坏性操作无二次确认

- **锚点**：`src/ui/workbench-template.js:298-304`（radio）、`index.js:1036-1043`（确认逻辑）
- **判定**：可用性/数据风险
- **证据**：
  ```js
  <input type="radio" name="restore-mode" value="overwrite">
  <div class="radio-text">
    <strong>全量覆盖</strong>
    <span>重置当前用户数据，完全替换为该数据包内容</span>
  </div>
  ```
  与 `merge` 共享同一个「确认恢复写入」按钮，一次点击即发出**不可逆**请求。
- **修复方向**：`overwrite` 选中时按钮变红 + 要求勾选「我已知晓会清空当前用户数据」；或在弹窗内提供「先导出当前数据备份」按钮。

### R-12 · 严重度：中高 · 无并发互斥：多个入口可同时发起恢复

- **锚点**：`src/ui/export-queue.js:305-310`、`src/ui/export-queue.js:366`、`src/ui/stash-list.js:130-135`、`src/ui/stash-list.js:189-193`、`src/ui/archive-manager.js:167-177`、`index.js:1014-1026`（`openRestoreModal`）
- **判定**：并发/数据一致性风险
- **证据**：
  ```js
  // export-queue.js:366 —— 每行一个按钮，无任何 in-flight 禁用
  if (isHostAvailable && typeof onRestoreToHost === 'function') {
    btns.appendChild(mkBtn('restore', '<i class="fa-solid fa-rotate"></i> 写回宿主', '', () => onRestoreToHost(item)));
  }
  ```
  ```js
  // index.js:1014-1026 —— openRestoreModal 不检查「是否已有恢复在途」
  function openRestoreModal(archiveFile) {
    if (!host.isPlugin) { alert('...'); return; }
    pendingRestoreFile = archiveFile;
  ```
  唯一的互斥是 `btnConfirmRestore.disabled = true`（`index.js:1045`），但该按钮位于**确认后即被 `display:none` 隐藏**的弹窗内（`index.js:1042`），对「待导出区/工作区/归档区」的其它「写回宿主」按钮毫无约束。
- **后果**：用户可同时发起 2–3 个 `POST /api/users/restore`，两个写盘事务并发操作同一用户目录 → **数据交错/丢失**，且插件侧无任何提示。
- **修复方向**：引入全局 `restoreInFlight` 标志（或复用 `TaskManager` 的单任务语义）：在途时禁用所有「写回宿主」入口并显示「已有恢复进行中」。

### R-13 · 严重度：低 · 恢复前不校验载荷合法性

- **锚点**：`src/ui/host-bridge.js:431-437`
- **判定**：健壮性
- **证据**：`formData.append('avatar', zipBlob, 'backup.zip');` —— 直接提交，无 `Blob` 类型/大小/zip 魔数校验；`index.js:1014` 的 `openRestoreModal` 也只检查 `host.isPlugin`。
- **后果**：把非 zip 文件（或空 Blob）提交给宿主，宿主的失败信息通常晦涩，用户难以自诊。
- **修复方向**：提交前做轻量魔数检查（`PK\x03\x04`）+ 最近一次 `validateBackupShape` 结果复用；不合法时提前给出人话提示。

### R-14 · 严重度：中高 · `mode` / `incremental` 字段在 ST 侧语义未证实（UI 承诺 vs 实际行为）

- **锚点**：`src/ui/host-bridge.js:434-435`
- **判定**：待验证（仓库自身 research 已标记为待实测）
- **证据**：
  ```js
  formData.append('mode', mode);
  formData.append('incremental', mode === 'merge' ? 'true' : 'false');
  ```
  仓库内已有研究记录显示该字段组的宿主支持度**尚未完成实测确认**：
  - `.trellis/tasks/archive/2026-09/09-07-host-detect/design.md:76`：`restoreToHost(zip, { platform })` … **确认 Luker `/api/users/restore` 对 FormData 字段（handle/mode/incremental）的接受度与 ST 一致（实测确认，差异记入 research）`**（即当时尚待实测）；
  - `.trellis/tasks/archive/2026-09/09-07-workstation-overhaul/research/host-detection-and-luker-ui.md:51`：Luker 恢复「按路径后缀匹配」且**跳过包内 manifest.json**。
- **后果**：若 ST 原生 `/api/users/restore` 只认 `avatar` + `handle`，则 UI 承诺的「增量合并（保留已有数据）」与「全量覆盖」在 ST 上**会退化为同一种行为**（很可能是原生导入语义），`README.md:17-18` 与 `workbench-template.js:293-303` 的对外承诺与实际不符——属于「文档/UI 不符」而非崩溃，但用户在 `overwrite` 预期下可能被意外保留旧数据（反之亦然）。
- **修复方向**：以**官方文档**为准核实两宿主该端点参数（L1-MR-5：禁止翻源码找 API）；确认不支持的宿主上隐藏 `mode` 选择并明确文案「宿主原生导入（模式不可选）」。
- **验证方法（待验证，禁止连实例，仅记录方案）**：在 Dev ST（8001）/ Dev Luker（8003）各发一次带 `mode=merge` 与 `mode=overwrite` 的同包恢复，比对目标目录差异与响应体字段。

---

# 三、错误处理（Q3）

> **正面确认**：恢复失败一定会到达用户（`index.js:1056-1059` 三重提示：进度条文案 + `logger.error` + `alert`），不存在「失败无声」；恢复成功后亦有 `logger.success`（`host-bridge.js:460`）。

### R-15 · 严重度：中 · 伪成功：响应体解析失败被当作 `success: true`

- **锚点**：`src/ui/host-bridge.js:459`
- **判定**：静默错误吞没
- **证据**：
  ```js
  const result = await response.json().catch(() => ({ success: true }));
  logger.success(`数据包恢复至当前用户 (${handle}) 成功！模式: ...`);
  ```
  `.catch()` 无条件返回「成功」字面量；`response.ok` 为真但 body 非 JSON（如代理插入的 HTML 错误页、空体）时，插件会**打印成功日志并返回成功**。
- **后果**：用户得到「恢复成功」的结论，实际宿主是否写入未知 → 与 R-10 的「无回滚」叠加会放大误判。
- **修复方向**：改为 `const result = await withTimeout(response.json(), 30000).catch(() => null);`，并在 `result === null` 时写 `logger.warn('宿主未返回可解析的结果，无法确认写入明细')`，返回值带 `unverified: true` 标记，由 UI 提示「已完成请求，但未能确认明细，请核对数据」。

### R-16 · 严重度：低 · 空 catch：错误详情提取静默失败

- **锚点**：`src/ui/host-bridge.js:450-453`
- **判定**：可接受的降级（但仍损失诊断信息）
- **证据**：
  ```js
  let detail = '';
  try {
    const errJson = await response.json();
    detail = errJson.error ?? '';
  } catch { /* 忽略非 JSON */ }
  ```
- **后果**：宿主返回非 JSON 错误体时，用户只看到 `恢复失败 (500)`，丢失真正的错误正文（如磁盘满、路径权限）。
- **修复方向**：`catch` 内改用 `await response.text()` 的短截断（如前 200 字符）拼进 `detail`，并确保经过 `textContent`/转义后再展示（见 R-25）。

### R-17 · 严重度：低 · 扩展清单检查失败仅 `logger.warn` 吞掉

- **锚点**：`src/ui/host-bridge.js:480-481`
- **判定**：**有意为之的非阻塞吞没**（可接受，但需注意边界）
- **证据**：
  ```js
  } catch (err) {
    logger.warn('检查扩展清单失败 (非阻塞):', err);
  }
  ```
- **后果**：此处的「非阻塞」是合理设计（恢复已成功），但**边界在于 R-07**：`:472` 那个未 `await` 的 promise 的 rejection 不在这个 catch 覆盖范围内，二者语义不同却被写在同一个注释意图下，容易让后续维护者误判「整块都已兜住」。
- **修复方向**：保持非阻塞语义，但补 `await`（见 R-07），并在注释中明确「本 catch 不覆盖面板内部异步错误」。

### R-18 · 严重度：低 · IndexedDB 打开失败仅 `console.warn` 且直接 reject

- **锚点**：`src/storage/db.js:124-127`
- **判定**：静默降级
- **证据**：
  ```js
  request.onerror = () => {
    console.warn('打开 IndexedDB 失败:', request.error);
    reject(request.error);
  };
  ```
- **后果**：`console.warn` 不进入 `logger`（用户可在界面看到的日志），所以「工作区读包失败」对用户是**无声的**，与 R-06 的「无反应」叠加。
- **修复方向**：改走 `logger.error`；并在「写回宿主」按钮点击失败路径上给出 `alert`/提示条。

---

# 四、进度回调与 DOM 合帧（Q4）

### R-20 · 严重度：中高 · 恢复链路零进度反馈（「假死」体验）

- **锚点**：`src/ui/host-bridge.js:427`（函数签名无 `onProgress`/`onPhase`）、`index.js:1046-1050`
- **判定**：无高频回调；**反向问题——完全没有进度**
- **证据**：
  ```js
  // index.js:1046-1050
  btnConfirmRestore.disabled = true;
  view.setProgress(15, `正在恢复写入数据包至宿主 (${mode === 'merge' ? '增量合并' : '全量覆盖'})...`);
  logger.info(`向宿主发起数据包恢复请求: ${fileToRestore.name}, 模式: ${mode}`);
  await restoreToHost(fileToRestore.blob, { mode, platform: host.platform });
  view.setProgress(100, `恭喜！数据包已成功恢复写入到当前酒馆用户！`);
  ```
  对比拉取链路有完整三段式回调（`host-bridge.js:254` 的 `onPhase(phase, received, total, opfsName, currentBps)`）。
- **后果**：GB 级包恢复期间进度条**永远停在 15%**；与 R-01/R-02 的永久 pending 叠加后，**用户完全无法区分「正在上传」与「已经挂死」**——这是本链路最直接的体感缺陷。
- **技术约束（重要）**：`fetch()` **不提供上传进度事件**。要拿到上传进度必须改用 `XMLHttpRequest`（`xhr.upload.onprogress`），或用 Chromium 的 readable-stream 上传请求体（`duplex: 'half'`，跨浏览器兼容性不足）。
- **修复方向**：
  1. 上传阶段：改用 `XMLHttpRequest` 封装（保留 CSRF header），暴露 `onProgress`，进度映射到 15–70%；
  2. 宿主处理阶段（TTFB 之后）：显示不定态动画 + 「宿主正在解包写入，大包可能需要数分钟」文案，避免「看起来卡死」；
  3. 超过阈值（如 30s 无字节推进）时提示「宿主无响应，可取消」。

**同时确认（正面）**：本链路的**周边** DOM 更新均已合帧，恢复链路本身不引入新的高频重排：

| 位置 | 机制 | 结论 |
| --- | --- | --- |
| `src/ui/view.js:52-56` | `setProgress` 经 `requestAnimationFrame` 合帧 | ✔ |
| `src/ui/export-queue.js:385-395` | 列表重建 `renderCoalesced` 按帧合并 | ✔ |
| `src/ui/log-console.js:301` + 帧合并逻辑 | 日志批量 `flushPendingEntries`（每帧上限 50 行） | ✔ |
| `src/ui/host-bridge.js:815-831` | 扩展安装循环**逐项**改 DOM（非高频，纯用户点击驱动） | 可接受 |

---

# 五、敏感面（Q5）

### R-21 · 严重度：中高 · 恢复包内清单字段直接 `innerHTML` 注入宿主页面

- **锚点**：`src/ui/host-bridge.js:702`、`:706`、`:714`（触发源 `:472`）
- **判定**：HTML 注入面
- **证据**：
  ```js
  // host-bridge.js:702-714（数据来自恢复包内 _convert/extensions-manifest.json）
  itemEl.innerHTML = `
    ...
      <strong style="...">${ext.displayName || ext.name || folder}</strong>
      <span style="font-size: 0.75rem; color: #6c7086;">(${folder})</span>
    ...
      <span>${ext.url || '无远程 URL'}</span>
      ${ext.branch ? `<span style="...">分支: ${ext.branch}</span>` : ''}
  `;
  ```
  触发链：`restoreToHost`（`:472`）读取**被恢复包内**的 `_convert/extensions-manifest.json` → `JSON.parse`（`:470`）→ 字段未经转义进入 `innerHTML`，且该弹窗被 `document.body.appendChild`（`:687`）挂到**宿主页面上下文**。
- **后果**：恶意/被篡改的 ZIP 可让插件的恢复后引导面板在宿主页面内注入任意 HTML（含事件属性），危险面覆盖整站（宿主是单页应用，与插件共享同一文档）。
- **修复方向**：全部改用 `textContent`，或引入统一 `escapeHtml()`（项目内已有实现可参考：`src/ui/log-console.js:createLogLineElement` 使用 `escapeHtml`）；`ext.url` 额外做 `^https?://` 白名单（`:819` 已有同类校验，可复用）。

### R-22 · 严重度：中 · 自造全屏浮层（违反 L1-MR-4「UI 落点只认官方位置」）

- **锚点**：`src/ui/host-bridge.js:615`（`position: fixed` + `z-index: 99999`）、`:687`（`document.body.appendChild`）
- **判定**：规则违背（宿主兼容性风险）
- **证据**：
  ```js
  modalOverlay.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0, 0, 0, 0.75); backdrop-filter: blur(8px);
    z-index: 99999; display: flex; align-items: center; justify-content: center;
    padding: 20px; font-family: system-ui, -apple-system, sans-serif;
  `;
  ```
- **后果**：自造浮层无宿主兼容性承诺（L1-MR-4 原文：「复杂 UI 用官方 Popup 呈现，不要自造浮层」）；`z-index: 99999` 可能压住宿主自身的弹窗层级，与其他扩展冲突。
- **修复方向**：改用宿主官方 `callGenericPopup`（同类场景仓库内已用，见 `.trellis/tasks/archive/2026-09/09-12-native-ui-inject-authority/research/*` 中对宿主 popup 的调研），或在扩展设置抽屉内部渲染该清单（不越出官方落点）。

### R-23 · 严重度：低 · 浮层内硬编码配色，未继承宿主主题变量

- **锚点**：`src/ui/host-bridge.js:615-629`、`:624`、`:633`、`:648`、`:655`、`:659`、`:706`
- **判定**：规则违背（L0-10 / L1-MR-3 精神）
- **证据**：`background: #1e1e2e; color: #cdd6f4;`（`:624`）、`color: #89b4fa`（`:633`、`:667`、`:710`）、`#f38ba8`（`:648`、`:655`、`:659`）、`color: #cdd6f4`（`:706`）等硬编码 Catppuccin 色值；未使用 `var(--SmartTheme*, 回退值)`。
- **备注**：因该元素为 `document.createElement` + inline style（非 `style.css`），不触发 `scripts/css-scope.js` 的双前缀自查，属**规则灰区**；但「配色一律继承宿主变量、禁止硬编码」的意图被违背，用户在亮色主题下会看到突兀的深色浮层。
- **修复方向**：抽出一份最小内联样式表（类名带 `st-zip-` 前缀），色值改用宿主变量 + 回退值。

### R-24 · 严重度：低 · 用户名（handle）进入可导出的日志

- **锚点**：`src/ui/host-bridge.js:460`、`src/ui/host-bridge.js:263`、`index.js:1021`
- **判定**：低风险信息暴露
- **证据**：
  ```js
  logger.success(`数据包恢复至当前用户 (${handle}) 成功！模式: ${mode === 'merge' ? '增量合并' : '全量覆盖'}`);   // :460
  logger.info(`向宿主发起数据包导出请求 (用户: ${handle})...`);                                                     // :263
  restoreModalDesc.innerHTML = `即将把数据包 <strong>「${archiveFile.name}」</strong> ...`;                        // index.js:1021
  ```
  日志可被「复制日志 / 下载日志」导出（`src/ui/log-console.js:243-283`），把 handle 带出插件之外。
- **后果**：用户把日志贴到 issue/论坛时，附带其宿主用户名与（潜在）文件名。属隐私最小化问题，非凭据泄漏。
- **修复方向**：日志中的 handle 脱敏（如 `zh***`）或降为 `debug` 级别不默认展示。

### R-25 · 严重度：低 · 错误文本进入 `innerHTML`

- **锚点**：`src/ui/host-bridge.js:831`
- **判定**：低风险注入面
- **证据**：`statusEl.innerHTML = '<i class="fa-solid fa-circle-xmark" ...></i> ${err.message || '安装失败'}'` —— `err.message` 可能携带宿主返回文本（`installExtensionViaHost` 的 `detail = await response.text()`，`:531`）。
- **修复方向**：改用 `textContent` 追加错误文本节点。

### R-26 · 严重度：低 · 恢复包清单条目数无上限

- **锚点**：`src/ui/host-bridge.js:467-472`（判断）、`:691-737`（全量渲染）、`:785-850`（逐个安装）
- **判定**：资源耗尽（DoS）面
- **证据**：`if (Array.isArray(manifest.extensions) && manifest.extensions.length > 0)` —— 只有「非空」判断，没有上限；随后 `extensions.forEach(...)` 同步为每条创建 DOM，安装循环也是逐条 `await`。
- **后果**：构造含数万条 `extensions` 的包可让宿主页面在恢复后卡死（DOM 爆炸），且用户难以中断。
- **修复方向**：设上限（如 200 条）+ 超限提示「清单过大，已截断」。

### 正面确认：CSRF / 凭据

- `getCsrfToken()` 返回的 token **仅**写入请求头（`host-bridge.js:441`、`:273`、`:523`、`:585`；`src/ui/usage-dashboard.js:28`），全仓 grep `token|csrf|X-CSRF` 未发现任何日志/DOM 输出 token。
- `logger.log()` 的 `detail` 参数（`src/core/logger.js:43-83`）会把对象 `JSON.stringify` 后渲染到日志面板；恢复链路传给它的 `detail` 只有 `Error` 对象（`:455`），不含 token。
- **未发现**用户绝对路径进入日志或 DOM（`zipIo.openReader` 的字符串路径分支仅用于 Node 测试环境，`src/core/zip-io.js:85-89`）。
- 结论：**CSRF 处理符合规范，无凭据泄漏**。

---

## 发现汇总表

| ID | 严重度 | 锚点 | 一句话 |
| --- | --- | --- | --- |
| R-01 | 高 | `host-bridge.js:437` | 恢复主请求无超时/无 signal → 永久 pending |
| R-02 | 高 | `host-bridge.js:158,168,429` | 前置凭证 fetch 无超时 |
| R-03 | 中 | `host-bridge.js:459` | 成功分支 `response.json()` 无超时 |
| R-04 | 中 | `host-bridge.js:449` | 错误分支 `response.json()` 无超时 |
| R-05 | 中 | `host-bridge.js:427`、`index.js:1028-1060` | 全链路无 AbortSignal、无取消入口 |
| R-06 | 中 | `stash-list.js:132,191`、`archive-manager.js:174`、`db.js:78-150` | IndexedDB `open` 无 `onblocked` → 入口 await 可永久挂起 |
| R-07 | 中高 | `host-bridge.js:472`（+`598-609`,`579-580`,`518`） | 未 await 的 async → 异常逃逸 + 内部无界 |
| R-08 | 低 | `host-bridge.js:464,469`、`zip-io.js:85-89` | 本地 Zip 读取无规模上限 |
| R-09 | 中 | `host-bridge.js:746-753,579-580` | 清理残留动作无界 + 按钮永久 disabled |
| R-10 | 中 | `host-bridge.js:427-489`、`workbench-template.js:298-304` | 无回滚、无恢复前备份；残留待验证 |
| R-11 | 中 | `workbench-template.js:298-304`、`index.js:1036-1043` | `overwrite` 无二次确认 |
| R-12 | 中高 | `export-queue.js:305,366`、`stash-list.js:130,189`、`archive-manager.js:167` | 无并发互斥，可并行多次恢复 |
| R-13 | 低 | `host-bridge.js:431-437` | 不校验载荷合法性 |
| R-14 | 中高 | `host-bridge.js:434-435` | `mode`/`incremental` 在 ST 侧语义待验证 |
| R-15 | 中 | `host-bridge.js:459` | 解析失败被当作成功（伪成功） |
| R-16 | 低 | `host-bridge.js:450-453` | 空 catch，丢失错误正文 |
| R-17 | 低 | `host-bridge.js:480-481` | 清单检查失败仅 warn（语义边界与 R-07 混淆） |
| R-18 | 低 | `db.js:124-127` | DB 打开失败仅 `console.warn`（用户不可见） |
| R-19 | — | `index.js:1056-1059` | **正面**：失败有 三重提示 |
| R-20 | 中高 | `host-bridge.js:427`、`index.js:1046-1050` | 恢复链路零进度 → 进度条长期固定 15% |
| R-21 | 中高 | `host-bridge.js:702,706,714`（触发 `:472`） | 包内清单字段 `innerHTML` 注入宿主页面 |
| R-22 | 中 | `host-bridge.js:615,687` | 自造全屏浮层（违反 L1-MR-4） |
| R-23 | 低 | `host-bridge.js:615-629,624,633,648,706` | 硬编码配色，不继承宿主主题变量 |
| R-24 | 低 | `host-bridge.js:460,263`、`index.js:1021` | 用户名进入可导出日志 |
| R-25 | 低 | `host-bridge.js:831` | `err.message` 进入 `innerHTML` |
| R-26 | 低 | `host-bridge.js:467-472,691-850` | 清单条目数无上限 |

**统计**：25 条缺陷发现（高 2 · 中高 5 · 中 9 · 低 9）+ 1 条正面确认（R-19）

---

## 待验证清单（本次只读审计无法证实，禁止连实例）

| 编号 | 待验证事项 | 验证方法（留待有权限时执行） |
| --- | --- | --- |
| V-1 | 恢复中断后宿主侧是否残留半量数据 | 在 **Dev** 实例（8001/8003，**严禁 Real 8002/8004**）发超大批量恢复并在中途断网，比对 `data/<user>/` 目录条目数 |
| V-2 | ST `/api/users/restore` 是否接受 `mode`/`incremental` | 以**官方文档**为准核实端点参数（L1-MR-5 禁止翻源码定 API）；必要时在 Dev ST 分别发 `merge`/`overwrite` 比对结果 |
| V-3 | `response.json()` 在代理截断场景下是否真的会挂起 | 用合成服务器（仅本地回环）返回 `Content-Length` 大于实际体，观察 promise 行为 |
| V-4 | 恢复期间并发两次请求的实际后果 | Dev 实例上并发发送两个包，比对用户目录完整性 |

---

## 立即修复建议

> 优先级排序：先消除「永久 pending + 无法取消」，再处理「伪成功 + 无进度」。

1. **给恢复链路加超时与中止（对应 R-01 / R-02 / R-05）** —— 这是本次审计最高优先级。
   - 抽出 `hostFetch(url, opts)` 助手：默认 `AbortController` + `Promise.race` 超时（凭证类 15s，恢复类按包大小自适应，最小 5min）；
   - `restoreToHost(zipBlob, { mode, platform, signal, timeoutMs, onPhase })` 扩展签名，`signal` 透传给 `fetch`；
   - `index.js:1036-1060` 在途期间显示「取消」按钮，取消后明确提示「已取消请求；宿主可能仍在处理，请稍后核对数据」。
2. **修掉伪成功（对应 R-15）** —— `:459` 的 `.catch(() => ({ success: true }))` 改为返回 `null` + `unverified` 标记，UI 文案区分「成功」与「请求已发出但未确认」。
3. **修掉未 await 的 async 逃逸（对应 R-07）** —— `:472` 补 `await` + `.catch(...)`，避免 unhandled rejection 与按钮永久 disabled。
4. **堵住注入面（对应 R-21）** —— `:702/:706/:714` 全部改 `textContent`（或复用 `escapeHtml`），`ext.url` 加 `^https?://` 白名单。
5. **加恢复并发互斥（对应 R-12）** —— 全局 `restoreInFlight` 标志，在途时禁用全部「写回宿主」入口。此项改动小、收益直接（防数据交错）。
6. **`overwrite` 二次确认 + 恢复前默认备份（对应 R-11 / R-10）** —— 破坏性路径的最低限度护栏。
7. **`openDb` 补 `onblocked` + `runTransaction` 超时（对应 R-06 / R-18）** —— 让「按钮点了没反应」至少变成可见错误。

## 建议纳入后续优化任务

1. **恢复链路进度可见化（R-20）** —— 独立小任务：改用 `XMLHttpRequest` 拿上传进度（`xhr.upload.onprogress`），并设计「宿主处理中」不定态阶段；与 `09-23-batch-restore-refresh` 的批量恢复设计合并考虑（批量场景下无进度的问题会被放大 N 倍）。
2. **恢复事务化 / 可回滚（R-10）** —— 与 Authority 可选增强层结合：恢复前自动快照（本地/Authority KV），失败时可一键回退；纯前端降级路径至少提供「恢复前自动导出到待导出区」。
3. **宿主端点语义核实与能力矩阵（R-14）** —— 依官方文档产出 `/api/users/restore` 的参数支持矩阵（ST / Luker / TT / PT），据此决定 `mode` 选择器在各宿主的显示策略；修正 `README.md:17-18` 与 `workbench-template.js:293-303` 的对外承诺。
4. **扩展安装面板合规化重构（R-22 / R-23 / R-26）** —— 改用宿主官方 popup / 官方落点，配色继承宿主变量，并加清单条目上限；这与 `09-23-extension-cloud-migration` 直接相关，建议合并设计。
5. **日志隐私最小化（R-24）** —— 统一在 `logger` 层做敏感字段（handle、绝对路径）脱敏，或在导出口径上过滤。
6. **恢复链路补单测护栏** —— 现有 `test/backup-chats.test.js` / `test/convert-resume.test.js` 覆盖了拉取与续传，但**未覆盖恢复链路的超时/错误分支**；建议新增 `test/restore-chain.test.js`（mock `fetch` 挂起 → 断言超时抛错、断言伪成功修复、断言并发互斥生效）。这与「L1-MR-7 有界等待」规则的回归防护直接对应。

---

## 方法学备注（可复核）

- 本报告全部锚点均通过工具逐行核对（`read_file` 精确行范围 + `grep_search` 行号确认），未依赖任何摘要或记忆。
- 未执行任何写操作于产品代码；本文件为该子代理唯一产出。
- 未运行测试、未构建、未连接宿主实例（符合任务 §Out of Scope 与 L0-1 实例隔离铁律）。
