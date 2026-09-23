# Directory Structure（核心引擎、持久化层与 UI 注入层）

> `src/core/` 纯逻辑核心、`src/storage/` 持久化层、`src/ui/` 宿主注入层与三种运行形态的组织方式。

---

## Overview

`st-zip-converter` 的主干是一条**流式 zip 转换管线**，外加一层宿主注入 UI，用于在四酒馆平台（SillyTavern / Luker / TauriTavern / PureTavern）的导出包之间互转。项目**没有服务端进程，也没有 CLI**。

关键设计原则：

- **三形态同构**：同一份 `src/core/` 跑在三种入口——①独立 Web（`index.html` + 根 `index.js`）②ST/Luker 扩展插件（`src/ui/host-bridge.js` 注入宿主扩展设置抽屉）③Node/Vitest（`src/core/worker-client.js` 在无 `Worker` 时自动降级为主线程）。
- **逐条目流式**：不整包驻留内存，内存峰值 ≈ 最大单条目（大文件走 `addLazy` 惰性流直通，见 `src/core/transform.js` 与 `src/core/zip-io.js`）。
- **IO 解耦**：核心经注入的 `options.io` 适配器读写 zip，默认实现为 `src/core/zip-io.js`（封装 `src/vendor/zip.js` + `src/vendor/fzstd.js`）。
- **Hub & Spoke 路由**：四种源布局先归一为内部 hub（ST 摊平布局），再投影到目标布局（`src/core/transform.js` 的 `convert()`）。源布局集合见 `detect.js` 的 `LAYOUTS`，目标集合见 `transform.js` 的 `TARGETS`（`st|l|tt|pt`）。

---

## Directory Layout

```
st-zip-converter/
├── index.html              # 独立 Web 入口（#app 容器）
├── index.js                # 根控制器：detectHost → 插件注入 / 独立工作台渲染
├── style.css               # 全部规则带 .app-container / .st-converter-drawer-app 双前缀
├── manifest.json           # ST/Luker 扩展清单（js: index.js, css: style.css）
├── vite.config.js          # base './' + worker.format 'es'
├── src/
│   ├── core/               # 纯逻辑（禁止 DOM、禁止 node: 导入）
│   │   ├── builtin-assets.js   # 酒馆原生固定资产指纹库（供 pruneBuiltinAssets 剔除）
│   │   ├── converter-worker.js # 转换 Worker 入口（PLAN / CONVERT → PROGRESS / DONE / ERROR）
│   │   ├── delta.js            # 基准包差量比对与增量补丁包生成
│   │   ├── detect.js           # 源布局识别（st / l / tt / pt-native / unknown）
│   │   ├── filename-template.js# 产物文件名模板占位符解析
│   │   ├── inspect.js          # 类目归类、备份聊天/快照识别（categoryOfHubPath 等）
│   │   ├── logger.js           # 结构化日志单例（级别过滤 + 1000 条环形缓冲 + 订阅）
│   │   ├── null-writer.js      # dry-run 空写入器（只预测不落盘）
│   │   ├── plan-preview.js     # 完全扫描动作预测（generatePlan / ACTIONS）
│   │   ├── report.js           # 转换报告（Report 类 / MODULES / classifyModule）
│   │   ├── splitter.js         # 智能分卷（每片独立合法 zip，默认阈值 100MB）
│   │   ├── task-manager.js     # 长任务纯状态机（持久化 adapter 注入）
│   │   ├── transform.js        # 转换主入口 convert()，target ∈ st|l|tt|pt
│   │   ├── worker-client.js    # Worker 封装 + 无 Worker 时主线程降级
│   │   └── zip-io.js           # 统一 zip IO（vendor zip.js + fzstd Method 93）
│   ├── storage/            # 持久化
│   │   ├── db.js               # IndexedDB（DB_VERSION 2：files / workspace / preferences）
│   │   └── authority-store.js  # 可选 Authority 后端适配器（不可用时静默降级）
│   ├── vendor/             # 本地自包含副本，勿升级改动
│   │   ├── fzstd.js            # 纯 JS Zstandard 解压（Method 93）
│   │   └── zip.js              # @zip.js/zip.js 自包含副本
│   └── ui/                 # 可 DOM 层
│       ├── archive-manager.js  # 工作区统一单列表管理器
│       ├── category-filter.js  # 类目勾选与脱敏预设、动作预测条渲染
│       ├── escape.js           # escapeHtml / trustedStaticMarkup（HTML 转义唯一入口）
│       ├── export-queue.js     # 待导出区：产物统一出口（下载/入库/写回/移除）
│       ├── file-drop.js        # 拖拽上传与格式识别卡片
│       ├── file-tree-picker.js # 可穿透单项文件树与动作预览选择器
│       ├── host-bridge.js      # 宿主嗅探 / CSRF / 备份拉取 / 恢复写入 / 原生按钮注入
│       ├── log-console.js      # 底部实时诊断日志抽屉
│       ├── split-deliver-modal.js # 智能分包交付管理面板
│       ├── stash-list.js       # 上传暂存区源包列表（origin ∈ upload / host-export）
│       ├── task-controls.js    # 进度条旁的 暂停/中止/继续/丢弃 控件
│       ├── usage-dashboard.js  # 块一顶部配额条
│       ├── view.js             # 进度条、报告展示与下载触发
│       └── workbench-template.js # 工作台 HTML 模板唯一来源
├── scripts/
│   ├── css-scope.js            # CSS 双前缀守卫（npm run check:css-scope）
│   └── dom-injection-guard.js  # innerHTML 注入守卫（npm run check:dom-injection）
├── fixtures/               # 测试固件（四平台布局）
│   └── gen.js              # 固件生成脚本（npm run gen-fixtures）
├── test/                   # Vitest（当前 34 个文件 / 226 passed / 2 skipped）
│   ├── convert.test.js         # 转换规则与矩阵
│   ├── detect.test.js / detect-host.test.js  # 布局识别 / 宿主嗅探
│   ├── read-write.test.js      # zip 读写往返
│   ├── roundtrip.test.js       # CRC32 往返完整性
│   ├── splitter.test.js / delta.test.js / task-manager.test.js / convert-resume.test.js
│   ├── filter.test.js / private-configs.test.js / backup-chats.test.js
│   ├── db-origin.test.js / authority-store.test.js / durable-mirror.test.js / mirror.test.js
│   ├── css-scope.test.js / dom-injection-guard.test.js / escape.test.js
│   ├── web-converter.test.js / concurrent-writer.test.js / zstd-method93.test.js
│   ├── real-samples.test.js    # 真实样本（无样本时跳过）
│   └── …（完整清单见仓库 test/ 目录）
└── dist/                   # vite build 产物（已被 .gitignore 忽略）
```

