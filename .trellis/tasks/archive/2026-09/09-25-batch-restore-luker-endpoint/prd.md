# 批量恢复编排与 Luker 恢复端点平台化

## Goal

多选/分卷恢复的可观察批量编排（开批前一次选模式、失败项重跑、非原子性如实展示、完成后显式刷新按钮）+ 恢复端点按平台选择与特性探测（修 host-bridge.js:728 在 L 上必然 404 的悬置路径）+ 更正 spec 中「Luker 下隐藏恢复按钮」的错误条文

## Background（现场取证，2026-09-25）

来源：已归档父任务 `09-23-extension-cloud-migration` 的残留登记（该父任务 §「残留登记（跨子任务汇总 · 唯一权威处）」），
以及本次建成此任务时的二次取证。**以下每条均已现场核对**。

### B1 恢复端点在 Luker 上必然失败（悬置路径）

- `src/ui/host-bridge.js:728` 固定 `POST /api/users/restore`；`platform` 形参由
  `index.js:1226` 传入，但在 `host-bridge.js:719` **只用于日志**，不参与端点选择。
- Luker 的真实路由是 `/api/users/restore-backup`：黑盒探测（Dev Luker 2.7.0）
  落 `.trellis/spec/guides/tavern-datapack-formats.md:194-204`（`/api/users/restore` → 404；
  `restore-backup` 空体 400 `No backup file uploaded`，带 `avatar`+`handle`+`mode=merge`
  +`incremental=true` → 200 且响应含 `restoredCount` 等）。
- **该按钮在 Luker 下可达**（推翻 spec `:201` 的旧陈述）：`index.js:121`
  `restore: { visible: s.isHost && s.hasArtifact }` **无平台项**，`:150` 应用到 `#btn-restore-luker`；
  模板 `workbench-template.js:265` 的 `display:none` 只是首屏初始态。
  另一入口：待导出区每行「写回宿主」（`src/ui/export-queue.js:412`）。
- **已取证（2026-09-25，认证态）**：`getHandle()`（`host-bridge.js:417-426`）走 `/api/users/me`，
  在 Luker 认证态实测 **200**（`{"handle":"default-user",…}`）——spec `:195` 的「同样 404」是
  **匿名上下文**所得、不成立，这也解释了 `fetchHostBackup`（`:510` 同样调 `getHandle()`）为何在 Luker 可用。
  详见 `research/host-endpoint-facts.md`。**结论：Luker 上的失败不在取句柄，而在恢复端点。**
- **已取证（2026-09-25，认证态）**：ST 1.19.0 上 `/api/users/restore` 与 `/api/users/restore-backup`
  **均为 404**（对照实验：`/api/users/backup` → 400、不存在路由 → 404、无 CSRF → 403；
  源码交叉印证 `src/endpoints/users-private.js` 无任何整包恢复路由）——
  **ST 不提供整包恢复能力，插件在 ST 上的「写回宿主」一直是死路。**

### B2 批量恢复入口已存在，但只恢复第一项（静默部分执行）

- `src/ui/export-queue.js:243` 已有 `selected: Set` 多选，`:309` 起渲染「已选 N 项」批操作条，
  `:339-345` 提供「写回宿主」——实现是 `const first = [...selected][0]`，**只取第一项**。
- 用户勾 3 项、点「写回宿主」→ 只恢复 1 项且**无任何提示**；其余被静默丢弃。
  这不是「缺功能」，而是**误导性部分执行**。

### B3 恢复链的其他现状（决定本任务边界）

- 恢复发起点全仓唯一：`index.js:1225` `restoreToHost(fileToRestore.blob, …)`，逐条经
  `openRestoreModal`（`index.js:1183`）选模式；无队列、无逐项结果、无失败重跑。
- 恢复成功分支只写进度与日志（`index.js:1237-1238`），**无刷新引导**；全仓唯一刷新形态是
  扩展安装器的显式按钮（`host-bridge.js:1007`/`:1143`，用户点击才 `location.reload()`）。
