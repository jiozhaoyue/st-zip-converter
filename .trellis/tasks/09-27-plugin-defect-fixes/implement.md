# 执行计划 · 插件已知缺陷修复

> 父任务 `09-27-instance-sync-and-plugin-hardening`；本子任务 `09-27-plugin-defect-fixes`。
> 设计见 `design.md`，需求与验收见 `prd.md`。
>
> **勾选纪律**（L0-2 / `L0-17`）：复选框**随执行实时勾选**，禁止任务结束后凭记忆批量补勾。

## 0 前置条件（开工前逐项确认）

- [x] **0.1** `python ./.trellis/scripts/task.py current` 指向本任务，且状态已 `in_progress`
      （**须先过 1.4 评审门**）—— *2026-09-27 已 start*
- [x] **0.2** 基线取证：`npm test` 与 `npm run e2e` 各跑一次，记录**开工基线**（文件数/通过数）
      —— *实测：`npm test` **48 passed / 1 skipped（49 文件）、460 passed / 2 skipped（462 用例）**、exit 0、10.42s；
      `npm run e2e` **断言 175 项 / 通过 175 / 失败 0**、exit 0*
- [x] **0.3** 五条静态守卫 `exit=0` —— *实测五条全 0：css-scope / dom-injection / template-source / dom-scope / control-consumer*
- [x] **0.4** **R-20 前置核对**：Dev 实例（`:8001` / `:8003`）插件版本 vs 工作区
      —— *开工实测（2026-09-27）：`b16b5ba..HEAD` 插件代码差异 = 0 ⇒ 已满足*。
      **若本任务产生了插件代码改动，跑 E2E 前必须重新核对并更新 Dev 实例。**
- [x] **0.5** 实例在监听：`:8001` / `:8003`（E2E 需要；`:8899` 本任务不用）
      —— *实测五个实例全在监听。**更正一处**：先前用 `http://` 探 `:8003` 得到空响应并误判「未运行」，
      实为 Luker 走 `https://`（登记表 `url: 'https://127.0.0.1:8003'`）。
      `start-instance` 因此以「不重复启动」提前退出 ⇒ **本次未启动任何实例，收尾也无需关闭***
- [x] **0.6** `.gitignore` 复核：确认本轮不会把 `test-results/` / `.pw-profile*` 带入库
      —— *实测覆盖：`test-results/`、`.pw-profile*/`、`.trellis/tasks/**/research/*.json`*
- [x] **0.7** **规格前置阅读**（`trellis-before-dev` 纪律）：按 `implement.jsonl` 清单读完相关 spec，
      特别是三处**会与本次改动直接互斥或互锁**的条文：
      ① `hook-guidelines.md:108`「无全局命名空间」的**登记义务**（R-19 的法律依据，见 §2 抬头）；
      ② `state-management.md:89`「长任务（宿主拉取 / **转换** / 写回）由 `TaskManager` 管理」
      （R-16 是**实现没追平规格**，不是规格缺条文）；
      ③ `state-management.md:107`「共享 Worker + AbortSignal 陷阱」（L1-MR-8 的原始教训）
      —— *另经本次复核新增两条互锁：`component-guidelines.md:362` 已把 `enqueue` 签名写进规格（§3.4.4b）；
      `state-management.md:113`「AbortSignal 不能 postMessage，须剥离」实测已在 `worker-client.js:128` 做掉*
- [x] **0.8** 建立 `research/` 目录（本任务全部读数落此处，**不入版本库**）

## 1 R-17 · `fixtures/gen.js` 入口守卫（先做：独立且最小）

- [x] **1.1** 只读排查（PRD OQ-3）：全仓检索 `gen-fixtures` 与 `fixtures/gen` 的引用，
      找出是否有用例**依赖了「CLI 不产出」这个错误前提**
      —— *结论：**零命中**。全部消费者走模块导入（`import { stEntries } from '../fixtures/gen.js'`，
      11 个测试文件）；`e2e/specs/matrix.e2e.cjs` 用动态 `import()` 直调 `generateAll()` 绕过 CLI；
      无任何地方把 `npm run gen-fixtures` 当前置步骤。读数见 `research/gen-fixtures-fix.json`*
- [x] **1.2** 通读 `fixtures/gen.js` 全文，确认除入口守卫外无第二处缺陷
      —— *确认为主缺陷；**另发现一处小缺口**：`generateAll(...).then()` 无 `.catch`
      ⇒ 失败时只抛未处理拒绝、无归因（静默空操作的反面同形）。已一并收口（见 §1.3）*
- [x] **1.3** 改入口守卫为 `pathToFileURL`（含 `process.argv[1]` 存在性守卫），
      按 `design.md` D2.1 —— **块级替换**（L0-4），不得整文件覆盖
      —— *实做：`node:url` 导入 + `isCliEntry` IIFE；额外加 **Windows 大小写不敏感回退**
      （`node FIXTURES/gen.js` 不应被误判为非 CLI）+ `.catch` 显式收口（`process.exitCode = 1`）*