---

## Module Organization

### 1. `src/core/` — 纯逻辑核心

- **零 Node 运行时绑定**：`src/core/**` 内不得出现 `from 'node:…'` / `require(…)` / `process.*`（当前 grep 命中数为 0）。只依赖 Web 标准（`Blob`、`Uint8Array`、`TransformStream`、`TextDecoder`）与 `src/vendor/`。
- **IO 注入契约**：`convert()` 要求 `io` 具备 `{ openReader, createWriter }`，缺省为 `src/core/zip-io.js` 的 `zipIo`；传入非法 io 直接抛错（`transform.js` 入口校验）。
- **目标守卫**：`convert()` 的 `target` 必须是 `st | l | tt | pt`（`TARGETS`），否则抛错。宿主检测返回的平台码是 `st | luker | standalone`，必须先经 `host-bridge.js` 的 `hostLayoutCode()` 归一（`luker → l`）才能传给 `convert()`。
- **确定性合成条目**：目标 `manifest.json`、`data/_tauritavern/extension-sources/*.json`、ST 目标的 `_convert/INSTALL.md`、`_convert/meta.json`、`_convert/extensions-manifest.json` 等合成条目统一使用 `FIXED_TIMESTAMP = '2020-01-01T00:00:00.000Z'`，按名字确定性排序后追加在包尾。
- **报告（`report.js`）**：`Report` 类经 `copied / dropped / filtered / synthesized / resumed / warn` 记账，模块名见 `MODULES`，出口为 `toJSON()` / `toHuman()`。
- **任务状态机（`task-manager.js`）**：`TASK_STATES = running | paused | aborted | done | failed`，是**纯状态机**——断点清单持久化经注入的 `adapter`（`{ save, load, remove }`）完成，core 不感知存储；测试用 `memoryAdapter()`。
- **差量引擎（`delta.js`）**：`compareArchives(base, target)` 按条目元数据比对基准 ZIP，只提取新增/修改条目生成增量补丁包。
- **分卷引擎（`splitter.js`）**：`DEFAULT_THRESHOLD_MB = 100` + `SAFETY_MARGIN = 0.95`（预留 5% 防止元数据溢出）；每一片都是**独立合法 zip**，不产生 `.z01` 式切片。
- **规划引擎（`plan-preview.js`）**：`generatePlan(source, target, options)` 零拷贝预读中央目录，预测每个条目归宿（`ACTIONS` / `ACTION_LABELS`）。
- **预检归类（`inspect.js`）**：`CATEGORIES` / `categoryOfHubPath()` / `categoryOfEntry()` / `isBackupChatOrSnapshot()`。

