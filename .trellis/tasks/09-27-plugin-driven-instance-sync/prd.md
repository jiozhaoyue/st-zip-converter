# 插件产包驱动的实例数据同步与备份

> 父任务：`09-27-instance-sync-and-plugin-hardening`。本文件是**工作副本**，规范条文最终落 `.trellis/spec/`。

## Goal

把上一轮的**一次性整包重灌**升级为「**插件在实例内产包 → 脚本搬运灌入**」的可重跑链路：
数据产生由**插件**承担（仅实例运行时），搬运复用已验证的宿主原生通道；
并对 **Luker 两处**做原生备份。

## 用户裁决记录（2026-09-27）

| 编号 | 决策点 | 用户选定 |
| --- | --- | --- |
| U-2 | 「实时同步」形态 | **数据产生靠插件**（实例运行时在实例内导出）；「只有实例在运行时同步」；中间搬运**可以走脚本** |
| U-3 | 备份范围 | **只备份 Luker 两处**（Dev Luker + Real Luker） |
| U-5 | Real 实例插件更新 | **更新 `:8002` / `:8004`** —— 真源 Real Luker 装的是 `1640118`（落后 218 行），而「数据产生靠插件」要求它是当前版本。通道仅限 `git pull`（动的是**插件代码目录**，不是用户数据） |
| U-6 | 与 L0-1 的关系 | **已通过「修改规则」消解，不再是「偏离」** —— 见下节 |

### U-6 的落地（**已执行完毕**，2026-09-27）

用户裁定：**「所有实例可任意更改，但不动源码」**。据此，规则真源 `tavern-harness` 已发布 **v1.5.0**
（commit `dabdbbf`，已推送）：

- `L0-1` 由「实例隔离（一律只读）」改写为「**实例边界（数据可写 · 源码禁改 · 链接禁穿）**」，
  判据**可程序化** = `git -C <实例仓> check-ignore -v <路径>`：
  - **有输出** ⇒ 运行时数据 ⇒ **可增删改**（Luker `/data/*`、`public/scripts/extensions/third-party/*`、
    `/backups/*`、`/thumbnails`；ST `/data`、`public/scripts/extensions/third-party/`、`/backups/`）；
  - **无输出** ⇒ 宿主源码（被 git 跟踪）⇒ **严禁改动**；
  - 数据路径下**指向工作区仓**的 symlink / junction ⇒ **严禁写穿**。
- 联动修订 `L0-13`（E2E 违反后果改按 `P-11` 误连风险表述 —— E2E 仍**只连 Dev**，不因本次修订放宽）、
  `L1-MF-10`（Real 数据区由「只读」改为「可写但须先备份 + 源码禁改 + 禁穿链接」）、`P-11` 防护；
  新增 **`P-19`**（链接穿透事故：2026-09-26 实测 1090 条写进 `My-repo/ST-BgLoader`）。
- 并更正一处**事实错误**：旧 `L0-1` 标题标注「与全局同源」，但用户级 `~/.claude/CLAUDE.md`
  （8 节逐节核对）**实不含本条** ⇒ 改为「仓群实践」。
- **分发与推送**：同步器 `test → dry-run → apply → verify` 全链通过，**14/14 零漂移**；
  **10 个仓已提交并推送各自 `origin`**（另 2 个目标的 `AGENTS.md` 被其 `.gitignore:18` 忽略 ⇒ 无物可提交）。

⇒ **本任务不再需要「L0-1 偏离批准」**（前一版 PRD 的 C-1 张力已消解）。
但**数据写入的纪律不变**（见 PR-1.2 与 A2）—— 走宿主原生通道、`merge` 不删独有、写入前留快照、
真实数据目标先备份。这四条现在是**新规则自带的**（`L0-1` 原因第 3 条），不是本任务的额外自我约束。

## 背景与现场取证（2026-09-27）

### 一、上一轮的同步链路面貌

`scripts/instance-sync/`（5472 行）的产包走的是**宿主原生端点**
（`export-backups.cjs` → `POST /api/users/backup`），再用 `build-packs.cjs` 转出 ST/TT/Luker 三种布局包，
最后 `import-st.cjs` / `restore-luker.cjs` / `import-pt.cjs` 逐目标灌入。
**插件本体不参与产包** —— 这正是本轮 U-2 要改的。

