# 插件已知缺陷修复

> 父任务：`09-27-instance-sync-and-plugin-hardening`。本文件是**工作副本**，规范条文最终落 `.trellis/spec/`。

## Goal

修复上一轮取证确凿、但当轮按 Out of Scope **只登记未修**的三个插件缺陷：

| 编号 | 缺陷 | 性质 |
| --- | --- | --- |
| **R-16** | 转换路径**无任务状态机** ⇒ 设计文档承诺的 pause/resume/断点续传**在产品里不可达** | **能力缺口**（实现缺失，非崩溃） |
| **R-17** | `npm run gen-fixtures` **从未生效**（入口守卫 URL 拼接缺陷 ⇒ 静默空操作） | **工具链静默失效** |
| **R-19** | `restoreCapability` 三态**不可直接观测** ⇒ E2E 无法断言 | **可观测性缺口** |

## 现场取证（2026-09-27，本仓 `99d0621`）

### R-17：入口守卫 URL 拼接（**已复现**）

`fixtures/gen.js:144`：

```js
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
```

- `import.meta.url` 在 Windows 上是 `file:///D:/Repo/.../fixtures/gen.js` —— **三个斜杠**；
  模板拼出的是 `file://D:/Repo/...` —— **两个斜杠** ⇒ **永不相等**。
- **实测**：`node fixtures/gen.js /tmp/genfix-probe` → **退出码 0、零行输出、零产物**
  （`ls` 无任何文件）。即 `npm run gen-fixtures` 自存在起**从未产出过夹具**。
- 上一轮的矩阵 spec 因此绕过该 CLI，用动态 `import()` 直调 `generateAll()`。

**正确修法**（不引入依赖，符合 L1-MR-11）：用 `pathToFileURL`（`node:url` 内置）——
`import { pathToFileURL } from 'node:url';` 后
`if (import.meta.url === pathToFileURL(process.argv[1]).href)`。
**必须有负例守护**：新增单测/自检，证明「不带参数直跑会真的产生产物」，
以及「作为模块被 import 时不产生副作用」（守卫的**双向**判别力）。

### R-16：转换路径无任务状态机（**已取证**）

`TaskManager` 全仓**只有一处** `start`：

| 位置 | 上下文 | 结论 |
| --- | --- | --- |
| `index.js:962` | `taskManager.start(taskId, '宿主拉取', …)`，位于 `handleHostExport`（`index.js:938`） | **只有宿主拉取路径**接了状态机 |
| `index.js:1543` `btnConvert.addEventListener('click', …)` | 转换路径 | **完全不碰 `taskManager`** |

`onResume`（`index.js:515`）的实现是：

```js
onResume: (id, checkpoint) => {
  if (id.startsWith('fetch-')) handleHostExport({ resumeCheckpoint: checkpoint, resumeTaskId: id });
},
```

⇒ **只有 `fetch-` 前缀的任务能续传**。`taskControls.showRunning` 亦仅此一处调用（`index.js:966`）。

**与文档的冲突**：README 特性 2（增量导出与一键恢复）与特性 6（Authority 增强）均把
「断点续传」列为能力；上一轮设计文档 §3.4 亦如此描述。**实际只有宿主拉取路径具备。**

**两种处置方向（须用户裁决，见 OQ-1）**：

- **(a) 补实现**：把 `TaskManager` 接入转换路径（`btnConvert` / `runBatchConversion`），
  使转换支持 pause/resume/断点续传。工作量：新接缝 + UI 控制条接线 + 单测 + E2E（M-7 从「不可达」变为「可达」）。
- **(b) 收窄文档**：承认转换路径不支持续传，把 README / spec 的表述限定为「宿主拉取路径」。
  代价小，但用户看到的能力比预期少。

### R-19：`restoreCapability` 不可观测（**已取证**）