- [x] **1.4** **实测修复**：`node fixtures/gen.js <临时目录>` → 有产物；
      记录**文件数/体积**入 `research/`
      —— *实测：退出码 0 且有 stdout 三行 `generated …`；产物 **3 个 / 合计 8815 字节**
      （st 2479 / l 2782 / tt 3554）。修复前为退出码 0、零输出、零产物。读数落 `research/gen-fixtures-fix.json`*
- [x] **1.5** 新增 `test/gen-fixtures-cli.test.js`，含 `design.md` D2.2 的**双向负例**
      （① 作为 CLI 直跑确实产出 ② 作为模块 import 零副作用）
      —— *实做 3 条：① CLI 直跑产出（**断言 stdout 有 generated 行**，不只查退出码）
      ② import 零副作用（**带查询串强制重新求值**绕开模块缓存，否则测的是缓存不是守卫）
      ③ 不给 outDir 时落到 `cwd/fixtures`（默认值契约）。3 passed*
- [x] **1.6** **判别力证明**：临时把守卫改回旧写法 → 「确实产出」转红 → 改回 → 全绿。
      **读数入 `research/`**（这是本仓纪律，不是可选项）
      —— *实测：旧写法下 ①③ **转红**（`expected '' to match /generated fixture-st\.zip/` —— stdout 为空，
      正是原缺陷的「零输出」形态），② 仍绿（该方向旧守卫也满足，因为它永不执行）
      ⇒ **两个方向各抓不同改坏方式**。恢复后 3 passed。读数落 `research/gen-fixtures-fix.json`*
- [x] **1.7** 若 1.1 命中「依赖错误前提」的用例 ⇒ **登记**（不顺手改测试语义），列入残留
      —— *1.1 零命中 ⇒ 无需登记*

## 2 R-19 · `restoreCapability` 只读调试出口

> ⚠️ **规格前提（开工前必读）**：`.trellis/spec/frontend/hook-guidelines.md:108`
> 有「**无全局命名空间（替代旧的 globalThis 调试钩子）**」一节，其收尾句为：
> 「若后续确需自动化钩子，应新增**显式命名**的接缝并在本节登记，**不要**恢复隐式全局对象。」
> ⇒ 本步**不是违规**，而是走规格**已预留**的那条路；但**「登记」是硬性义务**（见 2.6）。
> 同时该文件 `:130` 的 Forbidden 条目禁的是 `globalThis.__tavernConvert`（旧 IIFE 架构），
> 与本步新增的显式命名只读探针**不是同一物**，不得混为一谈。

- [x] **2.1** 在 `src/ui/host-bridge.js` 增 `getRestoreProbe()`（`Object.freeze` 快照），按 `design.md` D3.1
      —— *实做：`host-bridge.js` 的 `getRestoreUnsupportedReason()` 之后新增，每次返回**新的**冻结快照
      （不是共享可变引用）；文档注释里写清三条硬约束与登记义务*
- [x] **2.2** 在 `index.js` 挂 `window.__stZipConverterDebug`：
      **含占用检查**（已存在则**不覆盖** + `logger.warn`）；命名空间对象本身 `Object.freeze`
      —— *实做：新增 `mountDebugProbe()`，由 `bootstrap()` **最先**调用
      （理由：插件态工作台在抽屉里且抽屉默认关着，放进 `main()` 会让探针在抽屉未打开时不可用）。
      **额外导出该函数**，仅为让单测能覆盖「已占用」分支（生产路径仍由 `bootstrap()` 调）*
- [x] **2.3** 自检**不泄漏敏感项**：出口内**不得**含 CSRF token / handle / 文件路径
      —— 检索复核 + 人工确认（`design.md` D3.2 第 2 条）
      —— *实测：`restoreUnsupportedDetail` 的唯一赋值点是 `host-bridge.js:182`
      `attempted.join('、')`，元素形如 `/api/users/restore → 404`；
      **两项都是源码里的静态常量**（`RESTORE_ENDPOINT_CANDIDATES`）与整数状态码
      ⇒ 无 token / handle / 路径。单测 `②` 用正则 `\/api\/users\/restore.*404` 正证其形态*
- [x] **2.4** 单测（新文件 `test/restore-probe.test.js`）：
      ① 初始 `unknown` ② 探测后 `unsupported` 且 reason 非空
      ③ 返回对象**冻结** ④ 全局已占用时**不覆盖**且 warn
      —— *实做 **7 项**（在原 4 项外补 ③b 快照非共享、④c 无 window 环境静默跳过），**全绿**。
      三态迁移沿用 `test/restore-chain.test.js` 的成熟驱动法（`vi.resetModules()` + `endpointFetch` 替身）。
      实测日志确认原因文案为「已探测：/api/users/restore → 404、/api/users/restore-backup → 404」*
