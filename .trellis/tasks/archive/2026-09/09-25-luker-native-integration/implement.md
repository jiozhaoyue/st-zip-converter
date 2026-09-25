# 执行清单：Luker 原生能力对接（T3）

> 复选框**随执行实时勾选**（L0-2）。每阶段结束跑一次验证命令，失败则先修复再前进。
> 改动面：`src/ui/host-bridge.js` + 接线 + 单测；**不动 `src/core/**`**。
> 实机口径：**只对 Dev Luker 8003**（R5.4 / L0-16）。

## 阶段 0 · 基线固化

- [x] 0.1 基线：`npm test` **39 文件 / 333 passed / 2 skipped** + 三守卫（`check:css-scope` / `check:dom-injection` / `check:template-source`）全绿
- [x] 0.2 Dev 8003 起实例：`NODE_ENV=production node server.js`（`Instance/Dev/Luker`，config 显式 `port: 8003`）；实测起效约 **26s**（含 webpack 编译前端库），**轮询探活要留够时间**
- [x] 0.3 Dev 插件按 Git 装载：`git clone` 至 `data/default-user/extensions/st-zip-converter`（origin 与 Real 一致）
- [x] 0.4 改造前 E2E 基线（`pw-final-verify.cjs` → `LUKER_URL=https://127.0.0.1:8003`）：抽屉读数 **270 节点 / 29 按钮 / 3 可见 / 0 `<details>` / 5 `.inline-drawer`**，与 8004 逐项一致
      - 附带发现并修复：该脚本往返断言的 `popup` 选择器自首次运行起就是坏的（见 1.6）

## 阶段 1 · ② 备份管理器真机取证（R2）—— **已闭环，结论 (a)**

- [x] 1.1 `research/pw-probe-backup-anchors.cjs`：按宿主源码推导的路径逐步点击并逐层断言
- [x] 1.2 进入路径已记录：`#account_button`（`user.js:3469`）→ `openUserProfile()`（:2350）→ `renderTemplateAsync('userProfile')` → 点原生 `.userBackupButton`（:2372）→ `openBackupManager()`（:1136）→ `renderTemplateAsync('userBackupManager')`
- [x] 1.3 **结论 (a) 锚点存在**：初始 0 → 点 `#account_button` 后 `.userBackupButton = 1` / 注入 **2** → 点原生备份按钮后 `.backupActionRow = 5` / 注入 **3**
      - **T2 的「注入未生效」结论作废且非回归**：T2 探针点的 4 个入口 id 在 Luker 上**均非正确入口**（正确是 `#account_button`）
      - 落点确认：5 个 `.backupActionRow` 中只有 index 0 含原生 ZIP 下载按钮，`querySelector` 取首个**正是预期落点**
- [x] 1.4 修正两处注入函数的注释：写明「锚点按需渲染、初始 DOM 不存在」与各自渲染链路、入口 id、落点依据（R2.2）
- [x] 1.5 验证：`npm test` 39 文件 / 333 passed / 2 skipped；三守卫通过
- [x] 1.6 修复 `pw-final-verify.cjs` 的往返断言选择器（改用 `document.querySelector('.popup-button-cancel')`）；Dev 实测取消按钮文案「否」→ 返回 `0` → 适配器映射 `false` 语义正确
- [x] 1.7 沉淀 spec：`component-guidelines.md` 的 UI Mounting 段新增 **Gotcha：锚点是「按需渲染」的**（含强制排查步骤，防止同类误判重演）

## 阶段 2 · ① 存储配额接原生 Inspector（R1）—— **已闭环（正向 + 反例均真机验证）**

- [x] 2.1 **dataSource 形状已取证**：宿主 `storage-inspector.js` 的 JSDoc 契约即
      `@param {{kind:'self'} | {kind:'any', target:string}} dataSource`；官方调用点
      `user.js:2361` 为 `openStorageInspector({ kind: 'self' })`——**不需要**构造 `RestProvider` 实例
      （函数内部自行 `new RestProvider(dataSource)`）。该面板 mutator 为 `ThrowingMutator` = **只读**。
