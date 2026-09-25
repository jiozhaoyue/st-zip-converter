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

## 阶段 2 · ① 存储配额接原生 Inspector（R1）

- [ ] 2.1 取证 `openStorageInspector(dataSource)` 的 `dataSource` 必需形状（读 Luker `public/scripts/user.js` 的调用点）
- [ ] 2.2 新增 `isStorageInspectorAvailable()` + `openStorageInspector()` 适配器（`host-bridge.js`；取模块与取 dataSource 分离，任一步失败即降级）
- [ ] 2.3 「为何走根绝对路径 import 而非 `getContext()`」写进代码注释（附 HTTP 200 实测证据）
- [ ] 2.4 `index.js` 接线：抽屉挂载后探测一次，为真才解除 `#btn-storage-inspector` 的 `hidden`；点击 → `openStorageInspector()`
- [ ] 2.5 单测：模块导入失败 / 导出非函数 / dataSource 构造失败 → 三种降级路径均返回 `false` 且不抛
- [ ] 2.6 **实机验证**：Dev 8003 点击「存储」→ 原生 Inspector 唤起（截图或 DOM 证据）
- [ ] 2.7 反例验证：模拟模块 404 → 按钮保持 `hidden`，页面无报错

## 阶段 3 · ④ selection 语义显式化（R4）

- [ ] 3.1 `host-bridge.js` 新增 `BACKUP_SELECTION_SUPPORT` 数据表 + `hostSelectionCapability(platform)`
- [ ] 3.2 `index.js` 的 `hostSupportsSelection` 消费点改为走该函数
- [ ] 3.3 单测覆盖 `st` / `luker` / `tt` / `pt` / 未知宿主五态；**未知宿主必须走保守路径**
- [ ] 3.4 验证：既有 `test/detect-host.test.js` 不回归

## 阶段 4 · ③ 扩展管理盘点（R3，**只盘点不改流程**）

- [ ] 4.1 产出 `research/extension-manager-surfaces.md`：盘点 `openThirdPartyExtensionMenu` / `getExtensionManifest` / `getExtensionApi` / `registerExtensionApi` / `extension_settings` 的可用面与语义
- [ ] 4.2 产出「哪些自绘流程可替换 / 哪些必须保留」建议清单
- [ ] 4.3 确认 `third-party/third-party` 嵌套异常探测（L1-MR-12 防线）**未被动过**
- [ ] 4.4 建议清单交用户逐项确认 → 未获确认前**不动** `discover/install/delete`

## 阶段 5 · 验证与交付

- [ ] 5.1 `npm test` 全绿（不低于 39 文件 / 333 passed 基线）
- [ ] 5.2 三守卫通过（`check:css-scope` / `check:dom-injection` / `check:template-source`）
- [ ] 5.3 Dev 8003 实机三入口渲染无回归（重跑 `pw-final-verify.cjs`，读数与 0.4 基线对照）
- [ ] 5.4 降级证据：非 Luker 宿主或端点不可达时主路径不缺失（单测或实机反例）
- [ ] 5.5 `git push` 到 origin（L0-7 完成即推送）
- [ ] 5.6 收尾核对：`Instance/Real/**` 零写入；Dev 实例写入仅限 git 装载，且 `git status` 干净

## 核验方式（预期）

- 沿用本仓既定降级策略 **G-5**：`trellis-check` 子代理在本环境已复现 4 次「0 工具调用即退出」，
  故**转主代理串行自核**，对照 `prd.md` 的 AC 逐条现场取证（文件:行号 + 命令输出），
  并如实写进本文件。核验前**不采信**任何交接文档的进度断言。

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
