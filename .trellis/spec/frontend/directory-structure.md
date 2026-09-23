# Directory Structure (Trinity Web & Extension Architecture · 三形态同构)

> `st-zip-converter` 的目录组织：**同一份纯前端核心**跑在三种入口——独立 Web 页、ST/Luker 扩展插件、Node/Vitest 测试环境。

---

## Overview (概述)

项目采用**三形态同构**（"Trinity"），详见根 `CLAUDE.md`「三形态入口，同构核心」与 `AGENTS.md` L1-MR-6：

1. **ST / Luker 扩展插件**：`git clone` 进宿主的第三方扩展目录（Luker 用户私有扩展须**平铺**在 `data/<user>/extensions/<name>/`，见 `AGENTS.md` L1-MR-12）。宿主读 `manifest.json`（`js: index.js`、`css: style.css`）后以原生 ES 模块加载根 `index.js`；`src/ui/host-bridge.js` 的 `mountSettingsDrawer()` 把工作台注入 `#extensions_settings2` / `#extensions_settings` 抽屉。
2. **独立 Web 应用**：`npm run dev`（=`npm start`，Vite 开发服务器，`http://localhost:5173`）或 `npm run preview`。页面 `index.html` 是**静态 markup**，含 `<div class="app-container" id="app">` 与末尾的 `<script type="module" src="./index.js">`。
3. **GitHub Pages 静态站点**：`npm run build`（=`vite build --base=./`）产出 `dist/`；`.github/workflows/deploy.yml` 在 push `main` 时自动部署（`vite.config.js` 中 `base: './'`、`worker.format: 'es'`）。

关键原则：

- **依赖自包含（装完即用）**：第三方库以本地封装副本形式放 `src/vendor/`（`zip.js`、`fzstd.js`），**勿升级、勿改动，只用其已有 API**；用户通过 Git URL 一键克隆安装后**不需要**跑 `npm install` / `npm run build`（`AGENTS.md` L1-MR-11）。
- **标准 ESM，无 IIFE 打包**：源码即原生 ES 模块，构建由 Vite 处理（含 module Worker）；**不存在** esbuild/IIFE 打包流程。
- **宿主自适应嗅探 + 原生 UI 注入**：`src/ui/host-bridge.js` 的 `detectHost()` 区分宿主/独立；宿主内除注入工作台抽屉外，还向宿主原生备份 UI 注入入口按钮（见 component-guidelines 的注入约定）。
- **可选后端静默降级**：`src/storage/authority-store.js` 探测 `window.STAuthority.AuthoritySDK`，不可用时所有接口返回 `null/false`，纯前端路径（IndexedDB / OPFS / 内存 Blob）保持全功能，主路径**不因后端缺失而阻塞**（`AGENTS.md` L0-11 / L1-MR-1）。

> **已不存在的形态（出现即为陈旧描述）**：`src/plugins/`、`dist/plugins/`、`npm run build:plugins`、IIFE 自包含包、`globalThis.__tavernConvert` 全局命名空间、`tavern-convert-` DOM 前缀、200 KiB 包体积预算、`yauzl` / `yazl` 依赖与 `src/io/**`、`cli.js`、`test/zipjs-io.test.js`、「58 项测试」。它们属于 09-04 之前的 CLI + IIFE 插件时代，已随统一工作台重构删除。

---

## Directory Layout (目录布局 · 2026-09-24 快照)