### 2. `src/core/zip-io.js` — 统一 zip IO

- 浏览器 `Blob` / `File` 与 Node 文件路径字符串**双入口**（后者供 Vitest 与无头基准使用，见 `worker-client.js` 的 `typeof source === 'string'` 分支）。
- 原生注册 Method 93（7-Zip ZS / TauriTavern 的 Zstandard）解码器，经 `src/vendor/fzstd.js` 透明解压。
- 写入管线是**并发滑动窗口**（不是串行 Promise 队列）：`CONCURRENCY = max(2, min(8, navigator.hardwareConcurrency || 6))`，`waitForSlot()` 做背压；首条目保序独占写入，之后放开并发。契约见「Quality Guidelines → Zip IO 写入并发契约」。
- 已压缩扩展名（`STORE_EXTENSIONS`）经 `entryCompressionLevel()` 判定后走 Store 直存（level 0），避免对压缩内容做无益 deflate。
- 写端用 `written` 集合对同名条目去重，保证包内条目唯一。

### 3. `src/storage/` — 持久化

- `db.js`：IndexedDB 封装（`DB_NAME = 'st_zip_converter_db'`，`DB_VERSION = 2`），stores 为 `files` / `workspace` / `preferences`；`files` 记录带 `origin`（`ORIGINS`: upload / host-export / converted / delta / split-part）与可选 `group`。非浏览器环境 `isStorageSupported()` 为 false、`openDb()` 返回 `null`。
- `authority-store.js`：**可选**后端适配器。探测 `window.STAuthority.AuthoritySDK`，不可用时所有导出接口返回 null/false（调用方无需分支）；含 `createCheckpointAdapter()`（与 TaskManager 同构的 `{save,load,remove}` 接缝）与 blob 分块存取。

### 4. `src/ui/` — 可 DOM 层

- `host-bridge.js`：环境嗅探（`detectHost()`，判定顺序 st/luker 不可颠倒）、`hostLayoutCode()`、CSRF（`/csrf-token`）、用户句柄（`/api/users/me`）、备份拉取（`/api/users/backup`）、恢复写入（`/api/users/restore`）、原生入口按钮注入（共享 `watchHostDom` MutationObserver）、扩展安装器、`FULL_SELECTION`。
- `workbench-template.js`：工作台 HTML 模板的**唯一来源**（独立模式与插件模式必须同源同改）。
- `escape.js`：`escapeHtml()` / `trustedStaticMarkup()`——所有进入 `innerHTML` 的用户可控数据必须经它，由 `scripts/dom-injection-guard.js` 强制。
- 其余为界面模块：`view.js`、`log-console.js`、`task-controls.js`、`export-queue.js`、`stash-list.js`、`archive-manager.js`、`category-filter.js`、`file-drop.js`、`file-tree-picker.js`、`split-deliver-modal.js`、`usage-dashboard.js`。

### 5. 三形态入口

| 形态 | 入口 | 说明 |
|---|---|---|
| 独立 Web | `index.html`（`#app`）+ 根 `index.js` | 直接渲染工作台；`npm run dev` 调试、`npm run build`（`vite build --base=./`）产出静态站点 |
| 酒馆扩展插件 | `manifest.json` + 根 `index.js` | `detectHost()` 命中后经 `host-bridge.js` 注入宿主扩展设置抽屉 |
| Node/Vitest | `test/**` | `worker-client.js` 检测到无 `Worker`（或源为路径字符串）→ 主线程同构执行 |

---

## Naming Conventions

- **文件与目录**：多词文件名用小写 kebab-case（例：`null-writer.js`、`filename-template.js`、`read-write.test.js`）。
- **常量**：全大写下划线（`TARGETS`、`LAYOUTS`、`FULL_SELECTION`、`FIXED_TIMESTAMP`、`MODULES`、`TASK_STATES`）。
- **zip 包内路径**：一律正斜杠 `/`，禁止 Windows 反斜杠；消费外部路径时先归一。现有归一实现见 `src/core/inspect.js`、`src/core/splitter.js`、`src/core/builtin-assets.js` 中的 `replace(/\\/g, '/')`。