- [ ] **2.5** **判别力证明**：把 `index.js` 的挂载去掉 → E2E 的 M-8 新断言转红 → 恢复 → 绿
      （**与 §3.3.5 的 E2E 改动一并做**）
- [x] **2.6** ⚠️ **规格登记义务**（`hook-guidelines.md:121` 明文要求，**不可省**）：
      在 `.trellis/spec/frontend/hook-guidelines.md` 的「无全局命名空间」一节内，
      登记本接缝的**显式命名 / 挂载时机 / 只读契约束**，并把该节标题与正文从
      「**当前不存在任何挂到 `globalThis` 的自有命名空间**」更正为「存在 **1 个**显式登记的只读探针」
      —— 原文若不同步更正，规格就变成**假事实**（P-3 同形）
      —— *实做：该节重写为「**全局命名空间：默认禁止，只许「显式登记」的只读接缝**」，
      含 8 行登记表（显式命名 / 挂载点 / 成员 / 只读契约 / 不覆盖 / 不泄漏 / 无 window 环境 / 测试）
      + **5 条新增接缝的规矩**，并把「当前不存在任何…」的旧断言原文留在第 5 条里作反例说明*
- [x] **2.7** 复核 `state-management.md` / `host-capabilities.md` 中是否有与该出口矛盾的表述，
      有则一并更正（**不得**只改一处留下互相打脸的规格）
      —— *检索 `无全局命名空间` / `__tavernConvert` / `globalThis` 命中**两处矛盾**并已更正：
      ① `component-guidelines.md:12`「`globalThis` 上**不挂任何自定义符号**」⇒
      改为「不留**隐式**全局命名空间」，并点明唯一例外是本探针；
      ② `frontend/index.md:24` 的索引描述「无全局命名空间」⇒ 改为「全局命名空间（仅 1 个已登记的只读探针）」。
      `host-capabilities.md` 无矛盾表述（其 `globalThis.SillyTavern` 云云是**读**宿主信号，非挂自有符号）*

## 3 R-16 · 转换路径接入断点续传（主体）

> **规格前提**：`.trellis/spec/frontend/state-management.md:89-93` 已明文写着
> 「长任务（宿主拉取 / **转换** / 写回）由 `src/core/task-manager.js` 管理」。
> ⇒ R-16 **不是**规格缺条文，而是**实现没追平规格**。本节的产出是让那句话**变成真的**，
> 因此该处规格文字**无需修改**，但收口时要**逐字复核它现在成立**（`implement.md` §5.1）。

### 3.1 分派骨架（先立判据，再接执行体）

- [x] **3.1.1** 在 `index.js` 增 `TASK_KINDS` / `TASK_PREFIX` / `taskKindOf(id)`
      （**唯一判据**，按 `design.md` D1.1；**不进 `src/core/`**）。
      ⚠️ `TASK_KINDS` 含**四个**类型：`fetch` / `convert` / **`convert-batch`** / `restore`
      —— *实做：模块作用域，三者均 `export`（测试与分派表都要用）*
- [x] **3.1.1b** ⚠️ `taskKindOf` **必须按前缀长度降序匹配**（`design.md` D1.1）：
      `convert-batch-` 与 `convert-` **前缀重叠**，按声明顺序遍历会让
      `convert-batch-<ts>` 被 `convert-` 先吃掉 ⇒ **静默降级成单包语义**（断点字段读不到）。
      **不许依赖对象字面量的插入顺序**（有人重排常量时会无声失效）⇒ 实现里显式 `sort`
      —— *实做：`Object.entries(TASK_PREFIX).sort((a,b) => b[1].length - a[1].length)`；
      另加 `typeof id !== 'string'` 早返，避免非字符串传入时抛*
- [x] **3.1.2** 全仓检索 `startsWith('fetch-')` 等前缀硬编码，**全部**改走 `taskKindOf`
      （防「同一判据两处实现」——`code-reuse-thinking-guide` 的重复 3+ 次规则）
      —— *实做：全仓唯一一处硬编码（原 `onResume` 的 `id.startsWith('fetch-')`）已消除，
      改为 `RESUMABLE_HANDLERS[taskKindOf(id)]` 查表；复核无残留*
- [x] **3.1.3** 新增 `test/task-kind.test.js`：四前缀各自解析正确、未知 id 返回 `null`、
      **前缀重叠负例**（`fetch-` 不得吃下 `convert-`；**`convert-batch-<ts>` 必须返回 `convert-batch`
      而不得被 `convert-` 吃掉**）
      —— *实做 6 项。含一条**性质断言**：把前缀表按**升序**喂进去会选错（`convert`）——
      这就是必须 `sort` 的原因；以及「类型表与前缀表一一对应」「前缀须以 `-` 收尾」两条防漏配*