### 二、插件侧能力核实（用户要求「查看这个东西插件能否承担」）

**结论：能承担，且两侧能力都已存在**（无需新造）：

| 环节 | 现成实现 | 位置 |
| --- | --- | --- |
| 产包 | `fetchHostBackup(platform, selection, {onPhase, taskId, signal, resumeCheckpoint})` | `src/ui/host-bridge.js:697` |
| 类目细粒度 | `selection` 参数 + 工作台 `#category-checkboxes` | 同上 / `src/ui/category-filter.js` |
| 一步直出目标布局 | README 特性 1「从当前宿主拉取数据时可直接指定目标酒馆格式」 | `src/core/plan-preview.js` 的路由/合成分支 |
| 增量引擎 | `incrementalMergeArchives(baseArchive, incomingArchive)` | `src/ui/host-bridge.js:1517` |
| 回写自身宿主 | `restoreToHost(zipBlob,{mode:'merge'})` / `restoreToLuker` | `src/ui/host-bridge.js:880` / `:1494` |
| 可被自动化 | `openWorkbench()`（真实打开工作台并操作控件） | `e2e/specs/matrix.e2e.cjs`（spec §11.1） |

**纯前端无法跨实例写入**（同源限制）⇒ 分工固定为「**插件产包 / 脚本搬运**」。

### 三、实例插件版本落差（R-20 纪律的前置，**必须处置**）

`git rev-parse --short HEAD` + `git status --short` 实测：

| 实例 | 插件路径 | 版本 | 脏 |
| --- | --- | --- | --- |
| Dev ST `:8001` | `Instance/Dev/SillyTavern/public/scripts/extensions/third-party/st-zip-converter` | `b16b5ba` | 0 |
| Real ST `:8002` | `Instance/Real/SillyTavern/.../third-party/st-zip-converter` | `1640118` | 0 |
| Dev Luker `:8003` | `Instance/Dev/Luker/data/default-user/extensions/st-zip-converter` | `b16b5ba` | 0 |
| Real Luker `:8004` | `Instance/Real/Luker/data/default-user/extensions/st-zip-converter` | `1640118` | 0 |

- **`b16b5ba..HEAD` 的插件代码差异 = 0**（只有 `.trellis` 文档变更）⇒ **Dev 两实例的插件代码等于工作区**，
  E2E 可直接验证本轮改动，无须再更新 Dev。
- `1640118..HEAD` 差异 = **4 文件 / +218 / −46**（`index.js` +36、`src/core/transform.js` +22、
  `src/core/zip-io.js` +179、`src/ui/host-bridge.js` +27）。
- **真源 Real Luker 装的是旧版** ⇒ 若要求「插件在真源产包」，**必须先更新 Real 实例的插件**。
  通道仅限 `git pull`（L0-1；两目录均干净、`origin` 已确认指向本仓、非上游）。
  上一轮刻意**只更新 Dev**（E2E 只连 Dev）。**本轮裁决：更新 Real 两实例**（U-5）——
  因为「数据产生靠插件」要求真源的插件是当前版本。通道仅限 `git pull`。

## Requirements

### A1 插件产包通道（本子任务的核心）

1. **产包必须由插件在实例内完成** —— 走工作台的「宿主拉取」路径（`fetchHostBackup`），
   **不是** Node 侧直调 `POST /api/users/backup`。判定依据：产物由实例页面的插件 UI 触发并落盘。
2. **源实例 = Real Luker（真源）**；其插件版本须先满足 R-20 前置 —— **U-5 已裁决更新 `:8004` 的插件**。
3. **一步直出**：优先让插件**直接产出 ST / TT / Luker 三种布局的包**（OQ-2 实测），
   若成立则省掉 `build-packs.cjs` 的二次转换，减少口径漂移面。
4. **可重跑**：同一源**连续两次**产包，条目数与体积一致（确定性证据，父任务 AC-P4）。
5. 产包过程**复用插件已有的断点 checkpoint**（`resumeCheckpoint` 参数），不得新造一套。

