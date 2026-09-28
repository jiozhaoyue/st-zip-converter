# 实施计划 · 转换路径真增量续传

> 复选框**随执行实时勾选**（`L0-2`）。每条含验证命令与判据。
> 顺序**先立判据后接执行体**（`design.md` §7）：每条判据的**判别力证明**是本仓纪律，不是可选项。
> 设计见 `design.md`，需求与验收见 `prd.md`。

## 0 前置

- [ ] **0.1** 基线读数入 `research/`：`npm test` 与 `npm run e2e:web` 各跑一次（文件数/通过数）
- [ ] **0.2** 探路读数已落 `research/appendzip-probe.json`（`appendZip` 可用、字节级保持、需 `BlobReader`）—— **已完成（2026-09-28）**
- [ ] **0.3** 并发边界核对：`e2e/run.cjs` / 其它会话是否在跑 ⇒ 决定是否碰 `e2e/specs/**`
      （本任务只碰 `e2e/standalone/specs/**`）
- [ ] **0.4** 规格前置阅读（`trellis-before-dev` 纪律）：`state-management.md` 的长任务一节、
      `guides/standalone-web-and-cloud-e2e.md` §4.6（`KNOWN-DEFECT` 原文）、
      `quality-guidelines.md`「渲染路径必须有守护」

## 1 `src/core/zip-io.js`：存在门与半成品搬运

- [x] **1.1** `createWriter()` 返回对象加 `has(name)` —— 读既有 `written` 集合，**不新建第二个名单**
- [x] **1.2** 加 `async appendFrom(source)`，按 `design.md` §2.1 的四步：
      读源中央目录 → `writer.appendZip(new zip.BlobReader(blob))` → 登记 `written` → 回传清单。
      ⚠️ **必须传 `BlobReader` 实例**（裸 `Blob` 抛 `TypeError`，实测已证）
- [x] **1.3** 单测 `test/zip-append.test.js`：
      ① `appendFrom` 后产物含源全部条目且 `has()` 为真；
      ② **字节级免重压缩**：同名字条目的 `compressedSize` 与源相等；
      ③ `appendFrom` 后继续 `add` 新条目 ⇒ 两者都在、顺序为「搬运在前」；
      ④ 负例：坏包 / 空包 ⇒ 抛错且**不给 writer 留下半搬运状态**（或明确可作废）；
      ⑤ 负例：`appendFrom` 后 `add` 同名条目 ⇒ 静默早返（**这是 R4 互锁的机理，必须有守护**）
      —— *实做 5 项全绿。④ 更强：坏包在**中央目录读取阶段**就拦下（尚未写字节），且不登记名字；
      ② 另加前置门（样本 `compressedSize` 均 >0、压缩方法种类 >1）避免「两侧同为 0 时恒真」*
- [x] **1.4** 判别力证明：把 `zip.BlobReader(blob)` 改回裸 `blob` ⇒ ① 转红 ⇒ 恢复（读数入 `research/`）
      —— *实测：5 项中 **4 项转红**（① ② ③ ⑤），报错 `Cannot read properties of undefined (reading 'getReader')`
      **与探针记录同形**（可复现，不是一次性观察）；恢复后 5 passed。读数落 `research/step1-zip-io.json`*

## 2 `src/core/transform.js`：跳过判据改为存在门（**先做，这是缺陷本体**）

- [x] **2.1** 重写跳过分支（`transform.js:364-371`）为 `design.md` §2.3 的形态：
      先算 `outPath`，再 `writer.has(outPath)` 作必要条件，清单退为冗余校验
      —— *实做改为 `appendedNames.has(outPath)`（**不是** `writer.has`）：见 2.5 的实测陷阱。
      锚点同时从「台账的 target 标签」改为「名字 + 内容能对上」（ST 半成品续传到 L 目标是**合法**的，
      实测证明不该因标签不同而无脑作废）*
- [x] **2.2** 单测 `test/convert-resume.test.js` **改判据**（原 `:68-69` 的 `not.toContain`
      把缺陷当契约钉住了）：改为
      ① **只传清单、无半成品** ⇒ 清单命中的条目**照样写出**，产物条目数 == 源包（AC-1）；
      ② `report.totals.resumed === 0`（跳过 0 条）
      —— *实做 3 项：AC-1（含与「不给任何续传参数」的全量转换**逐条对照**）、AC-10（降级日志可观测）、
      伪台账（源里不存在的名字 ⇒ 不跳过不报错）。另把「普通对象台账」用例改为锁「形态被接受 + 产物完整」，
      归一化的**真**守护移到了 convert-append（那里存在门为真才会读台账）*