- 已有可复用件：并发互斥 `restoreInFlight`、`cancelRestoreInFlight()`、有界等待与三态结果
  （`restore-chain.test.js` 覆盖），以及「产物统一出口」`ExportQueue`。

### B4 检索所得（L0-3 双通道；GitHub 代码检索命中，通用搜索引擎不可用）

- 同类扩展 **Atria**（`ZZZdragondYNGPHX/Atria`）已有 `public/scripts/backup-sync-center.js`（1007 行）
  的恢复实现：`POST /api/users/restore-backup` 同一 payload、`Accept: application/x-ndjson`
  解析 `progress|error|result` 三种事件、另有 `POST /api/users/restore-backup/probe` 预检
  与 `/cancel`、`/recovery/list` 端点；句柄取自 `getContext().name1`、请求头取自
  `getRequestHeaders()`，恢复后**不做整页刷新**。
- Luker 自身 `public/scripts/user.js` 亦 `uploadWithProgress('/api/users/restore-backup', …)`。
- **证据效力声明**：上述 peer/宿主实现属**参考实现**，非官方文档契约（L1-MR-5）；本任务据此
  只采用「多候选端点 + 运行时探测」这种**不依赖契约细节**的机制，探针端点（`/probe`）与
  NDJSON 进度流**不接线**（见 Out of Scope）。

## Requirements

### R1 宿主凭证与恢复端点健壮化（落点仅限桥接层，L0-9）

- **R1.1**（**已被取证定案，降级为「保留现状 + 补注释」**）`getHandle()` 继续走 `/api/users/me`：
  认证态实测 200（Luker/ST 皆然，见 `research/host-endpoint-facts.md`），而 `getContext()` 中
  **没有**代表账户句柄的字段（`name1` 是**用户人设名**，误用会把包恢复进错误目录）。
  故本条只加注释说明「该端点是句柄的权威来源」+ 记录「`name1` 禁止当句柄」，
  **不引入** `getContext()` 依赖。
- **R1.2** CSRF 加官方优先路径：`getRequestHeaders()` 的 `X-CSRF-Token`（实测存在且含该头），
  回退 `/csrf-token`（两宿主实测均 200，故此为纯增强）。
- **R1.3** 新增端点解析 `resolveRestoreEndpoint(platform)`（桥接层内）：
  - 候选序：`luker → ['/api/users/restore-backup', '/api/users/restore']`、
    `st → ['/api/users/restore', '/api/users/restore-backup']`；
  - **仅在 `404`/`405` 时回退下一候选**；成功后命中端点记入**会话内**缓存（不持久化）；
  - 全候选失败 → 抛错并列出已试端点与各自状态码。
- **R1.4** **硬安全约束**：非 `404/405` 的失败（超时、`5xx`、`413`、网络中断、取消）
  **禁止**改试另一端点——恢复请求可能已被宿主处理，重试等于对同一用户目录重复写入。
- **R1.5** 平台候选表只作**首选顺序**，不得形成「Luker 恒等于 restore-backup」的静默假设
  （宿主版本演进时靠 404 回退自愈）。
- **R1.6**（**死按钮规则**，源于 ST 实测无恢复能力）全部候选均 `404/405` ⇒ 判定「本宿主无整包恢复能力」：
  - 记入**会话内**能力标记（不持久化，刷新页面即重置）；
  - 恢复入口（`#btn-restore-luker` 单条目 / 待导出区批量按钮）进入**禁用**态并给出原因文案；
  - 错误文案必须**区别于**一般失败：说明「本宿主未提供整包恢复接口（已探测的端点列表）」+
    「请改用宿主原生方式导入数据包」，**不得**报成「恢复失败」，更**不得**报成成功；
  - 命中该标记后**不再重复探测**（避免每次点击都打一次 404）。

### R2 批量恢复编排（修掉 B2 的静默部分执行）

- **R2.1** 「已选 N 项 → 写回宿主」改为**真正的批处理**：N 项逐项恢复，不再只取第一项。
- **R2.2** 状态机：`queued → running → (item-done | item-failed) → done | partial-failed | aborted`；
  每项独立记录结果；**成功项不重跑**，失败项可单独重跑。
