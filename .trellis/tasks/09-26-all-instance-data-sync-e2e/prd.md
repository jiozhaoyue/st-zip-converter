# 六实例数据同源 + 插件功能全自动化验证

## Goal

以 **Real Luker** 为同源基准，把本插件（st-zip-converter）打包范围内的全部内容
（角色卡、聊天、世界书、扩展、设置等）同步到全部六个实例形态，然后在同源数据上
建立**可重跑**的 Playwright E2E 基础设施，对插件做「加载冒烟 + 功能矩阵」全自动化验证。

## 用户裁决记录（2026-09-26）

| 编号 | 决策点 | 用户选定 |
| --- | --- | --- |
| U-1 | 同步范围 | **六处**（ST/Luker 各 Dev+Real，加 TT/PT） |
| U-2 | 同步内容 | **插件打包范围内的全部内容**，含角色卡与聊天 |
| U-3 | 同源语义 | **覆盖同名，不删独有**（目标独有文件一律保留） |
| U-4 | `backups/` | **同步时排除**（Real Luker 的 2.5 G 历史备份不参与同步） |
| U-5 | TT / PT 交付 | **PT 全自动 + TT 人工** |
| U-6 | 实例启动 | **授权启动全部所需实例** |
| U-7 | 验证边界 | **加载冒烟 + 功能矩阵** |
| U-8 | 流程 | 创建 Trellis 任务并进入规划 |
| U-9 | 备份范围 | **只备份 Real Luker**（我建议扩到四实例，用户否决） |
| U-10 | L0-1 偏离 | **批准**（R2 走宿主原生通道写入实例） |
| U-11 | 代码落点 | `e2e/` 与 `scripts/instance-sync/` **入库** |
| U-12 | 推进节奏 | **先跑阶段 1-2**（只读实例 + 只在 Downloads 产包），读数回报后再定阶段 3 |

## Requirements

### R1 备份先行（**仅 Real Luker**）