### A2 搬运与灌入（复用上一轮，不新造）

1. 目标与通道**沿用上一轮已实测的路径**（spec `guides/instance-e2e-and-data-sync.md` §3）：

   | 目标 | 通道 | 脚本 |
   | --- | --- | --- |
   | Dev Luker `:8003` / Real Luker `:8004` | 宿主原生 `POST /api/users/restore-backup`，`mode=merge` | `restore-luker.cjs` |
   | Dev ST `:8001` / Real ST `:8002` | ST 无整包导入 ⇒ 逐类目（原生端点 + 磁盘目录形态类目） | `import-st.cjs` |
   | PT web `:8899` | 宿主数据管理面板（不是「点设置抽屉」） | `import-pt.cjs` |
   | TT | 人工交付（TT 布局包 + 导入说明） | `build-packs.cjs` 产物 |

2. **写入语义 = `merge`（覆盖同名、绝不删除目标独有内容）**，含**空目录**（上一轮 C-4 / R-9）。
3. 写入前**只读清单快照**（`snapshot-manifest.cjs`），用于事后精确报出被改动路径。
4. **链接子树守卫**：`lib/link-guard.cjs` 默认跳过 / 前置拒绝（上一轮 R-11 的穿透事故防护），
   重跑须显式 `--allow-links`。

### A3 备份（**只 Luker 两处**，U-3）

1. **Real Luker**：宿主原生数据包导出，落 `Downloads/`，命名含实例名与日期；
   附 **大小 / 条目数 / SHA-256** 记录。
2. **Dev Luker**：同上（本轮**新增** —— 上一轮 U-9 只备份了 Real，Dev 无回滚手段）。
3. 备份**必须在任何同步写入之前**完成，校验通过后才允许进入 A2。
4. **ST 两处不备份**（U-3）—— 沿用上一轮 R-7 的**用户知情风险接受**，本轮不解除；
   缓解：`merge` 语义（不删独有）+ 写入前快照 + 逐目标零删除核对。

### A4 核对（判据必须显式，不得静默）

1. 逐目标产出**差异核对读数**：源覆盖率（源有→目标有）、**目标独有零删除**证据。
2. **不可达条目必须显式列出并从分母剔除**（沿用上一轮口径纪律）——
   宁可显式剔除，**不得静默算作已覆盖**。
3. PT 的**路径比对不可用**（数据落 IndexedDB、无磁盘目录）⇒ 用**模块读数 + 库计数**判据
   （spec §12.5 的三条已实测判据：体积吻合 / 角色目录数 / 归一后系列计数）。
4. **计数口径纪律**（上一轮本仓栽了 5 次）：对照前先问「**这两个数字量的是同一件事吗？**」
   —— 文件条目数 ≠ 内容数；落盘名 ≠ 卡片内 name；版本化 blob 条目数 ≠ 角色数。

### A5 产物与落点

1. 包与备份落 `Downloads/`；读数、快照、台账落本任务 `research/`（**不入版本库**）。
2. `e2e/` 与 `scripts/instance-sync/` 的新增脚本**入库**（上一轮 U-11 已定）。
3. 零凭据入库；`test-results/` 由 `.gitignore` 管理。

## Acceptance Criteria

- [ ] **AC-A1** 插件产包通道成立：在源实例内**由插件 UI 触发**产出数据包，
      证据 = 产物落盘 + 该实例插件日志/读数（**不得**用 Node 直调端点冒充）
- [ ] **AC-A2** 插件产包**可重跑**：同一源连续两次，条目数 / 体积一致（父任务 AC-P4 的证据）
- [ ] **AC-A3** 一步直出实测有结论（OQ-2）：成立则产出三布局包；不成立则**给出实测理由**并沿用 `build-packs.cjs`
- [ ] **AC-A4** Luker 两处（Dev + Real）各有**宿主原生备份**，附 `大小/条目数/sha256`，
      且**均在写入之前**完成
