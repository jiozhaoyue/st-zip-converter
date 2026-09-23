# 恢复链路与传输性能安全审计 · 汇总索引

> 任务：`.trellis/tasks/09-23-perf-security-audit`
> 生成日期：2026-09-23
> 性质：**只读审计**，本任务不修复任何发现；修复走对应实施任务。
> 分片报告：`01-restore-chain.md` / `02-authority-transfer.md` / `03-splitter-memory.md` / `04-dom-injection.md`

---

## 1 四链路总览

| 链路 | 分片报告 | 发现数 | 最高严重度 | 一句话结论 |
| --- | --- | --- | --- | --- |
| ① 恢复 `restoreToHost` | [`01-restore-chain.md`](./01-restore-chain.md) | 25（高 2） | **高** | **存在无界等待**：全部网络 `await`（凭证 / 主请求 / 响应解析）与入口 IndexedDB `await` 均无超时、无 `AbortSignal`、无 destroy 兜底；UI 无取消入口 |
| ② Authority 传输 | [`02-authority-transfer.md`](./02-authority-transfer.md) | 10（高 2） | **高** | 分块只切了「发送单元」没切「驻留单元」——整包 `arrayBuffer()` 常驻全程；且 KV 写失败会让「暂停」永不生效，把可选后端变成主路径失败源 |
| ③ 分卷内存模型 | [`03-splitter-memory.md`](./03-splitter-memory.md) | 11（高 2） | **高** | 全部分卷 Blob 同时驻留（`ExportQueue.items` + `lastConvertedBlob`），且分卷前把**整包**解压进内存，峰值显著放大 |
| ④ DOM 高频路径 / 注入面 | [`04-dom-injection.md`](./04-dom-injection.md) | 9（高 1） | **高** | 存在**完整可达的存储型 XSS 路径**：包内 `_convert/extensions-manifest.json` 字段未转义拼进宿主页面；高频路径 rAF 合帧**无回归** |

**交叉印证**：链路①报告（R-21）与链路④报告（D-01）从两个不同视角**独立指向同一落点** `src/ui/host-bridge.js:702/706/714`，互为独立证据，修复时以同一处为准。

**既有约定核验**：
- L1-MR-7（有界等待）—— ① 恢复链路**违反**；② Authority 网络调用未接 `AbortSignal`（F-H，低）；③ 分卷阶段无 `AbortSignal`。
- L1-MR-9（高频合帧）—— **三条高频路径全部已 rAF 合帧**（`view.js:44-61`、`export-queue.js:384-397`、`log-console.js:296-304`），**无回归**。
- L1-MR-1 / L0-11（后端不得阻塞纯前端主路径）—— ② 的 F-B **违反**（唯一把可选后端变成主路径失败源的问题）。
- L1-MR-4（UI 落点只认官方位置）—— ① 的 R-22 记录自造全屏浮层。

---

## 2 「立即修复」档（止血，改动小 × 收益大）

按建议实施顺序排列。锚点取自各分片报告。