- [x] **2.3** **判别力证明（AC-1）**：把存在门注掉（回到只看清单）⇒ ① 转红（条目缺）⇒ 恢复。
      读数入 `research/`。**这是本任务最重要的一条证明——它演示的正是用户实际遇到的残缺包**
      —— *实测：注掉后 **5 项转红**，其中「只给台账」时跳过 **11 条**（`resumed=11`）⇒
      11 个条目从产物里消失。读数落 `research/step2-3-transform.json`*
- [x] **2.4** 复核 `report.resumed` / `report.totals.resumed` 的读法与既有断言一致（字段名不得再写错）
      —— *复核：`report.resumed(outPath)` 记名字、`totals.resumed` 计数；既有断言（改判据后）读法一致*
- [x] **2.5** 【**全量回归才暴露的陷阱，实测新增**】存在门**不得**用「writer 是否已含该名字」：
      该名单同时含「本轮已写入」与「搬运来的」，而**两个不同的源条目可能映射到同一个产物路径**
      （PT 目标下用户级 `extensions/<x>/**` 与第三方 `extensions/third-party/<x>/**` 同路径）⇒
      先在的那份会让后到的那份被误跳过（本该走「保留第三方副本」分支）。
      实做：存在门只认 `appendFrom` 回传的 `appendedNames`；**撤掉** `writer.has()`（混用入口）。
      守护：`test/convert.test.js` 的 PT 同名扩展用例（既有用例恰好覆盖）
      —— *实测：首版由此误跳过 2 个用户级扩展条目；`git stash` 单独还原 `transform.js` ⇒
      该用例 30/30 通过 ⇒ 确认是本改动引入的回归，非既有 flake。教训已记入 `research/step2-3-transform.json`
      与 `design.md` §2.1：**新判据落地后必须跑全量，不能只跑新用例文件***

## 3 `src/core/transform.js`：搬运、同源校验、`finalizeOnAbort`

- [x] **3.1** 新增 `options.appendFrom`：创建 writer 后、进入主循环前调 `writer.appendFrom(...)`
- [x] **3.2** 新增同源校验（`design.md` §2.4）：源中央目录 → 算 `outPath` → 与半成品清单求交 →
      三条判据全成立才搬运；不成立 ⇒ `onDiscardPartial()` + `logger.warn` + `appendFrom = null`
      —— *实做：判据落成两条（无孤儿 + crc 全等），第三条「布局一致」由「无孤儿」**天然涵盖**（见 2.1 注）。
      并加了第二层保险：半成品**读不出来**（坏包/截断）时先捕获、再作废；搬运途中失败则
      `abort()` 旧 writer 并**重建一个干净 writer**（否则残缺字节会混进产物）*
- [x] **3.3** 新增 `options.finalizeOnAbort`：`catch` 按错误类型分流
      （`AbortError && finalizeOnAbort` ⇒ `close()`；其余 ⇒ `abort()`）；
      `finalizeOnAbort` 下**跳过 `emitSynthesized`**（`design.md` §2.2 的理由）
      —— *实做：分流落地。**「跳过 `emitSynthesized` 是天然的**：`checkAbort()` 在循环内抛出、
      直接跳进 catch，尾部合成段根本没跑 —— 这正是要的，已在代码注释写明，免得后人「补上」它*
- [x] **3.4** 单测 `test/convert-append.test.js`：
      ① 半成品 + 清单 ⇒ 命中条目不重写、产物条目齐全、内容一致（AC-2）；
      ② 字节级免重压缩（AC-3，跨包比 `compressedSize`）；
      ③ **不同源**（同名 crc 不等 / 半成品含源中无的条目 / `target` 布局不同）⇒ 作废 + 完整重做（AC-4）；
      ④ 半成品损坏 ⇒ 捕获 → 作废 → 完整重做，**不抛到主路径**（AC-5）；
      ⑤ `finalizeOnAbort` ⇒ 中止时产出**合法 zip**（可被 `zipIo.openReader` 打开）；
         **非中止错误** ⇒ 仍 `abort()`，且**不留「看着完整」的产物**（AC-6）
      —— *实做 **10 项**。③ 拆成 4 条（crc 不等 / 孤儿 / 布局同路径可续 / 布局真错位），
      并新增 ⑥「普通对象台账 + 半成品 ⇒ resumed>0」作为归一化的**真**守护。
      「不同源」用例另补**直接验内容**的断言（产物该条目必须是**当前源**的字节）——
      只验名字集合的话，「混入陈旧条目」会整批漏过去*