```
st-zip-converter/
├── index.html              # 独立 Web 入口：静态 markup（<div class="app-container" id="app">），末尾 <script type="module" src="./index.js">
├── index.js                # 根控制器：detectHost → 独立/插件 UI 装配 → ExportQueue + TaskManager
├── style.css               # 全部样式；每条规则必须以 .app-container / .st-converter-drawer-app 为作用域根
├── manifest.json           # ST / Luker 扩展清单（js: index.js、css: style.css、loading_order: 50）
├── vite.config.js          # base: './'、worker.format: 'es'
├── src/
│   ├── core/               # 纯逻辑层（禁止 DOM 依赖），三形态共用
│   │   ├── builtin-assets.js    # 酒馆原生默认资产指纹库（剔除系统自带背景/主题，避免重复携带几十 MB）
│   │   ├── converter-worker.js  # Web Worker 入口（module worker），包装 core 的 plan/convert
│   │   ├── delta.js             # 基准 ZIP 增量差量引擎（条目级比对 → 仅新增/修改的补丁包）
│   │   ├── detect.js            # 源布局识别（LAYOUTS: st | l | tt | pt-native | unknown）
│   │   ├── filename-template.js # 导出文件名占位符解析 + 跨系统非法字符净化
│   │   ├── inspect.js           # hub 路径 → 业务类目（CATEGORIES）+ 历史备份/快照识别
│   │   ├── logger.js            # 结构化日志单例（级别过滤 / 环形缓冲 / 事件订阅 / 文本导出）
│   │   ├── null-writer.js       # dry-run 用的空写器（同接口、不落盘、不持资源）
│   │   ├── plan-preview.js      # 完全扫描与动作预测（ACTIONS / ACTION_LABELS / SPECIAL_*）
│   │   ├── report.js            # 转换报告（每模块复制/丢弃/合成计数 + 警告清单）
│   │   ├── splitter.js          # 智能分包引擎（每个分卷都是独立合法 Zip，非 .z01 裸分片）
│   │   ├── task-manager.js      # 长任务纯状态机（running|paused|aborted|done|failed），持久化经 adapter 注入
│   │   ├── transform.js         # 转换主入口 convert()（TARGETS: st|l|tt|pt），hub 规范化 + 逐条目路由
│   │   ├── worker-client.js     # Worker 调度；无 window/Worker（Node/Vitest）自动主线程降级
│   │   └── zip-io.js            # 通用 zip IO 适配器（zip.js + fzstd，原生注册 Method 93 Zstandard）
│   ├── storage/
│   │   ├── db.js                # IndexedDB（DB_VERSION 2；files store 带 origin: upload/host-export/converted/delta/split-part）
│   │   └── authority-store.js   # Authority 可选适配器：探测 window.STAuthority.AuthoritySDK，不可用则全部返回 null/false
│   ├── vendor/             # 本地封装的第三方引擎副本（勿升级、勿改动，只用已有 API）
│   │   ├── fzstd.js            # 纯 JS Zstandard 解压（Method 93）
│   │   └── zip.js              # @zip.js/zip.js 自包含副本
│   └── ui/                 # DOM 层（仅此层可依赖 document / window）
│       ├── workbench-template.js  # HTML 模板唯一来源（getWorkbenchHtml），块一/块二两块式结构
│       ├── host-bridge.js         # 宿主嗅探 / CSRF / 备份拉取 / 恢复 / 扩展安装器 / 原生 UI 注入 / OPFS 临时文件
│       ├── escape.js              # DOM 注入防线：escapeHtml / isSafeHttpUrl / trustedStaticMarkup
│       ├── stash-list.js          # 统一工作区单列表（来源徽标 + 载入/下载/写回/删除）
│       ├── export-queue.js        # 待导出区状态机 + 渲染（所有产物的统一出口）
│       ├── category-filter.js     # 类目勾选与脱敏预设（聚合 file-tree-picker 的逐文件明细）
│       ├── file-tree-picker.js    # 逐文件穿透树/明细行（体积排序 + 大文件警示）
│       ├── file-drop.js           # 拖放区与格式探测卡片
│       ├── view.js                # 进度条 / 转换报告折叠屏 / 下载触发
│       ├── task-controls.js       # 长任务控制条（暂停/中止/续传/丢弃）
│       ├── usage-dashboard.js     # 配额条与来源统计看板
│       ├── log-console.js         # 底部实时日志抽屉
│       ├── archive-manager.js     # 旧「存档管理」组件：全仓已无调用点（保留待清理）
│       └── split-deliver-modal.js # 旧「分卷交付弹窗」：全仓已无调用点（保留待清理）
├── scripts/
│   ├── css-scope.js        # CSS 作用域守卫（PostCSS AST 走查，允许 @media 内嵌）
│   └── dom-injection-guard.js  # innerHTML/outerHTML/insertAdjacentHTML 未转义插值守卫
├── test/                   # Vitest（34 个文件；npm test 全绿即质量门槛）
│   ├── advanced-controls.test.js
│   ├── authority-store.test.js
│   ├── backup-chats.test.js
│   ├── builtin-assets.test.js
│   ├── concurrent-writer.test.js
│   ├── convert-resume.test.js
│   ├── convert.test.js
│   ├── css-scope.test.js
│   ├── db-origin.test.js
│   ├── delta.test.js
│   ├── detect-host.test.js
│   ├── detect.test.js
│   ├── dom-injection-guard.test.js
│   ├── durable-mirror.test.js
│   ├── escape.test.js
│   ├── export-queue.test.js
│   ├── filename-template.test.js
│   ├── filter.test.js
│   ├── incremental-merge.test.js
│   ├── logger.test.js
│   ├── mirror.test.js
│   ├── plan.test.js
│   ├── plugin.test.js
│   ├── private-configs.test.js
│   ├── read-write.test.js
│   ├── real-samples.test.js
│   ├── roundtrip.test.js
│   ├── smart-compression.test.js
│   ├── splitter.test.js
│   ├── stash-list.test.js
│   ├── task-manager.test.js
│   ├── unified-tree.test.js
│   ├── web-converter.test.js
│   └── zstd-method93.test.js
├── fixtures/gen.js         # 确定性测试固件生成（npm run gen-fixtures）
├── docs/                   # research/ 研究记录 + superpowers/{specs,plans} 设计与实施文档
├── .trellis/               # Trellis 任务系统（spec / tasks / workspace）
├── data-zip/               # 本地样本目录（.gitignore，严禁入库）
└── dist/                   # Vite 构建产物（.gitignore，用于 GitHub Pages）
```