- [x] **3.1.4** `onResume` 改为**查表分派**（`design.md` D1.1 的 `RESUMABLE_HANDLERS`），
      查不到时 `logger.warn` 而**非静默**
      —— *实做：`RESUMABLE_HANDLERS` 用箭头函数惰性解引用（避免"表在函数声明之前求值"的时序依赖）；
      warn 里带上识别出的类型（`kind ?? 'null'`）便于归因*

### 3.2 `btnConvert` 接线

- [x] **3.2.1** 在 `btnConvert` 内、`runConversionTask` 调用**之前**建任务：
      `taskManager.start(taskId, '转换', { resumable: true, totalBytes: currentFile.size })`
      + `taskControls.showRunning(taskId, …)`
      —— *实做：开工前把内联箭头提为**具名函数 `handleExternalConvert({resumeCheckpoint, resumeTaskId})`**
      （分派表要按类型分派到它，与 `handleHostExport` 同形；函数声明提升，故可被定义之前的 `onResume` 引用）。
      `start` 放在 `try` **之外**（与宿主拉取路径同形：`start` 自身可能因"同 id 已在运行"抛错）*
- [x] **3.2.2** 把 `signal` 与 `resumeCrcMap` 传进 `runConversionTask` 的 `options`
- [x] **3.2.3** **自行累积** `doneEntries`（`design.md` D0.2 的原因：Worker abort 时
      返回值的 `doneEntries` 会丢）—— 在**自己的** `onProgress` 里 `Map.set`
- [x] **3.2.4** ⚠️ **落盘必须挂在 `onProgress` 上，不得只挂 `onEntryDone`**
      （`design.md` D0.2b：`onEntryDone` 是 `runConversionTask` 的顶层参数，
      **只在主线程降级分支被调用**；Worker 路径经 `postMessage`，函数**过不了结构化克隆**
      ⇒ 浏览器里**永不触发** ⇒ 断点永不落盘 ⇒ 续传仍然不可达，而 `npm test` 全绿。
      `worker-client.js:89` 的 JSDoc 已明写「Worker 路径由 onProgress 累积」）
      —— *实做：抽出**单一入口** `attachConversionProgress({doneEntries, maybeCheckpoint})`，
      单包与批量共用（两处各写一份必然漂移）；其单测**只按 Worker 路径的签名调用**
      （只有 `onProgress`）并断言断点仍被喂到*
      - [x] **3.2.4.1** 实现 `maybeCheckpoint(force)`：节流常数**取自**
            `src/core/task-manager.js:23-25`（`CHECKPOINT_EVERY_ENTRIES = 64` /
            `CHECKPOINT_EVERY_MS = 2000`），**不另立一套数字**
            —— *实做：`createCheckpointThrottle`，常数显式同源并注释标注*
      - [x] **3.2.4.2** **未到窗口时不 materialize** —— `Object.fromEntries(doneEntries)` 是 O(n)，
            每 tick 都建 = **O(n²) + 大量短命对象**（8683 条目 ⇒ 约 7500 万次属性分配），
            会制造 GC 压力与长任务（L1-MR-9 的相邻风险）
            —— *实做：未到窗口**连 `onCheckpoint` 都不调**。单测锁定「63 个条目只落盘 1 次而非 63 次」*
      - [x] **3.2.4.3** 末条（`current === total`）**强制**落一次 ⇒ 小任务也有断点
            —— *实做：`force: total > 0 && cur === total`；批量另在**每个子项边界**强制落一次*
      - [x] **3.2.4.4** **回调内零渲染**（L1-MR-9）：只做 `Map.set` + 节流判定，不碰 DOM
      - [x] **3.2.4.5** ⚠️ **方向断言**：断点内容必须**只含已完成条目**；
            滞后 ≤63 条 ⇒ 续传时被**重做**（安全）；**超前则会被错误跳过 ⇒ 产物缺条目**。
            **任何让断点「超前」的写法都是缺陷**
            —— *实做：单测断言两次落盘的清单分别为 `{a:1}` 与 `{a:1,b:2}`（严格 ⊆ 已完成）*
      - [x] **3.2.4.6**（新增）⚠️ **首次调用即落盘是载荷属性** —— `lastFlushAt` 初值 0 使时间条件
            立刻成立。**不是 bug**：`TaskManager.pause()` 落盘的是**内存里的 `task.checkpoint`**，
            它只在 `onCheckpoint` **被调用时**才更新 ⇒ 若首次被节流掉，「刚开始就暂停」会因
            `checkpoint === null` 而无法续传。已写成显式单测 + 代码注释，防止后人当 bug"修掉"