- [x] **3.5** 判别力证明（AC-4）：去掉同源校验 ⇒ ③ 转红（产物混入陈旧条目）⇒ 恢复；读数入 `research/`
      —— *实测（最终门外语义下重做）：**3 项转红**；恢复后 17 passed。读数落 `research/step2-3-transform.json`*
- [x] **3.6** 判别力证明（AC-6）：把非中止错误也走 `close()` ⇒ ⑤ 转红 ⇒ 恢复
      —— *实测：**1 项转红**；恢复后 17 passed*

## 4 协作式暂停协议

- [x] **4.1** `converter-worker.js`：每条 `CONVERT` 自持 `AbortController` 并**真把 `signal` 传进 `convert()`**；
      收到 `PAUSE` ⇒ `controller.abort()`；`AbortError + finalizeOnAbort` ⇒ 关包 + 读半成品清单 +
      `postMessage({type:'PAUSED', id, partialBlob, manifest})`；非 `AbortError` 仍 `ERROR`
- [x] **4.2** `worker-client.js`：`onAbort` 改为协作式（`design.md` §2.5）——
      发 `PAUSE` → 有界等待 `PAUSED` → `finish(partial)`；
      **超时 `finish(null)`**；无论有无半成品都 `terminate()` 且 `workerInstance = null`
- [x] **4.3** `worker-client.js`：新增 `onPaused` 回调（**在 `reject` 之前 await**）；
      Node/主线程分支同形实现（`finalizeOnAbort` + `catch (AbortError)` + `await onPaused(...)`）
- [x] **4.4** 单测 `test/convert-pause-protocol.test.js`（用假 worker / 假执行体）：
      ① 收到 `PAUSED` ⇒ `onPaused` 被调、随后 reject `AbortError`；
      ② **超时** ⇒ `onPaused` 不被调、仍 reject `AbortError`、`workerInstance` 置空；
      ③ **超时后再转一次仍能出产物**（`L1-MR-8` 回归守护，`034b7ab` 同形）；
      ④ `onPaused` 自身抛错 ⇒ 不影响暂停语义（仍 reject `AbortError`，不静默挂起）
      —— *实做 **6 项**（另加 ⑤ 旧语义不发 PAUSE、⑥ DONE 正常路径不 terminate 自身）。
      ③ 的第二次改用旧语义：本用例只关心「是否新建 Worker」，用真计时器等 30s 兜底没有意义*
- [x] **4.5** 判别力证明：去掉超时兜底 ⇒ ② 转红（挂死/无中止）⇒ 恢复；读数入 `research/`
      —— *实测：去掉兜底 ⇒ ②③ **两项挂死超时转红**（正是「等不到半成品又不终止」的形态）；恢复后 6/6 绿*
- [x] **4.6** 复核**未引入**第二处 `terminate()` 之外的 worker 生命周期改动
      （`grep -n "terminate" src/core/worker-client.js`）
      —— *实测：`terminate()` 全仓仅 `worker-client.js` 一处（+其置空紧随其后）；worker 侧只观察、不终止*

## 5 `src/core/task-manager.js`：暂停态断点的**专用通道**

- [x] **5.1** 允许 PAUSED 态写断点，**注释写清理由**（`design.md` §3.1）
      —— ⚠️ **实做与计划不同（更强的方案）**：直接把 `onCheckpoint` 的 RUNNING 门打开会
      **重新引入既有测试在防的那个风险**——「暂停后到达的**尾事件**」会把真断点覆盖成陈旧台账
      （既有用例「onCheckpoint 在非 running 状态静默丢弃」锁的正是这条保护）。
      改为新增**专用通道** `setPauseCheckpoint(manifest)`：只在 PAUSED 生效、一次性、不被节流吞掉。
      两条保护同时成立：通用通道继续拒尾事件，真断点走专用通道。**计划的方案已被证据否决并替换**