> `test/` 清单是快照；**目录本身才是权威**（增删测试文件时无需回头改本文件，只需保持 `npm test` 全绿）。
> `src/ui/archive-manager.js` 与 `src/ui/split-deliver-modal.js` 的「无调用点」结论可自查：
> `grep -rn "renderArchiveManager\|renderSplitDeliveryModal" src/ index.js` —— 只会命中定义处，命中不到任何 import/调用。

---

## Multi-Entry Sync (多入口同源同改 · 摘要)

`index.html`（独立态，静态 markup）与 `src/ui/workbench-template.js`（插件态/模态态，`getWorkbenchHtml()`）是**同一套 UI 的两份独立维护副本**：结构改动必须在**同一次提交内同时改两处**（`AGENTS.md` L1-MR-10）。

- 权威约定与已知偏差（两副本当前已分歧）写在 [Component Guidelines](./component-guidelines.md) 的 **Dual-Template Sync Mandate** 一节，**不要在此重复描述**。
- 快速自查：`grep -c "<新元素 id>" index.html src/ui/workbench-template.js` —— 两处都须 ≥1。

---

## Module Responsibilities (模块职责与交互边界)

### 1. 根 `index.js`（根控制器）
- `bootstrap()`：`document.getElementById('app')` 存在 → **独立 Web 模式**，直接用 `index.html` 的静态 markup，调 `main(existingApp)`；不存在 → **宿主插件模式**，走 `mountSettingsDrawer((drawerApp) => main(drawerApp))`，工作台 markup 来自 `getWorkbenchHtml({ isDrawer: true })`。
- `main(root)` 的装配顺序：`detectHost()` → `setupDrawerToggles(root)` → `setupLogConsole(#log-console-mount || root)` → `setupCategoryFilter` → `setupFileDrop` → `new ExportQueue()` → `new TaskManager(createCheckpointAdapter() 或内存 adapter)` + `initTaskControls` → `renderStashList` / `renderUsageDashboard` / `renderExportQueue`。
- `getWorkbenchHtml({ isModal: true })` 供「扩大为模态工作台」使用，与抽屉同源同模板。

### 2. `src/ui/host-bridge.js`（宿主边界唯一出口）
- 平台判定：`detectHost()` 返回**平台码** `st | luker | standalone`；`hostLayoutCode()` 把 `luker → l` 归一为**布局码** `st | l | tt | pt`。凡把宿主平台传给 `convert()` 或文件名模板处**必须经 `hostLayoutCode()`**（否则抛 `convert: target 必须是 st|l|tt|pt 之一`）。该双轨制的**权威表述**在 [Hook Guidelines](./hook-guidelines.md)，本节不复述细节。
- 服务端校验：`verifyHostPlatform()`（`GET /version`）、`validateBackupShape()`（导出后软校验，仅告警不阻断）。
- 认证与端点：`getCsrfToken()` / `getHandle()`；`fetchHostBackup()`（含 OPFS 半成品与 `resumeCheckpoint` 续传）、`restoreToHost()` / `restoreToLuker()` / `incrementalMergeArchives()`。端点调用传**平台码**（ST `/api/users/backup` 不支持 selection，Luker 支持）。
- 扩展安装器：`discoverHostExtensions()` / `installExtensionViaHost()` / `deleteExtensionViaHost()` / `checkHostThirdPartyAnomaly()` / `renderExtensionInstallerModal()`。
- OPFS 临时文件：`supportsOpfs()` / `opfsTmpHandle()` / `opfsHandleToFile()` / `opfsTmpCleanup()`。
- UI 注入（**全部经共享 `watchHostDom`**）：`mountSettingsDrawer()`（设置抽屉 `#extensions_settings2` / `#extensions_settings`）、`registerMenuButton()`（扩展菜单，兼容保留）、`mountNativeBackupButton()`（账号弹层 + 管理面板的 `.userBackupButton` 旁）、`mountLukerBackupManagerButton()`（Luker `.userBackupManager .backupActionRow`）；`setupDrawerToggles(root)` 负责嵌套子抽屉折叠。