- [x] **3.2.4b** `onEntryDone` 可保留作**主线程路径的冗余触发**（走同一个 `maybeCheckpoint` 去重），
      但**不得**作为落盘的唯一入口
      —— ***决策：干脆完全不用 `onEntryDone`**（单入口更简单，也排除了"将来有人只改这一处"的空间）。
      批量路径同理。落盘唯一入口 = `onProgress` → `attachConversionProgress`*
- [x] **3.2.5** 收尾语义四分支，按 `design.md` D1.2 的表逐条落实：
      成功→`complete` / 暂停→**`AbortError` 静默**（**绝不** `fail`）/ 中止→`abort` /
      真失败→`fail(taskId, true)`
      —— *实做：抽成纯函数 `convertExitForAbort({err, record})` → `'fail'|'paused'|'aborted'|'none'`，
      单包与批量的两个 catch 都经它。**为什么要抽**：内联在 `main()` 的 catch 里时这段逻辑
      单测够不着（`main()` 需要 DOM），抽出来才让「暂停绝不走 fail」成为可断言契约*
- [x] **3.2.5b** ⚠️ **「静默」的正确含义**（`design.md` D1.2 末尾）：
      静默 = **不调 `fail()`、不 `logger.error`、不显示「失败」**；
      **不是**「什么都不做」—— 必须**显示暂停态**。
      **逐行对照 `index.js:1227-1243`**（宿主拉取路径的 catch 块，是同一张表的现成实现）：
      `AbortError` → 判 `rec.state`：`PAUSED` ⇒ `taskControls.showPaused(...)` +
      `setPausedCheckpoint(...)`；`ABORTED` ⇒ `taskControls.hide()`。
      **两条路径的暂停/中止语义必须逐字节同构**
      —— *实做：暂停分支调 `showPaused` + `setPausedCheckpoint` + `view.setProgress` + `logger.info`；
      中止分支 `taskControls.hide()`。单包与批量两份 catch 结构一致*
- [x] **3.2.6** ⚠️ **最容易写错处**：确认暂停路径**不调** `fail()` ——
      `fail` 会 `adapter.remove(id)` 清掉刚落盘的断点
      —— *实做：`fail` 只在 `action === 'fail'` 分支；判别力证明已验（去掉特判 ⇒ 3 项转红）*
- [x] **3.2.7** 复核**未引入第二处 `worker.terminate()`**（L1-MR-8：
      `worker-client.js:140` 已置空引用，续传只许经 `signal`）
      —— *实做：`grep -n "terminate" index.js` ⇒ **零命中**；续传只经 `signal`*

### 3.3 R-16 的测试

- [x] **3.3.1** 单测：状态机续传契约（`resume` 仅在 `paused && resumable` 返回清单；
      `abort` 后返回 `null`）—— 扩写既有 `test/task-manager.test.js`
      —— ***无需新增**：既有 `test/task-manager.test.js` **已覆盖**（`:36` pause→resume 拿到清单、
      `:61` abort 后 `resume` 返回 `null`、`:59` 状态迁移）。契约未被本次改动触碰（`src/core/**` 零改动）*
- [x] **3.3.2** 单测：断点命中跳过 ⇒ `report.resumedCount > 0` 且产物条目数不变（`transform` 层）
      —— ***无需新增**：既有 `test/convert-resume.test.js:41` 已断言
      「crc 命中清单的条目跳过且 `report.resumedCount > 0`；未命中条目正常写出」，
      `:129` 还覆盖了 `resumeCrcMap` 的**普通对象**形态（worker postMessage 序列化后的形态）*
- [x] **3.3.2b** ⚠️ **单测：「Worker 路径回调契约」**（`design.md` D0.2b / D1.5 的守护行）——
      注入**只调 `onProgress`、从不调 `onEntryDone`** 的**假执行体**（模拟 Worker 路径的契约），
      断言 `onCheckpoint` **仍被调用**。
      **判别力证明**：把落盘改回只挂 `onEntryDone` ⇒ 本用例**转红** ⇒ 恢复。
      **读数入 `research/`**（本仓纪律）
      —— *实做：`test/convert-resume-wiring.test.js` 的「Worker 路径回调契约」describe（3 项）。
      **判别力已实测**：去掉 `maybeCheckpoint` 调用 ⇒ 2 项转红（读数落 `research/r16-resume-and-batch.json`）*
- [x] **3.3.2c** 单测：**节流与「不超前」方向断言** ——
      ① 累积 ≤63 条时不 materialize（`onCheckpoint` 调用次数 < 条目数）；
      ② 末条 `current === total` 强制落一次；
      ③ **断点内容 ⊆ 已完成条目**（方向断言 —— 超前即缺陷）
      —— *实做 5 项。① 落地为「63 个条目只落盘 **1** 次而非 63 次」；
      ② ③ 见「方向纪律」「force 绕过节流」「时间窗口到期」；
      另加一条「无 crc32 的进度回调不得污染清单」*