- [x] **5.2** 单测：`pause` 之后真断点能落盘；`running / aborted / done / failed` 一律拒绝
      —— *实做 3 项（新增 describe）：① PAUSED 可写 ② 其余四态全拒 ③ **两条保护同时成立**
      （尾事件被丢弃 **且** 真断点能被 `resume` 读到）。既有保护用例保持绿*

## 6 `index.js`：半成品持久化与续传接线

- [x] **6.1** 暂停回调 `onPaused({partialBlob, manifest})` ⇒ 写 OPFS `fetch-tmp/<taskId>.partial.zip`
      （`opfsTmpHandle` + `createWritable`），登记 `opfsCleanupId/Name`
      —— *实做：抽成**可单测的导出函数** `persistPartial(...)`（依赖注入 OPFS 助手/配额探测）。
      文件名 `partialNameFor(taskId)` **不再加 `convert-` 前缀** —— taskId 本身就是 `convert-<ts>`，
      再加一层会拼出 `convert-convert-<ts>.partial.zip`（实测拼出来才发现）*
- [x] **6.2** 写断点清单（`design.md` §3 的形态）——含 `partialOpfsName` 与 `partialEntries`
      —— *实做：`setPauseCheckpoint({partialOpfsName, target, partialEntries, totalEntries})`；
      ⚠️ 顺序纪律：**先落 zip、再写断点**（反过来断点会指向不存在的半成品），已单测锁定*
- [x] **6.3** `onResume` 的 `convert` 分支：读清单 ⇒ `opfsHandleToFile` ⇒
      `options: { appendFrom, resumeCrcMap, finalizeOnAbort: true }`；半成品缺失 ⇒ 不带 `appendFrom`（完整重做）
      —— *实做：`appendFrom` 走 `opfsTmpHandle(name, false)` + `opfsHandleToFile`；
      读不到 ⇒ 一行 warn「本次完整重做整包（产物完整，只是不再增量）」。
      `doneEntries` 改为优先用**半成品清单**播种（产物字节的真源），旧格式 `doneEntries` 仍兼容读取*
- [x] **6.4** 成功 / 中止 / 作废三条出口均清 OPFS 半成品（复用既有 `opfsTmpCleanup`）
      —— *实做：新增局部 `releasePartial()`，在**两个**正常完成出口（分卷路径 + 常规路径）都调用；
      中止/丢弃走既有 `taskControls.onAbort/onDiscard` 钩子（已按 `opfsCleanupId` 清理）*
- [x] **6.5** **降级可观测（AC-10）**：OPFS 不可用 / 半成品读失败 / 收尾超时 /
      **收尾未产出半成品** ⇒ 日志一行「…⇒ 续传将重做整包（产物仍会完整）」，**不得静默**
      —— *实做：五条降级支路各有专属文案。这一条**不是走过场**：正是补上「未产出半成品」的日志
      才让 `targetWriter is not defined` 那个 scoping 缺陷**一次复跑就现形**（见 `research/step4-7-wiring-e2e.json`）*
- [x] **6.6** 【OQ-2】落盘前查 `navigator.storage.estimate()`：配额不足 ⇒ 走降级路径 + 日志
      —— *实做：`hasRoomForPartial(bytes, nav)`（留 10% 余量）。**拿不到 estimate 时放行**：
      因为量不出来就退化成「永不持久化」是**静默的能力退化**，比偶尔写到一半失败更糟*
- [x] **6.7** 单测：降级路径「无半成品 ⇒ 不带 appendFrom」的分支被覆盖
      —— *实做 `test/persist-partial.test.js` **4 项**：① 成功（写入内容 + 断点形态）② 顺序纪律
      ③ 五条降级支路（`no-partial`/`no-opfs`/`quota`/`handle`/`write-failed`）**各留一行可观测日志且绝不写断点**
      ④ 配额探测的边界（无 estimate / 抛错 / 配额 0 一律放行）*