### 3. `src/ui/workbench-template.js`（HTML 模板唯一来源 · 两块式）
- 唯一出口 `getWorkbenchHtml({ isModal, isDrawer })`；设计文档：`docs/superpowers/plans/2026-09-07-workbench-two-block-redesign.md`。
  - **块一** `wb-block wb-block-status`：状态行/徽标 + 配额条 `#usage-dashboard` + 上传暂存区（`#dropzone` / `#stash-list` / `#stash-batch-bar`）+ 待导出区 `#export-queue-panel`。
  - **块二** `wb-block wb-block-controls`：进度条 + 转换报告折叠屏 + 统一选项（含 `#category-panel`）+ 执行按钮 + 日志挂载点 `#log-console-mount`。
- 复用宿主原生类（`.inline-drawer` / `.menu_button` / `.text_pole` / `.checkbox_label` / `.extension_block`），图标统一 Font Awesome（`fa-solid fa-...`），无 emoji。
- 徽标组按模式**只渲染一份**（抽屉模式在块一 `status-row`，独立/模态在 `header`）——历史上两处同时渲染导致重复 id，第二份 `#env-badge` 永远停在「检测中」。

### 4. `src/ui/escape.js`（DOM 注入防线）
- `escapeHtml()`（覆盖 `& < > " '`，元素上下文与**属性上下文**通用）、`isSafeHttpUrl()`（只放行 http/https）、`trustedStaticMarkup()`（恒等函数，唯一作用是让守卫放行并让 reviewer 一眼看完全部豁免点：`grep -rn "trustedStaticMarkup(" src/ index.js`）。
- 配套守卫：`npm run check:dom-injection`（`scripts/dom-injection-guard.js`）扫描 `src/ui/**` 与根 `index.js`；豁免需写 `dom-injection-guard:allow <理由>`（单条）或 `allow-file <理由>`（整文件，当前仅 `src/ui/split-deliver-modal.js` 使用，因它是待清理死代码）。

### 5. `src/ui/export-queue.js` + `src/ui/stash-list.js`（产物出口与工作区）
- 所有产物（宿主直出 / 转换生成 / 增量补丁 / 分卷）先进内存态 `ExportQueue`，由用户统一处置，**不自动下载**；`ephemeral: true` 的条目只在「下载」或「存工作区」时才落 IndexedDB。
- `stash-list.js` 是统一工作区单列表（按 `db.js` 的 `ORIGINS` 打来源徽标），渲染进 `#stash-list`；导出队列渲染进 `#export-queue-panel`。

### 6. `src/core/delta.js`（增量导出）
- `compareArchives` 基于条目元数据（文件名 / 未压缩大小 / CRC32）快速比对；`generateDeltaArchive` 只含新增与修改条目，并附审计清单 `_delta_manifest.json`。

### 7. `src/ui/log-console.js`
- 底部可折叠诊断抽屉，订阅 `logger` 事件；级别过滤（ALL/INFO/WARN/ERROR）、实时自动滚动、一键复制与导出日志文件；刷新经 `requestAnimationFrame` 合帧。

### 8. `src/storage/authority-store.js`（可选后端，不阻塞主路径）
- 探测 `window.STAuthority.AuthoritySDK`；不可用时全部接口返回 `null/false`，调用方无需分支。
- `createCheckpointAdapter()` 实现与 `TaskManager` 持久化 adapter 相同的 `{ save, load, remove }` 接缝；blob 按 4MB 分块落盘、清单存 KV。