- **R2.3** 开批前**选一次**模式（`merge` / `overwrite`），应用到本批全部项
  （用户 2026-09-25 裁决；替代原「逐项按用户选择」）。
- **R2.4** 非原子性如实展示：进行中显示「已完成 x/N（部分数据已生效）」；
  **全部完成前不得出现「合并完成」**类文案。
- **R2.5** 批次结束后渲染**「刷新页面生效」按钮**（仅用户点击才 `location.reload()`），
  成功与部分失败两种收尾都出现，并说明失败项数量。
- **R2.6** 复用既有互斥与取消：批次进行中禁止任何第二个写回入口；
  取消/中止保留已完成项记录，提示「宿主可能已收到部分数据，请核对」。
- **R2.7** 单项失败**不中断整批**，继续后续项；失败原因逐项记录并可读回。
- **R2.8** 批次顺序 = 待导出区列表顺序（用户可感知），不重排。
- **R2.9** 单条目路径**零回归**：待导出区每行的「写回宿主」与 `openRestoreModal` 行为不变。
- **R2.10** 无 Authority 时批量恢复全功能（本地编排不需要后端，L0-11 / L1-MR-1）。

### R3 spec 更正（L0-17：规范条文落 `.trellis/spec/`，自包含带证据）

- **R3.1** 更正 `tavern-datapack-formats.md:201` 的「插件在 Luker 下会隐藏恢复按钮」——
  与 `index.js:121/150` 现状相反。
- **R3.2** 把 `:195`「`/api/users/me` 同样 404」**限定到探测上下文**（匿名/curl 所得），
  并记录「认证态下 `fetchHostBackup` 在 Luker 可用」这一矛盾证据，禁止后续 agent 直接引用该 404 作结论。
- **R3.3** 追加「恢复端点解析」条文：候选序、404-only 回退、会话缓存、
  以及 R1.4 的**禁止非 404 重试**约束；并记录 R1.6 的死按钮规则。
- **R3.4** 标注 `:196` 的 400 文案**已随版本漂移**（2026-09-25 实测为 `Missing required fields`，
  旧记为 `No backup file uploaded`）→ 该行只作**存在性证据**，禁止引用具体文案作契约。
- **R3.5** 补记「ST 1.19.0 无整包恢复端点」这一跨宿主事实（含对照实验方法与三处证据），
  供后续任何涉及恢复链的改动直接引用，避免再次误以为 ST 路径可用。

### R4 验证（实例口径）

- **R4.1** 仅对 **Dev Luker 8003**（在跑）与**可用时的 Dev ST 8001** 实测；
  **Real 8004 默认不碰**——`09-25-workbench-native-onesop` 的 Real 授权是**当轮定向**的，不延续。
- **R4.2** 认证态复测 `/api/users/me`、`/api/users/restore`、`/api/users/restore-backup`，
  区分 `404` / `403` / `401`，结论落 `research/`。
- **R4.3** 批量恢复用**合成小包**（自造、不写真数据）验证 2–3 项逐项恢复、统一模式、
  失败重跑、刷新按钮出现；不得用真实聊天数据包。

## Acceptance Criteria

> 回填方式：逐条现场取证（file:line / 命令输出 / 实机读数），不得完成任务后凭记忆批量勾选（L0-2）。
> 取证时点 **2026-09-25**；未取证的两条**保持未勾选**并记入残留（不得以「已归档」推断已完成）。

- [x] R1 全部实现，且 `test/restore-chain.test.js` 覆盖：404 → 回退命中第二候选、500 不重试、
  会话缓存命中、`selection` 载荷、`nothingRestored` 标记。
  **证据**：`restore-chain.test.js` **31 例**（原 21 + 新 10）；另 `test/restore-batch.test.js` 10 例。
  ——**偏离说明**：原 AC 写「句柄官方路径优先与回退」，取证后判定**不该做**（`getContext()` 无句柄字段、
  `name1` 是人设名）→ 改为「`getHandle()` 不加官方路径 + 补注释」，CSRF 官方优先路径已实现并覆盖
  （上下文优先 / 抛错回退 / 无宿主回退 三例）。