- [x] **3.3.3** 单测：**`AbortError` 静默守护** —— 执行体 reject `AbortError` ⇒
      **不调 `fail()`、断点仍在、且调了 `showPaused`**
      （「静默」≠「什么都不做」，见 `implement.md` §3.2.5b）
      —— *实做：抽成纯函数 `convertExitForAbort` 后新增 5 项（`test/convert-resume-wiring.test.js`）。
      核心那条断言 `action === 'paused'` **且 `!== 'fail'`**；
      另覆盖「name 相似但不是 `AbortError`（如 `'Aborted'`）⇒ fail，不得靠字符串匹配蒙混」*
- [x] **3.3.4** **判别力证明**：把 3.3.3 的 `fail()` 改回去 → 转红 → 恢复 → 绿；读数入 `research/`
      —— *实测：去掉 `AbortError` 特判 ⇒ **3 项转红**；恢复后全绿。读数入 `research/r16-resume-and-batch.json`*
- [ ] **3.3.5** E2E：矩阵 M-7 从「控制条初态隐藏」升级为**真实 pause → resume 续传**，
      断言 `resumedCount > 0` 可观测、控制条状态机 `running→paused→running`
- [ ] **3.3.6** E2E 连续**两轮**全绿（可重跑性；沿用 spec §11.2 的清初态纪律：
      动 `workspace` store 的 `active_session` 后**重载页面**，**不删 `files` store**）

## 3.4 批量转换接续传（U-5 授权的范围扩张；`design.md` D1.3）

> ⚠️ **行号**：`runBatchConversion` 在 **`index.js:393`**
> （上一版 `design.md` 误记为 `:1129`，那是宿主拉取路径的转换段 —— 已更正，别照旧行号读）。

- [x] **3.4.1** 任务形态 = **一个任务 + 子项游标**，id `convert-batch-${Date.now()}`
      （**不用**「每子项一个任务」：`taskControls` 一次只展示一个活动任务，N 个控制条会让用户心智断裂）
- [x] **3.4.2** 断点清单按 `design.md` D1.3 的形态：
      `{ kind:'batch', itemIndex, outputs:[{index,name}], doneEntries, totalItems }`
      —— `itemIndex` 语义是「**下一个待处理**子项下标」，**不是已完成个数**（避免 off-by-one 歧义）
      —— *实做**增补一个字段**：`itemIds`（源包在 files store 的记录 id）。
      理由：续传要能重新取回源包，而**源包是入库的、产物才是内存的** ⇒ 记 id 即可跨列表刷新取回。
      这是对计划形态的**加性修正**，已同步进 `design.md` D1.3 的清单形态说明*
- [x] **3.4.3** ⚠️ **`doneEntries` 每个子项必须重置**：只在 `itemIndex` 相同时才把
      断点清单喂给该子项 —— 不同源包含**同名条目**时，跨子项复用 crc 清单会**错误跳过** ⇒ 产物缺条目
      —— *实做：抽成纯函数 `seedEntriesFor({checkpoint, index, startIndex})`，
      `index !== startIndex` 一律返回空 Map；单测覆盖「游标不命中 ⇒ 空清单」与「返回新 Map，不共享引用」*
- [x] **3.4.4** `src/ui/export-queue.js` 的 `enqueue` 增一个**可选**字段 `taskId = null`
      （**加性改动**；`this.items` 的既有消费者只读已知字段）—— 本任务对 `src/**` 的**唯一**改动
      - [x] **3.4.4b** ⚠️ **同步规格**：`.trellis/spec/frontend/component-guidelines.md:362`
            已把 `enqueue({ blob, name, targetLayout, origin, ephemeral, autoDownload })` 的
            **签名写进规格** ⇒ 加了字段就**必须同处更新**，否则规格变成假事实（`P-3` 同形）
            —— *已同步：该行签名补 `taskId`，并新增两条说明（字段用途 = 批量续传失效检测；
            以及「Queue 是**纯内存**的 ⇒ 任何『断点持久化 + 依赖内存产物』的组合都必须显式处理这个落差』）*
- [x] **3.4.5** ⚠️ **可验证前提（U-6 / 跨重载失效检测）**：续传前核对
      `exportQueue.items.filter(it => it.taskId === taskId).length === checkpoint.outputs.length`；
      不等 ⇒ **断点作废**（`taskManager.abort(taskId)` + 清）+ `logger.warn` +
      明确提示「产物已不在内存（页面可能已重载），无法续传，将重跑整批」⇒ **`return`，不得硬续**
      —— 用「产物还在不在」这个**真实依赖**作判据，而非「会话是否同一个」这个**代理量**
      （代理量在「同会话但用户手动删了产物」时误判为可续）
      —— *实做：抽成纯函数 `batchResumeVerdict({expectedOutputs, productsPresent})`。
      **两处比计划更强的处理**：① 判据不成立时不是简单 `return`，而是
      **作废后从零重跑整批**（与告警文案「将重跑整批」一致，用户不会点了继续却什么都不发生）；
      ② `taskManager.abort(taskId)` 对**已随页面重载消失**的任务记录返回 `false` ⇒ 此时
      直接 `authorityCheckpointAdapter.remove(taskId)` 清持久化断点，不留孤儿条目*