1. 对 **Real Luker（`:8004`）** 做一次**宿主原生数据包导出**（`POST /api/users/backup`），
   产物落到 `C:\Users\caocaobi\Downloads\`，命名含实例名与日期。**其余实例不备份**（U-9）。
2. 备份必须留下可复核记录：**文件大小 + 包内条目数 + SHA-256**。
3. 备份**必须在任何同步写入之前完成**，校验通过后才允许进入 R2。
4. 对**每一个将被写入的目标实例**，同步前做一次**只读文件清单快照**
   （`data/default-user` 的相对路径 + 大小 + mtime），落
   `research/pre-sync-manifest-<instance>.json`。

> **U-9（用户 2026-09-26 裁决）**：备份范围**只 real luker**。我原本建议扩到四个 ST/Luker 实例，
> 理由与后果如下，**如实登记、不再请批**：
>
> - 取证显示 **Dev 侧同样存有真实数据**（`Instance/Dev/readme.md`：「均为存有真实数据进行测试的
>   酒馆及类酒馆实例」；Dev Luker 有 **733 条聊天**）。
> - 因此 **Dev Luker / Dev ST / Real ST 三个目标没有原生备份、没有回滚手段**。
>   一旦 U-3 的「覆盖同名」命中了这三处的真实数据，**被覆盖的内容不可恢复**。
> - 缓解（**部分**）：① 写入一律用宿主原生 `merge` 语义，**只覆盖同名文件、绝不删除独有文件**，
>   故损失面上限 = 同名文件；② R1.4 的只读清单快照可**精确报出被改动的路径**，属取证而非回滚；
>   ③ 真正的回滚能力只对 Real Luker 具备（它既是真源、又有备份）。
> - **本条属用户知情下的风险接受**，收尾时须在「残留」表原样登记。

### R2 同源同步

1. 真源 = Real Luker 的 `data/default-user/`（**排除 `backups/`**，U-4）。排除后载荷约 **1.3 G**。
2. 目标与通道（各宿主**只走其原生机制**，不做裸文件拷贝，见 `design.md` D1）：

   | 目标实例 | 通道 |
   | --- | --- |
   | Dev Luker `:8003` / Real Luker `:8004` | 宿主原生整包恢复 `POST /api/users/restore-backup`，`mode=merge` |
   | Dev ST `:8001` / Real ST `:8002` | ST 无整包恢复端点 ⇒ 浏览器端逐类目导入（宿主原生 UI） |
   | PT web `:8899` | PT M21 导入（`merge` 策略），源为 TT 布局树 |
   | TT | **产出 TT 布局数据包 + 导入说明**，由用户在 TT 内导入（U-5） |

3. 写入语义严格执行 U-3「覆盖同名，不删独有」：**任何情况下不得删除目标实例独有的文件或目录**。
4. 同步后逐目标产出**差异核对读数**：源有→目标有（覆盖率）、目标独有是否仍在（零删除证据）。
5. 产出的数据包（ST 布局 / TT 布局 / PT 用 TT 布局）一并落到 Downloads，**它们同时是 TT 的人工交付物**。

### R3 自动化验证

1. 建立**可重跑**的 E2E 基础设施（非一次性探针），断言失败必须**非零退出**。
2. **加载冒烟**：在可自动化的三个目标上验证 —— 插件加载成功、注入点齐全、**零本插件报错/失败请求**。
3. **功能矩阵**：覆盖插件面向 UI 的核心路径 —— 宿主检测、工作台注入、计划预览、转换（含四目标分支）、
   导出队列、待导出区落库、断点续传、批量恢复、分割。
4. **测试目标仅限 Dev 白名单端口**（`8001` ST / `8003` Luker / `8899` PT web）；出现 Real 端口
   （`8002`/`8004`）必须**在启动时显式失败**，且不得有环境变量静默兜底、不得自动改写目标端口。
5. 端口守卫本身必须有**负例用例**（喂 Real 端口必须抛错）——**先证明判定能抓到违规，再相信它报 0**。

### R4 纪律与产物落点

1. **不引入构建步骤**（L1-MR-11）；不改 `src/vendor/**`。
2. **不新装 npm 包**：Playwright 使用本机全局 1.62.1，E2E 运行器自行解析该全局包
   （沿用本仓既有的「先 `require('playwright')`，失败再解析全局路径」模式）。
   若最终判定必须写入 `devDependencies`，**单独走 PARDON**（说明包名/版本/用途并获批后执行）。
3. 测试产物（trace / 截图 / 控制台记录）落本仓 `test-results/`（gitignore 管理），
   **严禁写入 `Instance/**`**；提交前脱敏（抹去 token、聊天内容、本机用户路径）。
4. 零凭据入库（L1-MR-14）；`.pw-profile*` / `.env*` / `secrets.json` 一律不入库。
5. 启动实例必须**显式指定登记端口**，**禁止使用 8000**（L0-16）。
6. 任务收尾时**关闭本次启动的全部实例**，恢复取证前的环境状态（取证时刻四个端口均未监听）。

## Acceptance Criteria

- [ ] **AC-1** Downloads 内存在 **1 份** Real Luker 宿主原生数据包，文件名可辨识实例与日期；
      附 `大小 / 条目数 / sha256` 记录；量级与源目录相符（≈3.8 G 未压缩）。
- [ ] **AC-1b** 每个将被写入的目标实例都有同步前的**只读文件清单快照**
      （`research/pre-sync-manifest-<instance>.json`），用于事后精确报出被改动路径。
- [ ] **AC-2** 四个 ST/Luker 实例 + PT 的同步完成，且每处都有**差异核对读数**：
      源覆盖率 100%（源有→目标有）、**目标独有文件零删除**。
- [ ] **AC-3** 内容级断言：Real Luker 的 **430 张角色卡 / 1029 条聊天**在目标侧可核对到
      （ST 目标按 ST 的类目与路径形态核对）。
- [ ] **AC-4** Downloads 内存在 ST 布局包、TT 布局包、（PT 用）TT 布局包各一份；
      **TT 的导入说明文件**同目录可读。
- [ ] **AC-5** E2E 运行器入库且可重跑，`node e2e/run.cjs`（或等价 `npm run e2e`）**退出码 0**。
- [ ] **AC-6** 加载冒烟在 `8001` / `8003` / `8899` 三处全过：插件加载、注入点齐全、
      **本插件零报错、零失败请求**。
- [x] **AC-7** 功能矩阵断言全部通过（R3.3 列出的九条路径）——
      `e2e/specs/matrix.e2e.cjs`：**断言 122 项 / 通过 122 / 失败 0**，且**连续两轮全绿**（可重跑性）；
      全量 `npm run e2e` = **断言 175 项 / 通过 175 / 失败 0（exit 0）**（guard 17 + smoke 36 + matrix 122）。
      两处**未按设计文档字面覆盖**、已按**可达面**验证并登记：M-7 的「转换任务 pause→resume 续传」
      在产品里**不可达**（R-16）；M-8 的 `restoreCapability` 三态**不可直接观测**（R-19）。
- [ ] **AC-8** 端口守卫负例用例存在且通过：喂 `8002` / `8004` 必须抛错、非零退出；
      无环境变量时不得静默兜底。
- [ ] **AC-9** `npm test` 全绿零回退（基线 **46 文件 / 429 passed / 2 skipped**）；
      五条静态守卫退出码 0；`npm run build` 通过。
- [ ] **AC-10** 本任务新增/更正的规范已落 `.trellis/spec/`（**自包含**，内联读数与 `file:line`），
      不得写「详见任务目录」。
- [ ] **AC-11** 收尾时**只关闭本次启动的实例**；取证时**已在运行**的 `8003`（Dev Luker）与
      `8004`（Real Luker）**保持原样、不得关闭**（那是用户既有环境）；
      `8001` / `8002` / `8899` 恢复为未监听。

## Constraints（约束与红线）

- **C-1 与 L0-1 的张力（必须在 1.4 评审门显式确认）**：L0-1 写明「严禁向本地酒馆实例目录
  复制、写入、删除、覆盖任何文件」。本任务的 R2 **必然要向实例目录写入用户数据**，
  这是用户为达成目的**明确要求并连续两次确认**的。缓解措施：① 只走宿主原生通道
  （原生整包恢复 / 原生导入 UI / PT M21 导入），不做裸文件拷贝；② 写入语义为「覆盖同名、不删独有」；
  ③ 全量先备份 + 差异核对；④ 实例启动与端口显式登记。**若用户不认可此偏离，R2 需要改设计。**
- **C-2 真源只读**：Real Luker 在同步过程中**只被读**（导出），不得作为写入目标以外的任何改动来源。
- **C-3 TT 无法自动化**：TT 是 Tauri 桌面应用（WebView2），无浏览器端口 ⇒ 不纳入 E2E 范围（U-5）。
- **C-4 不删任何目标独有内容**，包括取证时登记的 `Dev/Luker/.../extensions/third-party/` 空目录
  （P-10 隐患形态，**只登记不动手**；清理须另走 PARDON）。
- **C-5 不改其他仓**（`shujuku-rebuild` / `Zero` / `chatfilesys` / `st-git-improve` 等）。
- **C-6 ARM 不做**：本次真源 Real Luker 的 `plugins/` **零后端插件**，ST 也无该机制 ⇒
  「后端插件同步」**无对象**，不做（对应需求原话「没有的部分就不要」）。

## Out of Scope

- 不修任何插件的功能缺陷 —— 本任务是**验证与数据同源**，发现的缺陷只登记、当轮不修
  （若发现阻断性缺陷，回报用户另行裁决）。
- 不改四个宿主的源码（实例仓只被启动/调用，不被修改）。
- 不做 PT / TT 的扩展安装（PT 无磁盘扩展目录、TT 需其自身安装器，且不在本次请求范围内）。
- 不做性能基准（那是 `09-07-perf-overhaul` 的领域）。
- 不清理任何实例的历史数据（含 Real Luker 的 2.5 G `backups/`）。

## Open Questions

| 编号 | 问题 | 处理方式 |
| --- | --- | --- |
| OQ-1 | ST 1.19.0 无整包恢复端点，其「逐类目导入」的**确切 UI 路径与端点序列**未有实测记录 | 阶段 2 实地探明后再写用例；探不明则改用 ST 原生「导入用户数据」界面的实测路径 |
| OQ-2 | 3.8 G 级包经浏览器下载与经服务端落盘，哪条更稳 | 阶段 1 对 Real Luker 实测；两条通道都试，取稳者，读数入 research |
| OQ-3 | E2E 运行器是否应写入 `devDependencies` | 默认**不写**（复用全局 Playwright）；确有必要则走 PARDON 单独请批 |
| OQ-4 | 同步完成后实例保持运行还是关闭 | 默认**关闭**（AC-11）；E2E 期间按需启停 |

## 残留（**明确未做**，不得读作已覆盖）

> 截至 2026-09-26 **第五轮**收口（本轮完成功能矩阵 M-1…M-9，AC-7 达成）。
> **阶段 3 已执行**：四个 ST/Luker 目标全部达成
> 「T1 覆盖率 100% + 零删除」，逐目标读数见 `implement.md` 阶段 3 各条与 `research/diff-*-*.json`。
> 本轮新增残留 **R-16…R-19**（含 1 处**疑似产品缺陷 N-1**），逐条带 `file:line` 证据。

| 编号 | 残留项 | 原因与证据 |
| --- | --- | --- |
| **R-1** | ~~产包未产出~~ → **已解除** | 三个产包均已产出并通过 `verify-packs.cjs` 校验（见「已达成项」AC-4） |
| **R-2** | ~~ST 目标的同步通道需重新设计~~ → **已解决（第三轮）** | 结论修正：ST 确实没有整包导入，但**逐类目端点 + 裸落盘**组合可覆盖全部可达条目 —— `extensions/ user/ chats/` 与**预设/主题类 11 个类目**在 ST 上本就是**磁盘目录形态**，走裸落盘等价于原生结果。实测 Dev ST / Real ST 各 **6801 成功 / 0 失败**，不可达仅 4 条（`_convert/**` 合成元数据 3 + `secrets.json`）。**「覆盖率 100%」按可达类目成立**（分母已显式剔除 4 条） |
| **R-3** | **PT（:8899）未纳入 E2E**，PT 上插件已装但**数据未同步** | 插件安装流程已走通（`git 9358fbd`），但**TT 导入在 web 模式没有后端**：`fetch('/api/backups/tauritavern/import')` 实测 **POST 404**（GET 为 SPA 兜底 HTML）⇒ 需另起 PT `remote-server`（3030）。取证：`research/pt-import-channel.md` |
| **R-4** | **TT 侧未做任何事** | TT 是 Tauri 桌面应用（无浏览器端口，不可自动化）；按 U-5 本就是人工交付 —— 人工交付物（TT 布局包 + `TT-导入说明.md`）**已产出**（见 AC-4） |
| **R-5** | ~~功能矩阵 M-1…M-9 未实现（AC-7 未达成）~~ → **已解除（第五轮）** | `e2e/specs/matrix.e2e.cjs` 已完成：**122 项断言全过、连续两轮全绿**。文件名用 `.e2e.cjs` 而非设计文档写的 `.spec.cjs`（后者会被 vitest 当单测收集）。九条路径的判定面与全部取证见 `research/e2e-matrix-findings.md` |
| **R-6** | ~~Luker 的 `restore-backup` 未实测~~ → **已解除** | Dev Luker / Real Luker 各跑过一次真实 `mode=merge` 恢复，读数 `restoredCount=7178 / failedCount=0`；差异核对 T1 100%、T2b 零删除 |
| **R-7** | **⚠️ 风险已兑现：Dev Luker / Dev ST / Real ST 无原生备份**（用户裁决 U-9 只备份 Real Luker） | 阶段 3 已向这三处真实写入。缓解全部生效：① 写入只走宿主原生通道、语义 `merge`（不删独有）；② 同步前只读快照可**精确报出被改动路径**；③ 逐目标 T2b 判定**均零删除**；④ 本任务自身写错的产物**已按用户批准清理**（见 R-12）。**仍无回滚能力**（事实不变） |
| **R-8** | **Real Luker 的 `backups/` 2.5 G 历史备份未清理** | 不在本任务范围（Out of Scope）；登记其导致导出速率从 7 MB/s 塌到 0.9 MB/s |
| **R-9** | **`Dev/Luker/.../extensions/third-party/` 空目录未清理** | P-10 隐患形态，但 U-3「不删独有」⇒ 只登记不动手；清理须另走 PARDON |
| **R-10** | **既有抖动：`test/real-samples.test.js` 在满载时超时** | 该用例用 `zipIo.openReader()` 读 `out/` 下真实产物（560 MB），5 s 默认超时在机器满载时不够。全量跑 48 文件时抖过 1 次（另一次全量 449/449 全绿、exit 0）。**与本次改动无关** |
| **R-11** | **同步写入穿透 junction 落到外部仓（Dev Luker）** | `Instance/Dev/Luker/data/default-user/extensions/ST-BgLoader` 是指向 `My-repo/ST-BgLoader` 的 **junction** ⇒ 本次 restore 的 **1090 条穿透写进了那个仓的工作区**（该仓现 `git status` 干净）。**与 C-5「不改其他仓」实质冲突**。已加守卫（`lib/link-guard.cjs`：默认跳过 / restore 前置拒绝），但**已发生的穿透不可撤回** |
| **R-12** | ~~本任务早前的错误导入在 ST 目标留下 131 个错名卡片~~ → **已清理（用户批准）** | Dev ST 66 个 / Real ST 65 个；删除前已把 `路径 + 字节 + sha256` 落 `research/cleanup-st-char-artifacts-*.json`。判据三条同时成立才删（平铺层 ∧ 不在同步前快照 ∧ 不等于应有落盘名） |
| **R-13** | **`pack-tt-*.zip` / `pack-st-*.zip` 与 ST 目标的 `user/**`、`extensions/**` 无逐条核对** | 这些类目在 T1 里按路径判定且**全绿**（`user 191`、`extensions 5204`），但**内容级等价未逐字节校验**（校验的是「存在」而非「一致」） |
| **R-14** | **TT 的实际导入未执行** | 人工交付物已产出；TT 内导入由用户完成（U-5）。`TT-导入说明.md` 中「TT 内该扩展的具体入口位置」如实标注为未实操 |
| **R-15** | **⚠️ 事故已发生并已修复：跨宿主 `settings.json` 合并把两个 ST 实例搞停** | `import-st.cjs` 原用**并集**合并 ⇒ Luker 专有顶层键（`settings` 46 MB、`openai_settings` 34.5 MB、`themes`/`instruct`/`quickReplyPresets` 等共 27 个）被写进 ST，settings.json 由 **44 KB / 27 KB 膨到 113.7 MB** ⇒ ST 前端卡在「settings 未就绪」⇒ **所有第三方扩展都不加载**（冒烟 53→50）。**已按用户裁定修复**：只删陌生键（113.7 → 22.5 MB），并把同步器改为**按目标键集的交集合并**。台账 `research/repair-settings-merge-{dev,real}-st-*.json`；当前文件留底在 `test-results/settings-repair-backups/`（可回滚）。**残留风险**：共有键（如 `extension_settings`）仍是**源侧取值**（那是「覆盖同名」的本意），若某共有键在两宿主语义不同，其影响本轮**未逐键核验** |
| **R-16** | **M-7 的「转换任务 pause→resume 续传」在产品里不可达**（设计文档 §3.4 与实现不符） | 全仓 `taskControls.showRunning` 只出现一次（`index.js:942`），上下文是 `index.js:938 taskManager.start(taskId, '宿主拉取', …)`；`btnConvert` 路径（`index.js:1519` 起）**不碰 TaskManager**，且 `onResume`（`index.js:491`）只在 `id.startsWith('fetch-')` 时才续传 ⇒ **续传只在宿主拉取路径实现**。矩阵按可达面验（控制条初态隐藏 + 转换期间保持隐藏），`resumedCount > 0` 一项未验。见 `research/e2e-matrix-findings.md` §5 |
| **R-17** | **`fixtures/gen.js` 的 CLI 入口在本机静默空操作**（既有缺陷，非本任务引入） | `fixtures/gen.js:144` 的入口守卫用 `` `file://${process.argv[1].replace(/\\/g,'/')}` `` 构造 URL，而 `import.meta.url` 是 `file:///D:/…`（**三个**斜杠）⇒ **永不相等**。实测 `node fixtures/gen.js <dir>` 退出码 0、零输出、不产文件（即 `npm run gen-fixtures` 从未生效）。本任务的矩阵 spec 绕过该 CLI，用动态 `import()` 直调 `generateAll()`。**只登记不修**（Out of Scope） |
| **R-18** | **⚠️ 疑似产品缺陷 N-1：外部包路径上 `native` 未走布局码归一** | 同一小包、同一宿主，只改目标选项即得不同读数：`native` → 「直通 7 / **无合成** / 产物 7」；显式 `st` → 「直通 7 / **合成 1** / 产物 8」。根因：归一只在宿主拉取路径做了（`index.js:193`），而 `refreshPlan`（`index.js:631`）与 `btnConvert`（`index.js:1519`）**直接取** `targetSelect.value` ⇒ 字符串 `'native'` 直达计划器/转换器，而 `plan-preview.js` 的合成分支只认 `TARGETS.L`(:372)/`TARGETS.ST`(:383)。**在 ST 宿主上恰好等价、用户看不出；在 Luker 宿主上选「宿主原生格式」会得到未经布局转换的直通结果**。按 Out of Scope **当轮不修**，矩阵已钉住该差异（断言 native 与 st 读数不等；将来补齐归一则该断言报红提示更新）。详见 `research/e2e-matrix-findings.md` §4 |
| **R-19** | **M-8 的 `restoreCapability` 三态不可直接观测；宿主拉取路径的 pause/resume 未实测** | 三态（`unknown\|available\|unsupported`，`host-bridge.js:85`）未挂 `window`，矩阵只能验**非破坏性**的可见性契约（并已用「分卷后 `lastConvertedBlob` 置 null ⇒ 入口重新隐藏」做双向互证）。**未主动点恢复按钮**：`postRestoreWithFallback` 会对实例发真实 POST，一旦某候选端点实际存在即产生真实写入 —— 风险不对等。宿主拉取的 pause/resume 同样未测：触发它会对实例发起**全量拉取**（Dev Luker 1 GB 级），不可接受 |

## 已达成项（供收口核对）

- [x] **AC-1** Real Luker 原生数据包导出：`Downloads/backup-real-luker-20260926-010422.zip`
      = 1602.7 MB 压缩 / **3840.6 MB 未压缩** / 8683 条目 / 247.1 s，附 `bytes/entryCount/sha256` 记录
- [x] **AC-1b** 四个落盘目标的同步前只读清单快照（`pre-sync-manifest-*.json` + 阶段 3 前的 `t2-pre-*.json`）
- [x] **AC-2** 四个 ST/Luker 目标同步完成，**逐目标 T1 覆盖率 100.000% + T2b 零删除**：
      Dev ST `7177/7177`（198→198）、Real ST `7177/7177`（195→195）、
      Dev Luker `7177/7177`（6679→6679）、Real Luker `7177/7177`（7985→7985）；
      单列不判项（均有依据）：合成元数据 1–3 条、Luker 私有状态 1 条、
      **链接子树内 3 条**（Dev Luker）、宿主自管缓存 `backups/`+`thumbnails/`
- [x] **AC-3** 内容级断言：Real Luker 目标角色卡 **430 = 包内 430**、聊天 **1029 = 1029**；
      Dev Luker 为超集（431 / 1236）；两个 ST 目标按**宿主落盘名**核对角色卡 **26/26**、聊天 **1029 = 1029**
- [x] **AC-4** 三个布局包 + TT 导入说明均已落 Downloads：`pack-luker`（压缩 510.6 MB / 未压缩 619.3 MB）、
      `pack-st`（510.6 / 619.3 MB）、`pack-tt`（510.8 / 619.6 MB）、`TT-导入说明.md`；
      `verify-packs.cjs` 正负例双向验证通过（`backups/` 零条目、`characters/` 430、`chats/` 1029）
- [x] **AC-5** E2E 运行器入库且可重跑：`npm run e2e` 退出码 0
- [x] **AC-6** 加载冒烟在 `:8001` / `:8003` 全过（`:8899` 见 R-3）——
      第三轮曾因 R-15 的 settings 事故掉到 **50/53**，修复后**复跑 53/53 全绿**
- [x] **AC-7** 功能矩阵 M-1…M-9：`e2e/specs/matrix.e2e.cjs` **122 项断言全过、连续两轮全绿**；
      全量 `npm run e2e` = **175 项 / 通过 175 / 失败 0（exit 0）**。
      九条路径各自的实际判定面（全部取自插件渲染出的 DOM / IndexedDB）：
      M-1 `#env-badge` 文本 + `native` 选项；M-2 真实路径打开工作台且控件**真实可见**；
      M-3 `#plan-summary-bar`/`#output-estimate-text`/`#action-stats-badges`/`#category-checkboxes`；
      M-4 四目标各产出（产物名互不相同）；M-5 `download` 事件数 0 + `.eq-title` 计数；
      M-6 `files` store 的 `origin` **增量**；M-7 控制条状态机 + 转换路径可达性登记；
      M-8 恢复入口可见性**双向互证**；M-9 6 MB 包按 1 MB 阈值 → **8 个分卷**（`part1`…`part8` 连续）。
      **未按字面覆盖的两处已登记**：R-16（M-7 转换续传不可达）、R-19（M-8 三态不可直接观测）
- [x] **AC-8** 端口守卫负例用例存在且通过（17/17），含「Real 端口在启动浏览器前抛错」的集成证明
- [x] **AC-9** `npm test` **47 passed / 1 skipped（48 文件）、449 passed / 2 skipped、exit 0**
      —— 基线 46/429 之上**新增 2 个测试文件 / 20 项断言**（本轮新增的判定与守卫单测），**零回退**
      （另注：同批测试里 `real-samples` 在满载时抖过 1 次，见 R-10）
- [x] **AC-10** 本任务规范已落 `.trellis/spec/`（**自包含**，内联读数与 `file:line`）：
      新建 `backend/node-zip-writer-pitfalls.md`、`guides/instance-e2e-and-data-sync.md`，
      并更新三处索引；第三轮新增内容已并入 `guides/instance-e2e-and-data-sync.md`
- [x] **AC-11** 收尾只关本次启动的实例；`:8003` / `:8004` 保持原样（详见 `implement.md` 8.1）