- [x] 2.2 新增 `hasStorageInspector(mod)`（纯谓词，可单测）+ `isStorageInspectorAvailable()` + `openStorageInspector()`
- [x] 2.3 「为何走根绝对路径 import 而非 `getContext()`」与实测证据（HTTP 200 / 16.4KB）写进代码注释
- [x] 2.4 `index.js` 新增 `setupStorageInspectorButton()`：抽屉态探测一次，可用才解除 `hidden`，点击唤起
- [x] 2.5 单测 `test/storage-inspector-adapter.test.js`（6 用例）：形状判定 3 + 降级路径 3（含「只尝试一次」缓存断言）
- [x] 2.6 **实机验证（Dev 8003，正向）**：按钮 `hidden=false` / `display=flex` / h=32px；
      点击后 `.storageInspectorContainerWrapper` 出现且可见，**数据真的取到**：
      `存储 1.1 GiB / 无限制`，聊天 457.8 MiB、扩展 275.1 MiB、备份 224.9 MiB 等分类明细；
      无错误态；插件零控制台报错。脚本 `research/pw-verify-storage-inspector.cjs`
- [x] 2.7 **实机反例（Dev 8003）**：把宿主模块替换为「能加载但导出非函数」的桩 →
      按钮保持 `hidden`、点击不唤起、无弹窗、页面不报错
      - **重要更正**：最初用 Playwright `route` 把模块 404，结果**宿主自身崩掉**、插件根本不挂载
        （`settingsBlock`/`drawerApp`/`statusRow` 全 false）——因该模块是宿主自己的静态依赖。
        404 造不出有效反例；正确做法与原因已写入 spec（component-guidelines 的 Host Capability Acquisition §4）
      - 附证：该模块**仅 Luker 有**（ST / TauriTavern / PureTavern 均无）→ 该降级分支实为**非 Luker 宿主**而设

## 阶段 3 · ④ selection 语义显式化（R4）—— **已完成**

- [x] 3.1 `host-bridge.js` 新增 `BACKUP_SELECTION_SUPPORT` 显式表 + `hostSelectionCapability(platform)`
      → `{ supported, known, reason }`；未列出宿主 `known:false` 且走保守路径
- [x] 3.2 `index.js` 的推导点（原 `host.platform === 'luker'`）改为调用该函数；日志由 `reason` 生成（状态读数）
- [x] 3.3 单测 6 例（`test/detect-host.test.js`）：五态覆盖 + 「未知宿主必须与 ST 同路径（不得乐观放行）」+ reason 非空
- [x] 3.4 `npm test` 全绿，`test/detect-host.test.js` 既有用例不回归（23 用例）

## 阶段 4 · ③ 扩展管理盘点（R3，**只盘点不改流程**）—— **盘点完成，建议待裁决**

- [x] 4.1 产出 `research/extension-manager-surfaces.md`：盘点 `openThirdPartyExtensionMenu` /
      `getExtensionManifest` / `getExtensionApi` / `registerExtensionApi` / `extension_settings` 的可用面与语义
- [x] 4.2 产出四项建议（③-A 委托原生 / ③-B 保留现状 / ③-C 增原生入口 / ③-D 用 manifest API），
      **明确推荐 ③-B + ③-C**：原生安装器是**单 URL** 语义，而本仓真实场景是「从包内批量装回」，直接替代净损失批量能力
- [x] 4.3 确认 `third-party/third-party` 嵌套异常探测与配套修复动作（L1-MR-12 防线）未被动过——
      本次 `host-bridge.js` 改动**零删除行**（用 `git diff | grep '^-'` 过滤核实）