- [x] **6.8** 回归自检：**未改** `plan-preview.js` / `delta.js` / `splitter.js` / `export-queue.js`
      （`git diff --stat` 逐文件核对）
      —— *实测 `git status --short`：改动面 = `index.js` / `src/core/{transform,zip-io,worker-client,converter-worker,task-manager,null-writer}.js`
      + 新增测试 4 个 + E2E spec 1 个。上述四个文件**零改动**（`null-writer.js` 曾加过 `has()`，
      因门改用 `appendedNames` 已**完整撤回**）*

## 7 E2E：翻转 `KNOWN-DEFECT`

- [x] **7.1** `e2e/standalone/specs/pause-resume.e2e.cjs` 的 `R12/R13`（`:124-156`）从
      「如实断言缺陷形态」翻转为**断言产物完整**；移除 `KNOWN-DEFECT` 措辞
      —— *实做：R12 断言「聊天条数与源包**相等**」；R13 断言「暂停窗口两侧的首尾聊天**都在**」
      （落到具体条目，而不只是计数）。缺陷史**保留为注释**（「既有测试为何没抓到」那一段最有价值）*
- [x] **7.2** **判别力证明（AC-9）**：注掉存在门 ⇒ R12/R13 转红 ⇒ 恢复 ⇒ 绿；读数入 `research/`
      —— *实测（忠实复刻旧管线的两条：门 + 不搬运半成品）⇒ **R12 转红「源=3000 产物=2826 跳过=175」**、
      **R13 转红「首=false」**；恢复后 21/21 全绿，两文件 diff 逐字节一致。
      ⚠️ 只注门**不会**转红（半成品仍在被搬运）⇒ 记录进 `research/`：**两半是联合必要的***
- [x] **7.3** `npm run e2e:web` 全量（`--rebuild`）**连续两轮**全绿
      —— *见 §9.3（本条与质量门合并复验）*
- [x] **7.4** 【OQ-1】放大夹具实测：GB 级半成品的 `appendZip` 耗时与内存形态；读数入 `research/`
      —— *实测：**3000 条 / 4.5 MB 夹具**下，续传「跳过 175 项」且整轮续传约 4–5 s（含搬运 + 续写 + 落盘）。
      搬运段是**字节级拷贝**（无重压缩），故耗时随产物体积线性、内存有界（zip-io 的 `waitForRoom` 背压仍在）。
      **未做 GB 级实机验证**（本机无 GB 级夹具，且 OQ-1 只要求实测形态）；已登记为残留*

## 8 R6b（余量允许时）：批量子项真增量 —— **未做，如实登记**

- [ ] **8.1** 批量子项的半成品按 `<taskId>-item<k>.partial.zip` 命名，与单包共用同一套机制
- [ ] **8.2** 续传时按 `itemIndex` 取对应半成品；缺失 ⇒ 该子项完整重做
- [ ] **8.3** 单测：子项内暂停 → 续传后**该子项产物完整**（AC-12）
- [x] **8.4** **未完成即如实登记**为残留（不得写成已达成）
      —— **本轮未做**。理由与现状：
      **正确性已达成**（R1 的存在门落地后，批量路径**不可能丢数据**：没有半成品 ⇒ 无 `appendedNames`
      ⇒ 一条都不跳过 ⇒ 该子项完整重做）；缺的只是**速度**（子项内暂停后该子项从头重跑）。
      留待后续独立任务，不写成已达成。

## 9 质量门

- [x] **9.1** `npm test` 全绿**零回退**（对比 §0.1 基线；满载 5s 超时抖动**不算回退**）
      —— *实测（`--maxWorkers=2`）：基线 **60 文件 / 581 passed / 2 skipped** → 现 **64 文件 / 610 passed / 2 skipped / 0 failed**
      ⇒ **零回退 + 净增 29 项守护**（zip-append 5 · convert-append 10 · convert-pause-protocol 6 ·
      persist-partial 4 · task-manager +3 · convert-resume 判据翻转 +1）*
- [x] **9.2** 五条静态守卫 `exit=0`；`npm run build` 通过
      —— *实测五条全 `EXIT=0`（css-scope / dom-injection / template-source / dom-scope / control-consumer）；
      `npm run build` 由 `npm run e2e:web -- --rebuild` 的构建段实测通过*
- [x] **9.3** `npm run e2e:web` 全量 exit 0（连续两轮）
      —— *实测**连续两轮**：轮 1（`--rebuild`）**337 断言 / 337 通过 / 0 失败** exit 0；
      轮 2（`--no-build`）**337 / 337 / 0** exit 0*

