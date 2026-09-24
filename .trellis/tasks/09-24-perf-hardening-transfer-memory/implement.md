# 实施清单：恢复链路有界等待与传输/分卷内存峰值

> ⚠ **本任务于 2026-09-24 中途交接**——进度、改动清单、遗留项与下一步见同目录 [`handoff.md`](./handoff.md)。

> 需求见 `prd.md`，技术方案见 `design.md`，审计证据见
> `.trellis/tasks/archive/2026-09/09-23-perf-security-audit/research/`。

## 规划阶段

- [x] 核对 PRD 全部锚点与当前代码一致（`host-bridge.js:158/168/429/437`、
      `authority-store.js:118/132`、`index.js:1188/1232`、`task-manager.js:131`）。
- [x] 补 `design.md`（有界等待封装、并发互斥、去整包驻留、代际清理、暂停回退）。
- [x] 配置 implement/check 上下文清单。
- [x] 激活任务并建分支 `fix/perf-hardening-transfer-memory`。

## 实施阶段

### A. 有界等待封装（R1 / R3）

- [x] A1 新增 `src/ui/fetch-bounds.js`：`TimeoutError` / `SHORT_FETCH_TIMEOUT_MS` /
      `DEFAULT_FETCH_TIMEOUT_MS` / `fetchWithTimeout(url, init, { timeoutMs, signal, label })`。
- [x] A2 超时与外部 signal **合流**：**实际采用手动 `addEventListener('abort')` 转发**
      到内部 controller，并对「已取消」做入口短路。不引入 `AbortSignal.any` 分支——
      手动转发在全部目标环境行为一致，省去特征检测与其回退路径两条代码路径。
- [x] A3 `finally` 中强制 `clearTimeout`（防 Vitest 进程挂住）。
- [x] A4 `host-bridge.js` 的 `getCsrfToken` / `getHandle` 改用 `fetchWithTimeout`（短超时）。
- [x] A5 `restoreToHost` 签名加 `{ signal, timeoutMs }`；`POST /api/users/restore` 走封装。
      **上传默认不设硬超时**（`timeoutMs: 0`），仅由 `signal` 兜底（见 design §2.2）。
- [x] A6 修掉伪成功：`response.json()` 解析失败 → 返回
      `{ success: false, unconfirmed: true, reason: ... }`，不再 catch 成 `{ success: true }`。
- [x] A7 `index.js` 恢复确认回调区分三态文案（成功 / 未确认 / 失败）。

### B. 恢复并发互斥（R2）

- [x] B1 `host-bridge.js` 加模块级 `restoreInFlight` + 导出 `isRestoreInFlight()`。
- [x] B2 `restoreToHost` 入口判重（在途则抛错），`try/finally` 保证复位。
- [x] B3 `export-queue.js` 的 `renderExportQueue` 增加 `restoreInFlight` 渲染参数，
      在途时禁用每项「写回宿主」按钮。
- [x] B4 `index.js` 传入该参数，并在恢复在途时禁用 `#btn-confirm-restore`。
- [x] B5 `index.js` 调用点捕获互斥错误并给出明确文案（而非通用「恢复失败」）。

### C. authority-store 去整包驻留（R4 / R7）

- [x] C1 `putArtifact` 改 `blob.stream()` + `reader.read()` 逐块累积到 `CHUNK_SIZE` 再切。
      **`blobToBytes(blob)` 整包路径已彻底删除**（`getArtifact` 改为对 `Blob` 类型分支
      直接入列、不再转字节，故该 helper 已无任何引用方）。
- [x] C2 块命名加代际：`<name>__part_<gen>_<NNNNNN>`；清单新增 `gen` 字段。
- [x] C3 失败回滚：任一块 put 失败 → 删除本次已写块后抛错。
- [x] C4 新旧隔离：清单写入成功后删旧代际块（按清单记录的 `parts[].name`，**不解析命名**）。
- [x] C5 `getArtifact` 改边读边 `Blob` 组装，去掉中间 `merged` 整包副本。
- [x] C6 块大小、清单字段语义不变（读取端与既有已存数据无感）。

### D. 分卷与 Blob 即时释放（R6）

- [x] D1 `index.js` 分卷路径结束后 `lastConvertedBlob = null`（分卷已接管整包，无消费方）。
      非分卷路径**保留**引用（`btnRestoreLuker` 的快速恢复依赖它，见 design §5）。
- [x] D2 分卷的 `entries` 数组在 `try/finally` 中释放（`entries.length = 0`），
      消除逐条目 `data` 的驻留（S-01/S-02 主要收益）。
- [x] D3 若分卷失败，同样释放 `entries`（用 `finally` 而非仅成功路径）。

### E. TaskManager 断点回退（R5）

- [x] E1 `task-manager.js` 的 `pause()`：`adapter.save` 包 `try/catch`，
      `controller.abort()` **移出 try**，保证暂停语义不依赖可选后端。
- [x] E2 核对 `abort()` 路径：`adapter.remove` 失败同样不得阻断中止。
- [x] E3 核对 `complete()` / `fail()` 是否也有同类「后端失败阻断主路径」问题。

### F. 测试

- [x] F1 新增 `test/restore-chain.test.js`：超时抛错 / abort 生效 / 合流 /
      伪成功已修 / 并发互斥 + 复位。
- [ ] F2 扩展 `test/authority-store.test.js`：写入无整包 `arrayBuffer`；代际命名与清单指向；
      中途失败回滚；KV 失败不阻断暂停。
- [ ] F3 KV 写失败单测：mock `kv.set` reject → 断言 `pause()` 返回 true 且 `signal.aborted` 为真。

## 验证命令

```bash
npm test                                  # 全绿，≥ 226 passed / 2 skipped 不退化
npx vitest run test/restore-chain.test.js
npx vitest run test/authority-store.test.js
npm run check:css-scope                   # 退出码 0
npm run check:dom-injection               # 退出码 0
npm run build                             # 成功
```

手测（可选，仅 Dev 实例 8001 / 8003；**严禁** Real 8002 / 8004）：
`npm run dev` → 恢复大包时点取消 → 观察文案；分卷转换后确认内存回落。

## 回滚点

- 改动集中在 3 个模块 + 1 处渲染 + 测试，**无数据迁移**，`git revert` 可完全回滚。
- 每个实施块（A/B/C/D/E）后跑一次 `npm test`，失败即在该块内修复。

## 当前不做

- 不实现恢复进度可见化（`XHR.upload.onprogress`）——属 `09-23-batch-restore-refresh`。
- 不做分卷流式重构（`AsyncIterable` + `addLazy`）——属 `09-23-authority-cloud-transfer`。
- 不动宿主 UI 落点合规性与日志脱敏。
- 不新建内存基线自动化门禁。