`src/ui/host-bridge.js:85` 是模块级 `let restoreCapability = 'unknown';`，
出口只有 `getRestoreCapability()` / `isRestoreUnsupported()` / `getRestoreUnsupportedReason()`（`:91`/`:96`/`:101`），
**没有任何 `window` 暴露** ⇒ Playwright 无法读取。

上一轮的变通：矩阵只能验**非破坏性**的可见性契约（并用「分卷后 `lastConvertedBlob` 置 null ⇒ 入口重新隐藏」双向互证）。
**未主动点恢复按钮**的原因已登记：`postRestoreWithFallback` 会对实例发真实 POST，风险不对等。

**修法（须用户裁决范围，见 OQ-2）**：把三态与探测明细挂到一个**明确的调试出口**
（如 `window.__stZipConverterDebug = { getRestoreCapability, getRestoreUnsupportedReason }`），
使 E2E 可断言。**注意**：这是**只读探针**，不得成为新的攻击面；
命名与挂载时机须与既有宿主适配纪律一致（`host-bridge` 是平台差异唯一落点，见 L0-9）。

## Requirements

> **生效分支说明**（2026-09-27 裁决后补注）：B2 的 **(a) 补实现** 与 B3 的 **新增出口**
> 已由 U-2 / U-3 选定为**生效分支**；两节中的 (b) / 「不新增」分支**保留作备选记录**，
> 不构成本任务的执行要求。对应的 `AC-B3` / `AC-B4` / `AC-B5` 按 (a) / 新增 分支验收。

### B1 R-17 修复（工具链）

1. 修 `fixtures/gen.js` 的入口守卫，改用 `node:url` 的 `pathToFileURL`（不引新依赖）。
2. **必须有双向负例守护**：① 直跑确实产出；② 被 import 时无副作用。
3. `npm run gen-fixtures` 修复后**实测产出**，读数（文件数/体积）落 `research/`。
4. 复核 `npm test` 中是否有测试**依赖了「CLI 不产出」这个错误前提** —— 若有，一并更正。

### B2 R-16 处置（能力缺口，方向由 OQ-1 决定）

**若选 (a) 补实现**：

1. 转换路径接 `TaskManager`，复用**已有**状态机（`src/core/task-manager.js`）与 adapter 接缝
   （`createCheckpointAdapter()`，见 `src/storage/authority-store.js`），**不新造状态机**。
2. 持久化 adapter 与宿主拉取路径**同源**：OPFS checkpoint 或 Authority KV，
   不可用时静默降级（L0-11）。
3. `onResume` 的分支从 `id.startsWith('fetch-')` 扩展为**按任务类型分派**，不得写成第二个 `if` 硬编码。
4. `pause` / `abort` 必须遵守 **L1-MR-8**（Worker terminate 后置空引用）——
   转换路径跑在 Worker 里（`src/core/worker-client.js`），这是**已知事故形态**（`034b7ab`）。
5. 单测覆盖：状态机迁移 + 断点命中跳过（`resumeCrcMap` / `resumedCount`）。
6. E2E：M-7 的断言面从「控制条初态隐藏」升级为**真实的 pause → resume 续传**，
   且 `resumedCount > 0` 可观测。
7. **批量转换同样接线**（U-5）—— 形态为**一个任务 + 子项游标**（`convert-batch-<ts>`）：
   - 断点记「下一个待处理子项下标 + 已完成产物清单 + **仅当前子项**的条目 crc 清单」；
   - `doneEntries` **每个子项必须重置**（跨子项复用会因同名条目错误跳过 ⇒ 产物缺条目）；
   - 恢复前有**可验证前提**（U-6）：队列中该 `taskId` 的产物数须等于断点记录数，
     否则**断点作废**并提示重跑整批 —— **不得**带着残缺前提硬续；
   - 循环内 `AbortError`（暂停/中止）**必须 `break`**，不得被既有 `catch` 吞掉后继续跑下一个包；
   - 单个子项失败的**既有语义保持不变**（记日志、继续）；任务级 `fail` 只留给结构性错误。

**若选 (b) 收窄文档**：