## 10 收口

- [x] **10.1** 规范落 `.trellis/spec/`（**自包含**、内联读数与 `file:line`）
      —— *实做：`frontend/state-management.md` **新增 §8「真增量续传：跳过 ≠ 丢数据」**
      （不变量 / 四段契约表 / 断点形态与专用通道 / 降级链与「catch 不得吞错」/ 怎么验）；
      并在既有条目上回填指针：§「OPFS 半成品生命周期」补转换侧同构、§「方向纪律」注明责任已由约定转移到判据。
      `frontend/resume-checkpoint-invariant.md` **状态从「已知未修」翻转为已修**，
      并新增 §4.2「计划被证据否决的三处」与 §4.3「全量回归逼出来的陷阱」；
      `guides/standalone-web-and-cloud-e2e.md` §4.6 由「🔴 已知缺陷」改写为「✅ 已修」+ 四段实现表 + 判别力读数
- [x] **10.2** 改写缺陷段与相关表述；**逐字复核** `task-manager.js:6` 的「半成品保留待续传」成立
      —— *实做：三处 spec + 项目 `CLAUDE.md` 坑 #6（原写「未修」）+ `README.md` 的「已知问题」段
      **全部改为已修**（否则规格与门面文档变假事实，`P-3` 同形）。
      `task-manager.js` 头部注释**逐字复核并写清**：该句对「宿主拉取」成立、对「转换」**2026-09-28 起成立**，
      并注明真断点为何走 `setPauseCheckpoint` 专用通道。另修两处**过期计数**（`CLAUDE.md:12` 与 `README.md:206`）*
- [x] **10.3** 索引更新（若新增 spec 文件）
      —— *无新增 spec 文件（§8 落在既有 `state-management.md`）；`frontend/index.md` 的
      `resume-checkpoint-invariant` 行状态由「**缺陷未修**」改为「✅ 已修」，并把索引里的过期测试计数
      （**46 文件 / 429 passed**）更正为 **64 文件 / 610 passed***
- [x] **10.4** 残留登记（逐条写出，不留"以后再说"）
      —— 见下方「残留」节
- [x] **10.5** `git status --short` 复核：无计划外文件；提交用**显式 pathspec**（`L0-7(2)`）
      —— *实测：暂存集合**恰为** 25 个文件（15 改 + 4 新测试 + 任务目录 6 件），
      与计划一致、无计划外文件；`test-results/` 探针脚本按 `.gitignore` 未入库*
- [x] **10.6** 提交并 `git push origin`
      —— *提交 `b26e8af`；首推遇 SSL 握手失败（环境层），重试成功：`0fac08d..b26e8af main -> main`，
      `main == origin/main`*

## 残留（本轮如实登记，不得写成已达成）

1. **R6b 批量真增量未做**（§8）—— 批量路径**正确性已达成**（不丢数据），只缺「子项内暂停后的提速」。
2. **OQ-1 GB 级半成品的实机读数未取**：只测到 3000 条 / 4.5 MB 夹具；搬运段是字节级拷贝 ⇒
   预期耗时随体积线性、内存有界（`waitForRoom` 背压仍在），但**未在 GB 级验证**。
   本机无 GB 级夹具，且 OQ-1 只要求实测形态；若要上 GB 级，先造夹具再读数。
3. **半成品跨会话续传的 UI 引导未打磨**：技术上已成立（OPFS 持久化 + 断点含 `partialOpfsName`），
   但「关掉页面再回来继续」时用户看不到任何提示（属文案，非功能）。
4. **既有残留（与本轮无关，未修）**：`test/real-samples.test.js` 满载 5s 超时抖动；
   项目 `CLAUDE.md` 记录的其余坑条目未逐一复核。
5. **`test-results/` 下的探针脚本**（`probe-appendzip*.mjs` / `probe-blobwriter-pause.mjs` /
   `probe-collision.mjs` / `transform.backup*.js` / `wc.backup.js` / `index.backup*.js`）——
   `test-results/` 已在 `.gitignore` 内，**不入库**；保留供复核。

## 回滚点

见 `design.md` §6。要点：**「存在即跳过」不得回滚**（回滚它 = 恢复静默数据损失）。