- [x] **3.4.6** ⚠️ **循环内 `AbortError` 必须 `break`**：现状 `index.js:447-449` 的
      `catch (err) { logger.error(...) }` 会**吞掉** `AbortError` 并继续跑下一个包
      ⇒ 用户看到「已暂停」但**还在往下跑**，且游标与实际进度脱节。
      修法：`catch` 里先判 `err?.name === 'AbortError'` ⇒ `break`；**其余错误沿用现状**（记日志、继续）
      —— *实做：机制上改为**原样上抛**（`runBatchItems` 返回 `{aborted:true, error}`，
      调用方 `throw run.error` 交给统一 catch）。可观测结果与 `break` **等价**（第 k+1 个子项不得被处理），
      且能让中止信号走**同一套**状态迁移（与单包逐字节同构）。单测断言的正是该可观测结果*
- [x] **3.4.7** 每完成一个子项**强制**落一次断点（`force`）—— 子项边界是天然断点，
      比 64 条节流更对齐语义；子项内仍按 `maybeCheckpoint` 节流
      —— *实做：`maybeCheckpoint({ force: true, totalEntries: doneEntries.size })` 在每个子项成功出口*
- [x] **3.4.8** 收尾四出口与单包**逐字节同构**（含 `AbortError` 的「静默但显示暂停态」）
      —— *实做：两条 catch 都经 `convertExitForAbort`，分支结构一致；批量暂停文案带子项进度
      （「已暂停于第 k/N 个包」）*
- [x] **3.4.9** `workbenchBusy` **暂停时也必须释放**（否则暂停后工作台一直卡在 busy）
      —— *实做：`workbenchBusy = false` 在 `finally`，而 pause 路径不 rethrow ⇒ finally 必然执行。
      另：批量把 `await updateWorkspaceUI()` 也放进 `finally`（原实现只在成功路径调用，
      暂停/失败后工作区列表不刷新）*
- [x] **3.4.10** 单子项失败的**既有语义不变**（记日志、继续）；任务级 `fail` 只留给结构性错误
      （`fail` 会清断点，与「后续子项还要继续」矛盾）
      —— *实做：`runBatchItems` 的 `onItemError` 记日志后继续；`fail` 只在
      `convertExitForAbort` 返回 `'fail'` 时（即非中止错误且整批外层抛出）*

### 3.4 的测试

- [x] **3.4.11** 单测：子项游标续传 —— 断点 `itemIndex = k` ⇒ 恢复时**跳过前 k 个子项**、从第 k 个开始
      —— *`test/batch-convert.test.js`：「从 startIndex 开始：已完成的子项不重跑」
      （断言 `convertItem` 只被以 `[c,2] [d,3]` 调用）+「startIndex 起点即末尾 ⇒ 幂等空跑」*
- [x] **3.4.12** 单测：**跨重载失效检测** —— 队列中该 `taskId` 的产物数 ≠ `outputs.length`
      ⇒ 断点**作废**、**不得**硬续。
      **判别力证明**：去掉判据 ⇒ 用例转红 ⇒ 恢复（读数入 `research/`）
      —— *3 项（相符可续 / 不符作废且原因带两个数字 / 产物清空作废）。
      **判别力已实测**：令 `batchResumeVerdict` 恒返回 valid ⇒ **2 项转红**；恢复后全绿*
- [x] **3.4.13** 单测：**循环内 `AbortError` 必须 break** —— 第 k 个子项 reject `AbortError`
      ⇒ 断言执行体被调用次数 == `k + 1`（**第 k+1 个不得被处理**）。
      **判别力证明**：去掉 `break` ⇒ 用例转红
      —— *实做断言 `calls === [0,1,2]`（第 3 个抛错 ⇒ 第 4、5 个不得被调用）+
      `aborted === true` + `processed === 2`。**判别力已实测**：去掉 AbortError 分支 ⇒ **1 项转红***
- [x] **3.4.14** 单测：**跨子项同名条目不得被误跳过**（两个子项含同名条目 ⇒ 第二个子项不得少条目）
      —— *落地为 `seedEntriesFor` 的「游标不命中 ⇒ 空清单」+「返回新 Map」两组断言；
      夹具用**真实会重名的**条目名（`settings.json` / `a.png`）*