1. README 特性 2 / 特性 6 与 spec 中「断点续传」的表述**明确限定作用域**为宿主拉取路径。
2. 在 spec 里登记「转换路径不支持续传」为**已知边界**（而非缺陷），并给出后续可选的补实现路径。

### B3 R-19 处置（可观测性）

1. 按 OQ-2 的裁决决定**是否**新增只读调试出口；若新增，须满足：
   ① 只读（无副作用）；② 命名不与宿主全局冲突；③ 挂载点在 `host-bridge`（L0-9）；
   ④ 有单测证明三态可被读到。
2. 若用户选择**不新增**：在 spec 中把「三态不可观测」登记为**已知边界**，
   并保留上一轮的可见性契约作为替代判据。

### B4 质量门

1. `npm test` 全绿**零回退**（基线：48 passed / 1 skipped、460 passed / 2 skipped —— 以本轮开工时实测为准）。
2. 五条静态守卫 `exit=0`；`npm run build` 通过。
3. 涉及 E2E 的改动须 `npm run e2e` **exit 0**，且**连续两轮全绿**。
4. **R-20 前置**：用实例验证前，确认 Dev 实例插件版本 == 工作区
   （实测 `b16b5ba..HEAD` 插件代码差异 = **0**，故本轮开工时**已满足**；
   若执行中产生插件代码变更，须按 R-20 纪律更新 Dev 实例后再跑 E2E）。

## Acceptance Criteria

- [x] **AC-B1** `npm run gen-fixtures` **实测产出**（修复前为退出码 0 / 零产物；修复后有产物，读数落 `research/`）
      —— *2026-09-27 现场取证：`node fixtures/gen.js <tmp>` ⇒ stdout
      `generated fixture-st.zip -> …` 且目录里确有三个包；读数落 `research/gen-fixtures-fix.json`*
- [x] **AC-B2** R-17 的双向负例守护存在且通过（直跑产出 ✓ / import 无副作用 ✓），
      并**实测证明判别力**（临时改回旧写法 → 负例转红）
      —— *`test/gen-fixtures-cli.test.js`；判别力读数：改回旧写法 ⇒ ①③ 转红（stdout 为空，
      正是原缺陷的"零输出"形态）*
- [x] **AC-B3** R-16 按 OQ-1 裁决处置完毕（生效分支为 **(a) 补实现**，U-2）：
      转换路径 pause→resume 续传**可达且 `resumedCount > 0` 可观测**，有单测 + E2E 证据
      —— 其中 **E2E 用真浏览器（Worker 路径）是不可省的**（见 `design.md` D0.2b：
      单测跑主线程路径，抓不到回调不触发这类缺陷）
      —— *E2E（真浏览器）读数：控制条可见 → 暂停后出现「继续」→ 续传跑完，
      日志 `转换成功（沿用断点跳过 **129** 项）`；断言 `N=129 > 0` ✓（B2/C/E 三轮同读数）*
- [x] **AC-B3b** **批量转换续传可达**（U-5）：pause → resume 后
      ① 已完成子项**不重跑**；② 从断点游标继续；③ 产物齐（与不中断跑一遍的产物集合一致）
      —— *E2E：`M-10b 整批新增产物 == 2`（已完成子项没有被重跑）✓；
      入口可达：`M-10 多选后出现「批量转换」按钮且可用` ✓（**前提是 §3.4.16 的暂存区崩溃已修**，
      否则该入口永不可达）*
- [x] **AC-B3c** **批量预防的两个负例有判别力**（U-6 / `design.md` D1.3）：
      ① 产物不在队列（模拟页面重载）⇒ 断点**作废**而非硬续（去掉判据则用例转红）；
      ② 子项内 `AbortError` ⇒ 循环 **`break`**、后续子项不得被处理
      （去掉 `break` 则用例转红）；③ 跨子项**同名条目不得被误跳过**
      —— *单测 3.4.12 / 3.4.13 / 3.4.14；判别力实测：去掉失效判据 ⇒ 2 项转红；
      去掉 `AbortError` 分支 ⇒ 1 项转红*