- [x] Dev Luker 8003 认证态实测：恢复命中 `/api/users/restore-backup` 且**真的写入**。
  **证据**：`research/pw-restore-variants.json` —— 插件模块路径
  `restoredCount: 1 / skippedCount: 1 / mode: merge`，请求 URL 三条均为
  `https://127.0.0.1:8003/api/users/restore-backup`（`research/dev-restore-smoke.json` 为首轮读数）。
- [x] `/api/users/me` 认证态行为取证落盘并写入代码注释。
  **证据**：`research/host-endpoint-facts.md` §2（Luker/ST 均 200、`name1` 非句柄）；
  注释落在 `src/ui/host-bridge.js` 的 `getHandle()` JSDoc。
- [x] 全候选 `404/405` 时：入口禁用 + 原因文案 + 会话内不再重复探测（有单测）。
  **证据**：`restore-chain.test.js`「全部候选 404：抛 RESTORE_UNSUPPORTED，且会话内不再重复探测」
  （断言二次调用**零新增请求**）；入口禁用见 `index.js` `computeActionAvailability()`
  （`!s.isRestoreUnsupported`）与 `export-queue.js` 的 `restoreBlocked` 分支。
- [ ] **Dev ST 8001 实测：恢复入口呈不可用态并给出原生导入引导。**
  —— **未验（残留 R-1）**：ST 端点存在性已在 8001 上取证（两者均 404，见
  `research/host-endpoint-facts.md` §3，实例随后按用户要求停用），但**未在浏览器里点过**
  该禁用态与提示文案。
- [ ] **多选 N≥2 项一次发起、逐项恢复且每项结果可见（Dev 8003 合成包实测）。**
  —— **未验（残留 R-2）**：批量编排的状态机有 10 条单测（含中止/重跑/未确认），
  但**未在真实宿主 UI 里跑过一次批量**；「已选 N 项只恢复第一项」的修复因此只有代码级证据。
- [x] 失败项可单独重跑，且**已成功项不被重复恢复**（单测）。
  **证据**：`restore-batch.test.js`「重跑只跑失败项，已成功项不重复恢复」（断言各调用次数）。
- [x] 全仓文案无「合并完成」类表述；进行中显示「已完成 x/N（部分数据已生效）」。
  **证据**：`grep -rn "合并完成\|已合并\|全部合并" index.js src/` 命中仅剩
  ①注释里对规则本身的说明；②`host-bridge.js` 中**未接线**函数 `incrementalMergeArchives` 的日志（无调用方）；
  ③`view.js` 里与本主题无关的折叠条注释。批量进度文案见 `export-queue.js`
  （`已完成 ${settled}/${total}（部分数据已生效）`）。
- [ ] **批次结束后出现「刷新页面生效」按钮，点击才 reload；不自动强刷。**
  —— **实现完成、实机未验（残留 R-2 同批）**：代码见 `index.js` `onRefreshPage`
  （仅按钮回调内 `window.location.reload()`）与 `export-queue.js` 收尾分支；
  但本仓无 jsdom，该分支未单测，也未在实机点过。
- [x] 取消/中止后已完成项记录保留，提示「宿主可能已收到部分数据」。
  **证据**：`restore-batch.test.js` 两条（正常完成记 done / AbortError 记「已取消」）；
  文案见 `index.js` 与 `export-queue.js` 的取消确认。
- [x] `npm test` 全绿 + 四条守卫 0。
  **证据**：**44 文件 / 406 passed / 2 skipped**（基线 42/386/2，+2 文件 +20 例，零回退）；
  四条守卫退出码 0；`npm run build` 通过。
  ——**附诚实记录**：验收过程中出现过**一次**单例失败，随后连续 9 轮（含 5 轮定向复跑
  `restore-chain`/`authority-store`/`concurrent-writer`）**均未复现**，未能定位；
  按一次性抖动记录，未归因于本次改动（也未能排除）。