- [ ] **3.4.15** E2E：多包批量 → 中途 pause → resume ⇒ 已完成子项**不重跑**、产物齐、
      `resumedCount` 可观测。**若该项在现有 harness 下无法稳定驱动，必须如实报告并登记，
      不得静默略过**（这是 U-5 的验收面）

## 4 质量门（收口前必须全绿）

- [ ] **4.1** `npm test` 全绿**零回退**（对比 0.2 的基线）
- [ ] **4.2** 五条静态守卫 `exit=0`；`npm run build` 通过
- [ ] **4.3** `npm run e2e` **exit 0**，且**连续两轮全绿**
- [ ] **4.4** **R-20 复核**：若本任务改了插件代码 ⇒ 更新 Dev 实例后再跑 4.3，并记录实例版本
- [ ] **4.5** `git status --short` 复核：无计划外文件；`test-results/` 未入库
- [ ] **4.6** 逐条勾选本文件的**全部**复选框（**实时勾选**，不得事后补）

## 5 规范落库与收口

- [ ] **5.1** 规范落 `.trellis/spec/`（**自包含**，内联读数与 `file:line`）：
      - 续传的三出口语义（成功/暂停/中止）与「`AbortError` 必须静默」的**理由**
        —— 注意「静默」= 不 `fail` / 不报错，但**必须显示暂停态**（§3.2.5b）
      - ⚠️ **`onProgress` 是 Worker 与主线程两条路径上唯一都活的回调**
        —— `onEntryDone` 在 Worker 路径**永不触发**（`design.md` D0.2b）。
        这是**新发现的缺陷类**：**测试跑主线程路径 ⇒ 缺陷被单测掩盖** ⇒
        守护必须同时有「假执行体单测」与「真浏览器 E2E」两条，缺一不可
      - **断点滞后可以、超前不行**的方向纪律（滞后 ⇒ 重做；超前 ⇒ 产物缺条目）
      - `taskKindOf` 单一判据纪律 —— 含**前缀重叠必须按长度降序匹配**
        （`convert-batch-` vs `convert-`；不依赖对象插入顺序）
      - **批量续传的两条前提**：① 断点持子项游标、`doneEntries` 每子项重置；
        ② **续传前必须验「产物还在」**（用真实依赖作判据，不用会话令牌这类代理量），
        不成立即作废断点而非硬续
      - 「静默空操作」类缺陷的**双向负例**测试范式（R-17 的教训）
      - 只读调试出口的三条约束（只读 / 不泄漏 / 防命名冲突）**及其登记义务**
        （`hook-guidelines.md:121`；登记动作见 §2.6，本处只确认已落）
- [ ] **5.1b** **逐字复核 `state-management.md:89-93`**：该处「长任务（宿主拉取 / 转换 / 写回）
      由 `TaskManager` 管理」这句在本次修复后**是否真的成立** —— 单包与批量都已接线 ⇒
      该句成立；若仍有未接线路径（如写回），**必须在句内点明**，否则规格重新变成假事实
- [ ] **5.2** 更新对应 spec 索引（若新增文件）
- [ ] **5.3** 残留登记：R-10 满载超时、§1.1 命中的任何项、§3.4.15 E2E 若无法稳定驱动的登记
      （**批量未接续传已不在残留之列** —— U-5 已把它纳入本任务范围）
- [ ] **5.4** 提交（**显式 pathspec**，L0-7(2)）：`npm test` 绿后提交并 `git push origin`
- [ ] **5.5** 在父任务 `prd.md` 的 AC-P1 上回填读数

## 回滚点

| 点 | 回滚动作 |
| --- | --- |
| R-17 改坏 | `git checkout -- fixtures/gen.js` + 删除新测试文件 |
| R-19 挂载冲突 | 删除 `index.js` 的挂载块 + `host-bridge.js` 的 `getRestoreProbe` |
| R-16 单包接线变慢/出错 | 移除 `btnConvert` 内的任务块与两个新传参 ⇒ 回到「不接线」；**`src/core/**` 未动，故回滚面 = 1 文件** |
| R-16 **批量**接线出错 | 移除 `runBatchConversion` 内的任务块、游标与失效检测 ⇒ 回到「单次循环」；`export-queue.js` 的 `taskId` 字段是**加性**的，留着无害（也可一并删） |
| **批量续传的失效检测**出错 | ⚠️ **不能靠回滚解决**：去掉它 = 页面重载后**静默产出残缺批次**。故该判据**只有前置拦截、没有回滚**——出错必须当场修，不许降级绕过 |
| 全部 | 本任务改动面 = 4 个源文件（`index.js` / `src/ui/host-bridge.js` / `src/ui/export-queue.js` 加性字段 / `fixtures/gen.js`）+ 5–6 个测试文件；`git revert` 一次提交即可 |