| 序 | 动作 | 锚点 | 来源 | 严重度 |
| --- | --- | --- | --- | --- |
| 1 | **扩展清单字段改 `textContent` / `createElement`**，`ext.url` 补 `^https?://` 白名单 | `src/ui/host-bridge.js:702-733` | R-21 / D-01（B1） | **高（安全）** |
| 2 | **恢复链路加超时 + 中止**：抽 `hostFetch()`（AbortController + `Promise.race`），`signal` 透传 `fetch`，UI 加取消按钮 | `src/ui/host-bridge.js:158/168/429/437`；`index.js:1036-1060` | R-01 / R-02 / R-05 | **高** |
| 3 | **`authority-store` 去掉整包 `arrayBuffer()` 常驻**（改 `blob.stream()` 逐块切分） | `src/storage/authority-store.js:118,132` | F-A | **高** |
| 4 | **checkpoint adapter 加 `try/catch` 回退**，保证「暂停」不依赖后端可用性 | `authority-store.js`（`createCheckpointAdapter`）；`src/core/task-manager.js:131` | F-B | **高** |
| 5 | **分卷后立即释放中间产物引用**：`lastConvertedBlob = null` | `index.js:1188`、`index.js:1232` | S-01（A1） | **高** |
| 6 | **条目写入后即时释放**：循环内 `entries[i].data = null` 或改 `for await` 流式喂 writer | `index.js:934-938`、`index.js:1210-1214` | S-02（A2） | **高** |
| 7 | **修掉未 `await` 的 async 逃逸**（补 `await` + `.catch`），消除 unhandled rejection 与按钮永久 disabled | `src/ui/host-bridge.js:472` | R-07 | 中高 |
| 8 | **加恢复并发互斥**：全局 `restoreInFlight` 标志，在途禁用全部「写回宿主」入口 | `index.js` 各恢复入口 | R-12 | 中高 |
| 9 | **修掉伪成功**：`.catch(() => ({ success: true }))` 改为 `null` + `unverified`，UI 区分「成功」与「已发出未确认」 | `src/ui/host-bridge.js:459` | R-15 | 中 |
| 10 | **传输失败清理 / 消除孤儿块与混合损坏窗口**（新 part 名 → 换清单 → 清旧） | `authority-store.js` `putArtifact` | F-D / F-F | 中 |
| 11 | **文件名类注入点改 `textContent`** | `stash-list.js:155`、`export-queue.js:332`、`index.js:604`、`index.js:1021`、`file-drop.js:78/136`；`host-bridge.js:831` | D-02 / D-03（B2/B3） | 中 |
| 12 | **分卷阶段接 `onProgress` + `AbortSignal`**（两个调用点都补传） | `index.js:939`、`index.js:1215`、`splitter.js:75` | S-04（A6） | 中 |
| 13 | **`overwrite` 二次确认 + 恢复前默认备份**（破坏性路径最低护栏） | `host-bridge.js` 恢复入口 | R-11 / R-10 | 中 |
| 14 | **`zipIo.add` 去冗余全量拷贝 + `Uint8ArrayWriter` 预置容量** | `zip-io.js:192/197`、`zip-io.js:115` | S-05 / S-06（A3/A4） | 中 |
| 15 | **`getAuthorityClient()` 加 promise 单例缓存**（顺带修正 `:23` 注释） | `authority-store.js:23` 附近 | F-G | 中 |
| 16 | **`ExportQueue` 对 `split-part` 设总量上限 + 超限提示** | `export-queue.js:130-140` | S-05（A5） | 中 |
| 17 | **抽出共享 `escapeHtml`（补 `"` `'`）+ grep 自查门禁** | `log-console.js:8-12` → 新建 `src/ui/escape.js` | D-06（B5） | 低（防复发） |
| 18 | **`openDb` 补 `onblocked` + 事务超时**（让「点了没反应」变可见错误） | `src/storage/db.js` | R-06 / R-18 | 低 |
| 19 | **`data-id="${…}"` 改 `element.dataset.id`**（去隐式契约） | `export-queue.js:334`、`stash-list.js:157` | D-04（B4） | 低 |
| 20 | **`console.warn(err)` 收敛为 `err?.message`**，产物名日志截断 | `authority-store.js` | F-I | 低 |

---

## 3 「纳入后续优化任务」档