- [x] R3 spec 更正落地，条文自包含。
  **证据**：`.trellis/spec/guides/tavern-datapack-formats.md`「环境教训」——更正两处错误记载
  （`/api/users/me` 404、「Luker 下隐藏恢复按钮」）、补「宿主恢复端点矩阵 + 判定方法」
  「恢复端点解析契约」「payload 两个坑」「类目目录名 ≠ 类目名」「实例 pull 后必须重启」，
  全部内联证据，不指向任务目录。
- [x] 无 Authority 时批量恢复全功能。
  **证据**：`src/core/restore-batch.js` 零后端依赖（纯状态机 + 回调注缝），
  10 条单测在无 Authority 的 Node 环境全绿。

### 残留（本任务收口时**明确未做**，不得读作已覆盖）

| 编号 | 残留项 | 为什么留下 |
| --- | --- | --- |
| R-1 | Dev ST 8001 上「恢复入口禁用态 + 原生导入引导」的实机核对 | 取证完成后实例按用户要求停用；ST 端点不存在已由黑盒对照证实，禁用逻辑有单测，仅差界面读数 |
| R-2 | 批量恢复的**实机** UI 验收（多选 N≥2 逐项、收尾条、刷新按钮点击） | 用户 2026-09-25 裁决「先收口当前任务，再开新任务修样式/env-sync」；UI 层正待修复，实机批量留待修复后重验 |
| R-3 | 探针残留物：Dev 实例 `data/default-user/worlds/zz-probe-a.json`（**合成** lorebook，无真实数据） | 由本轮实机验证写入，是否清除需用户决定（L0-1：不擅自改实例数据） |
| R-4 | Authority transfer 迁移等 | 属 `09-23-authority-cloud-transfer` 已登记不做的残留，与本任务无关 |

## Out of Scope

- **上传进度条 / Luker 的 NDJSON 进度流**：需把恢复上传从 `fetch` 改为 XHR 或按 MIME 分流，
  会触碰 `09-24-perf-hardening-transfer-memory` 刚定稿的有界等待、取消与三态结果语义
  （10 条单测）；且 NDJSON 流为参考实现所得、非官方文档 → 另案。
- **`/api/users/restore-backup/probe` 预检接线**：同理属未文档化参考实现，本任务不接线，
  仅在 `design.md` 记录为可选增强（含证据与风险）。
- **服务端合并原子恢复**：宿主无此公开契约（`tavern-datapack-formats.md:194-204`），不得实现。
- **自动强刷宿主页面**、hook 宿主路由/事件（L1-MR-4）。
- **Authority transfer API 迁移**：属已注销的残留（`09-23-authority-cloud-transfer` 登记不做）。
- **ST 端点的代码修改**：若 Dev ST 不可用或未证实存在，只报结论、不猜、不改行为。

## Open Questions

- ✅ **OQ-1 已解决**（2026-09-25 认证态实测，见 `research/host-endpoint-facts.md`）：
  Luker `/api/users/me` = **200**（`{"handle":"default-user",…}`）→ 取句柄无问题、无需改 `getHandle()`；
  `getContext()` 235 个键中**没有**账户句柄字段，`name1` 是用户人设名（**禁止**当句柄用）。
- ✅ **OQ-2 已解决**：ST 1.19.0 上 `/api/users/restore` 与 `/api/users/restore-backup` **均为 404**
  （对照实验 + 路由注册点交叉印证）→ **ST 不提供整包恢复能力**，
  插件对 ST 的处置依 **R1.6** 诚实降级（禁用入口 + 原生导入引导），不报假成功。
  该结论同时意味着：**本任务不修复 ST 的恢复能力**（宿主侧无此能力，属另案）。
- **OQ-3**：批次进行中，单条目「写回宿主」按钮是禁用还是排队？
  → **已裁决取「禁用」**（用户 2026-09-25 选择，与既有互斥一致）。