- [x] 4.4 建议清单**交用户逐项确认** —— **已裁决（2026-09-25）**：
      **用户选定 ③-B「保留现状」**——不改动 `discover/install/delete` 任何流程。
      裁决理由（写进交互问答的选项描述，用户据此选定）：Luker 的
      `openThirdPartyExtensionMenu(suggestUrl)` 是**单 URL 安装器**语义，而本仓扩展安装的真实场景是
      「从数据包里批量装回」（触发点：`restoreToHostInner` 之后的 `renderExtensionInstallerModal`），
      直接替代会**净损失批量能力**。
      · ③-C（自绘弹层内加「用宿主原生安装器打开」入口）经用户裁决**登记为可选增强、本任务不实施**——
        若日后要做需另开任务，且需先实机验证 `suggestUrl` 是否真的预填
      · **本任务对扩展管理流程零改动**：`git diff` 可证 `host-bridge.js` 改动零删除行，
        `third-party/third-party` 嵌套异常探测（L1-MR-12 防线）与配套修复动作原样保留

## 阶段 5 · 验证与交付

- [x] 5.1 `npm test`：**40 文件 / 345 passed / 2 skipped**（起点 39/333 → +12 用例）
- [x] 5.2 三守卫通过（`check:css-scope` / `check:dom-injection` / `check:template-source`）
- [x] 5.3 Dev 8003 实机三入口渲染无回归：节点 270 / 按钮 29 / `<details>` 0 / `.inline-drawer` 5 **与基线逐项一致**；
      高度 921→925（+4px）与可见按钮 3→**4**（新增「存储」）均为**本次交付项**而非回归
- [x] 5.4 降级证据：单测 3 条降级路径 + Dev 实机反例（见 2.7）
- [x] 5.5 `git push` 到 origin（L0-7 完成即推送）
- [x] 5.6 收尾核对：`Instance/Real/**` **零写入**（插件仓仍为 `main @ 3a98fb3`、`git status` 空）；
      Dev 实例写入仅限 git 装载（`d65ef96`、`git status` 空）

## 核验方式（实际执行）

- **未派发 `trellis-check` 子代理**：本仓已复现 4 次（`09-23-extension-manifest-git` 2 次、
  `09-24-perf-hardening-transfer-memory` 2 次）该子代理**输出一句开场白即退出、`tool_uses: 0`**，
  每次白烧约 40k tokens。沿用既定降级策略 **G-5（转主代理串行自核）**。
- **主代理自核口径**：对照 `prd.md` 的 9 条 Acceptance Criteria **逐条去代码/实机现场取证**
  （文件:行号 + 命令输出 + 实机读数写进各条正文），不采信任何交接文档的进度断言。
- **核验产出**：`npm test` 40 文件 / 345 passed / 2 skipped（零失败）；三条守卫退出码 0；
  Dev 8003 实机正向 + 反例双向验证；Real 实例零写入核对。
- **未通过核验而如实标注的项**：`implement.md` 4.4（③ 建议清单的逐项裁决）保持**未勾选**——
  属用户决策，未拿到确认就不记作完成。
- **过程更正（已如实记录）**：② 的降级反例最初用 `route` 造 404，实测证明那会让**宿主自身**
  崩掉而测不到本插件降级；已改用「导出非函数」桩并把原因写进 spec（见 2.7）。

## 验证命令

```bash
npm test
npm run check:css-scope && npm run check:dom-injection && npm run check:template-source
# Dev 实例实机（8003）
node .trellis/tasks/09-25-luker-native-integration/research/pw-probe-backup-anchors.cjs
LUKER_URL=https://127.0.0.1:8003 node .trellis/tasks/archive/2026-09/09-25-ui-slim-native/research/pw-final-verify.cjs
```

## 回滚点

- 阶段 0 前：`90c360d`（分支 tip）
- 阶段 2 前：阶段 1 完成后提交一次，作为存储接入的回滚点
- 阶段 4 前：阶段 3 完成后提交一次（盘点若产不出结论也不阻塞前面已交付项）