- [x] **AC-B4** 若选 (a)：Worker 生命周期遵守 **L1-MR-8**（terminate 后置空），有测试守护
      —— *2026-09-27 补齐（此前**无任何用例**覆盖，现场 `grep -rln terminate test/` 为空 ⇒
      本条原先**不成立**）：新增 `test/worker-terminate-guard.test.js`（3 项，`window`/`Worker` 打桩
      走 Worker 分支）。**判别力已实测**：临时去掉 `workerInstance = null` ⇒
      第 3 条转红（`expected 1 to be 2` —— 复用已 terminated 的死实例，正是 `034b7ab` 的事故形态）；
      恢复后 3/3 绿*
- [x] **AC-B5** R-19 按 OQ-2 裁决处置完毕（新增只读出口并有单测，或登记为已知边界）
      —— *7 项单测 + E2E 里 5 条断言（存在 / 初始 `unknown` / 快照冻结 / 改不动 / 命名空间冻结）✓*
- [x] **AC-B6** `npm test` 全绿零回退；五条静态守卫 exit 0；`npm run build` 通过
      —— *见 `implement.md` §4.1 / §4.2 的读数（隔离 worktree：**516 passed / 8 skipped / 0 failed**；
      五条守卫与 build 全 `EXIT=0`）*
- [ ] **AC-B7** 涉及 E2E 的改动 `npm run e2e` exit 0 且连续两轮全绿
      —— **矩阵部分已达成**（连续三轮 182/182）；**全量 `npm run e2e` 的 exit 0 未取得**
      （smoke 段挂载断言在**并发会话重负载**下超窗，空载实测挂载稳定）
      ⇒ 收口方式待用户裁决（`implement.md` §4.3b 三选一）。**未满足，不勾**
- [x] **AC-B8** 本轮规范落 `.trellis/spec/`（自包含，内联读数与 `file:line`）
      —— *`state-management.md`（任务接线 + 续传三出口）、`quality-guidelines.md`（范式一~四）、
      `guides/instance-e2e-and-data-sync.md`（§11.1b 锚点纪律 / §11.3 七种假红 / §11.6 独占机器 /
      §11.7 冷启动窗口）、`guides/index.md` 索引同步*

## Constraints

- **C-1 不引新依赖 / 不加构建步骤**（L1-MR-11）；不改 `src/vendor/**`。
- **C-2 `src/core/` 禁止 DOM 依赖**（分层边界）：状态机接线的 DOM 部分只许放 `src/ui/` 或 `index.js`。
- **C-3 不改宿主源码**；不修宿主的问题。
- **C-4 只连 Dev 端口**（`{8001, 8003, 8899}`）跑 E2E；Real 端口出现即抛错。
- **C-5 提交边界**（L0-7(2)）：显式 pathspec，提交前校验暂存区恰为目标文件。
- **C-6 不许把「缺陷修复」扩成重构**：只修这三条，顺带发现的问题**登记**（走 `spawn_task` 或残留表），不夹带。
  **例外（经用户裁决，非夹带）**：批量转换接续传属 **U-5 明确授权的范围扩张**，计入本任务 AC-B3b/AC-B3c。

## Out of Scope

- 不做实例数据同步 / 备份（那是**子任务 A** `09-27-plugin-driven-instance-sync`）。
- 不做 Remaining 里的其它条目（PT-R2…PT-R4、R-8/R-9/R-10/R-13/R-14）。
- 不新增面向用户的大功能；不做 UI 重设计；不做性能基准。

## Open Questions