- [ ] **AC-A5** 每个将被写入的目标有**写入前只读清单快照**
- [ ] **AC-A6** 五个可写目标（Dev ST / Real ST / Dev Luker / Real Luker / PT）同步完成，
      逐目标「覆盖率 + 零删除」读数齐备；不可达条目**显式列出**
- [ ] **AC-A7** PT 用模块读数判据核对（路径比对不可用），读数落 `research/`
- [ ] **AC-A8** E2E（若新增）**连续两轮全绿**；只连 Dev 白名单端口
- [ ] **AC-A9** TT 人工交付物（TT 布局包 + 导入说明）就位
- [ ] **AC-A10** 本子任务规范落 `.trellis/spec/`（自包含，内联读数与 `file:line`）

## Constraints

- **C-1 写入纪律（已不再是「偏离」）**：随 `L0-1` **v1.5.0** 改写消解 —— 实例**数据**现属规则
  **明确允许**的写入面，无须逐任务请批。纪律保持：只走宿主原生通道 + `merge` 语义（不删独有，含空目录）
  + 写入前只读快照 + 逐目标零删除核对 + 真实数据目标先备份。**另须守**：宿主源码**禁改**、
  **不得写穿**指向工作区仓的链接（`P-19`；实现见 `scripts/instance-sync/lib/link-guard.cjs`）。
- **C-2 真源只读（就"内容"而言）**：Real Luker 的**内容**只被读；它作为**写入目标**时，
  写入的是"从它自己导出的数据经他处转回"，**不得由其它实例的内容覆盖它**（同源语义：它永远是源，不是被同步方）。
  它的**插件目录**按 U-5 更新（那是代码安装，不是数据写入）。
- **C-3 TT 不自动化**：无浏览器端口 ⇒ 人工交付物。
- **C-4 不引新依赖 / 不加构建步骤**（L1-MR-11）；不改 `src/vendor/**`；**不新增 npm 包**。
- **C-5 不改其他仓**；**C-6 不改四个宿主源码**。
- **C-7 不裸拷贝文件**：所有写入走宿主原生通道或其等价的磁盘目录形态类目（ST 的 `extensions/` 等）。

## Out of Scope

- 不清理实例历史数据（含 Real Luker 的 2.5 G `backups/`，上一轮 R-8）。
- 不清理 `Dev/Luker/.../extensions/third-party/` 空目录（上一轮 R-9，须另走 PARDON）。
- 不修插件功能缺陷（那是**子任务 B** `09-27-plugin-defect-fixes` 的领域）。
- 不纳入 TT 自动化；不做性能基准。

## Open Questions

| 编号 | 问题 | 处置 |
| --- | --- | --- |
| **OQ-1** | ~~是否需要更新 Real 实例（`:8002` / `:8004`）的插件到工作区版本？~~ | ✅ **已裁决（U-5）：更新**。真源 Real Luker 装的是 `1640118`（落后 218 行），
「数据产生靠插件」要求它是当前版本。通道仅限 `git pull`（`origin` 已确认为本仓、非上游）；动的是**插件代码目录**，不是用户数据 |
| **OQ-2** | 插件能否**按目标布局一步直出**（省掉 `build-packs.cjs` 的二次转换） | 阶段 1 只读实测；读数落 `research/` |
| **OQ-3** | 插件产出的包与**宿主原生备份**的条目级差异有多大（`secrets.json` / `settings.json` 的处置） | 阶段 1 只读口径比对，差异**显式登记** |
| **OQ-4** | 插件 UI 自动化产包的稳定性（沿用 matrix spec 的 `openWorkbench()` 与**增量判定**纪律） | E2E 须连续两轮全绿（AC-A8） |

## 裁决状态（1.4 评审门之前）

| 项 | 状态 |
| --- | --- |
| **OQ-1**（Real 实例插件更新） | ✅ **已裁决：更新**（U-5）。`git pull` 通道，动插件代码目录、不动用户数据 |
| **C-1**（原「L0-1 偏离确认」） | ✅ **已消解**：`L0-1` 已按用户裁定改写为 v1.5.0「实例边界（数据可写 · 源码禁改 · 链接禁穿）」，
实例**数据**写入属规则**明确允许**面 ⇒ **不再需要偏离批准**（见 U-6 节） |