| 序 | 主题 | 建议归属任务 | 来源 |
| --- | --- | --- | --- |
| 1 | **Authority 传输流式化**（put 峰值 `N + 2.33C` → `O(C)`；get `2N~3N` → `O(C)`）+ 孤儿块对账 GC | `09-23-authority-cloud-transfer`（方向一致，避免重复设计） | F-A / F-C / F-D-F |
| 2 | **内存基线测试**：大包（256 MiB / 1 GiB）`heapUsed` 峰值断言，把估算升级为可回归指标 | 新建（或并入上项） | ②③ |
| 3 | **恢复链路进度可见化**（`XMLHttpRequest.upload.onprogress` + 「宿主处理中」不定态） | `09-23-batch-restore-refresh`（批量场景放大 N 倍） | R-20 |
| 4 | **恢复事务化 / 可回滚**（恢复前快照；纯前端降级路径至少自动导出到待导出区） | 与 Authority 增强层合并设计 | R-10 |
| 5 | **宿主端点语义核实与能力矩阵**（`/api/users/restore` 的 `mode`/`incremental` 在 ST/L/TT/PT 的支持度）；修正 `README.md:17-18` 与 `workbench-template.js:293-303` 对外承诺 | 依赖官方文档（L1-MR-5） | R-14 |
| 6 | **扩展安装面板合规化重构**（改用宿主官方 popup、配色继承宿主变量、清单条目上限） | `09-23-extension-cloud-migration` | R-22 / R-23 / R-26 |
| 7 | **恢复链路补单测护栏** `test/restore-chain.test.js`（mock fetch 挂起 → 断言超时抛错；伪成功修复；并发互斥生效） | 新建 | R-01~R-15 |
| 8 | **流式分卷重构**：`splitArchiveEntries` 改吃 `AsyncIterable` + `addLazy`，消除 `entries` 物化 | 与上项 1 复用同一接缝 | S-01 / S-02 |
| 9 | **分卷产物落盘优先**（每卷即写 OPFS/IndexedDB，队列只存句柄 + 配额预检） | 新建 | S-01 |
| 10 | **统一转义层 + 机器化守卫**：仿 `scripts/css-scope.js` 建 `innerHTML` 白名单 CI 门禁（**唯一能防复发的机制**） | 新建（参考 CSS 作用域先例） | D-01 / D-06 |
| 11 | **列表增量渲染**（keyed diff 替代整块重建，~20 处整表重写） | 新建 | D-08 / D-09 |
| 12 | **日志隐私最小化**（`logger` 层对 handle / 绝对路径脱敏） | 新建 | R-24 |
| 13 | **死代码处置**：`src/ui/split-deliver-modal.js` 全仓无调用点（接回或删除），同步更新 `test/plugin.test.js` | 新建 | S-09 |
| 14 | **双入口一致性机器化校验**：`host-split-select`（`index.html:121`）无消费点，纳入 L1-MR-10 自查 | 新建 | ③ |

---

## 4 待验证清单（只读审计无法证实，禁止连 Real 实例）

| 编号 | 事项 | 验证方法 |
| --- | --- | --- |
| V-1 | 恢复中断后宿主侧是否残留半量数据 | **Dev** 实例（8001/8003，**严禁 8002/8004**）发大批量恢复并中途断网，比对 `data/<user>/` 条目数 |
| V-2 | ST `/api/users/restore` 是否接受 `mode` / `incremental` | 以**官方文档**为准核实（L1-MR-5 禁止翻源码定 API） |
| V-3 | `response.json()` 在响应体被截断时是否真的挂起 | 本地回环合成服务器返回 `Content-Length` 大于实际体 |
| V-4 | 恢复期间并发两次请求的实际后果 | Dev 实例并发发两个包，比对用户目录完整性 |
| V-5 | SDK `blob.put` 内部是否保留/复制传入的 base64 串（决定 F-A 峰值上限） | Dev 实例 + DevTools Memory 快照，`putArtifact` 前后取样 |
| V-6 | Authority KV 写失败是 reject 还是静默失败（决定 F-B 触发概率） | mock client 让 `kv.set` reject，观察 `pause()` 后 `signal.aborted` |
| V-7 | vendor `BlobWriter` 旧代实现是否全内存累积 | 读 `src/vendor/zip.js` 实现分支 + 合成 2GB 包观测 |

---

## 5 审计范围与排除

- **覆盖**：①`restoreToHost` 恢复链路 ②`authority-store.js` 传输 ③`splitter.js` 分卷内存 ④DOM 高频路径 + `innerHTML` 注入面（全仓 `src/ui/**` 57 处赋值 + 根 `index.js` 5 处相邻发现）。
- **排除**：全仓安全审计、产品代码修复、Real 实例连接、`npm test` / `npm run build` 执行。
- **方法**：静态代码审计（逐行核对锚点）+ 合成数据推算（内存峰值公式）；所有推算与静态结论已在分片报告标注「估算」或「待验证」。

## 6 执行方式备注

本次审计按要求由 **Copilot 自身子代理**并行执行：三条子代理同一轮并发派发（链路①/②/③+④），主代理同轮并行读取源码建立锚点；**未调用任何外部 agent**（`trellis channel` 的 claude/codex worker 已派发后按用户指令全部终止）。
规范落位：`AGENTS.md` / `CLAUDE.md` / `.trellis/spec/guides/subagent-collaboration.md`。