| 编号 | 问题 | 处置 |
| --- | --- | --- |
| **OQ-1** | ~~**R-16 选 (a) 补实现 还是 (b) 收窄文档？**~~ | ✅ **已裁决（U-2）：(a) 补实现** —— 用户 2026-09-27 选定「转换路径接断点续传」。设计见 `design.md` D1，执行见 `implement.md` §3 |
| **OQ-2** | ~~**R-19 是否新增 `window` 只读调试出口？**~~ | ✅ **已裁决（U-3）：新增** —— 用户 2026-09-27 选定「新增只读调试出口」。设计见 `design.md` D3，执行见 `implement.md` §2 |
| **OQ-3** | `npm test` 中是否有用例**依赖了「CLI 不产出」**这个错误前提 | 阶段 1 只读排查（`implement.md` §1.1） |

## 用户裁决记录（2026-09-27）

| 编号 | 决策点 | 用户选定 |
| --- | --- | --- |
| U-1 | 插件改进方向 | **修已知缺陷优先**（R-16 / R-17 / R-19） |
| U-2 | **R-16 处置** | **(a) 补实现**：把已有 `TaskManager` 接入转换路径并接 pause/resume 接线，让 README 特性 2/6 对用户的承诺真正落地。代价：新接缝 + UI 控制条 + 单测 + E2E（M-7 从「不可达」转为可达），且须守 `L1-MR-8`（Worker terminate 后置空，否则重蹈 `034b7ab`） |
| U-3 | **R-19 出口** | **新增只读调试出口**：新增只读探针（挂载点在 `host-bridge`，遵 `L0-9`），让 E2E 能真正断言三态。风险低（只读无副作用），但要防命名冲突 |
| U-4 | 与 `L0-1` 的关系 | 已由**改写规则**消解（v1.5.0「实例边界」），**不再是「偏离」**——见父任务 `prd.md` U-6 |
| U-5 | **R-16 修复范围** | **批量转换（`runBatchConversion`）也一并接上续传** —— 理由：README 特性 2 的「断点续传」承诺对批量同样成立；不接则那句承诺对批量仍是部分不成立 |
| U-6 | **批量续传的跨重载语义** | **同会话可续 + 失效检测**：断点持子项游标；恢复前核对队列中该 `taskId` 的产物数是否等于断点记录的已完成数，不等即**断点作废**并提示「将重跑整批」。**不改存储语义**（不把产物在暂停时自动入库） |
| U-7 | **批量可达性（2026-09-27 执行中新发现，用户裁定照做）** | 执行中发现 `runBatchConversion` 是**死代码——全仓无调用者**（`grep -rn runBatchConversion` ⇒ 只有定义 + 3 处注释/测试注释），暂存区批量栏只有「载入为源 / 下载 / 写回宿主 / 删除」，模板无批量入口；而 **README:74 承诺了「批量转换」**。用户裁定：**照做批量续传，且必须补上入口**（否则不可达 ⇒ 等于没做到）。⇒ 本任务新增**暂存区批量栏的「批量转换」入口**，一并纳入 AC-B3b |

> **裁决时点**：U-1 ~ U-3 于 2026-09-27 03:02Z（上一会话的交互问答）落定；
> 本文件原先的「待裁决」节已过时，现更正为**已裁决**（`design.md` 的 D1 / D3 即按此裁决撰写）。

## 1.4 评审门状态

| 项 | 状态 |
| --- | --- |
| **OQ-1**（R-16 处置方向） | ✅ **已裁决：补实现**（U-2） |
| **OQ-2**（R-19 只读出口） | ✅ **已裁决：新增**（U-3） |
| **R-16 修复范围**（单包 or 含批量） | ✅ **已裁决：含批量**（U-5）—— 范围扩张已同步进 B2 第 7 条与 AC-B3b/AC-B3c |
| **批量跨重载语义** | ✅ **已裁决：同会话可续 + 失效检测**（U-6）—— 不动存储语义 |
| **OQ-3**（测试是否依赖错误前提） | 阶段 1 只读排查，不阻塞开工 |
| 计划物齐备度 | `prd.md` ✓ / `design.md` ✓ / `implement.md` ✓ ⇒ **可进入 `task.py start`** |