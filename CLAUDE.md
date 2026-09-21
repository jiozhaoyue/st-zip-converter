# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

四酒馆（SillyTavern / Luker / TauriTavern / PureTavern）数据包互转工作站。**纯前端为主、Authority 服务端为可选增强层**——核心功能在纯浏览器环境完整闭环，Authority 可用时自动增强（产物持久化/断点托管），不可用时静默降级，绝不阻塞主路径。

## 常用命令

```bash
npm test                          # Vitest 全量（当前 187 项 / 30 文件）
npx vitest run test/xxx.test.js   # 单文件
npx vitest run -t "用例名"         # 单条用例
npm run dev                       # vite 开发服务器，独立模式手测（http://localhost:5173）
npm run build                     # vite build --base=./（产出 GitHub Pages 静态站点）
npm run gen-fixtures              # 重新生成测试固件 fixtures/
```

无独立 lint/typecheck 命令——类型契约靠 JSDoc + 运行时目标守卫，质量门槛就是 `npm test` 全绿。

## 高层架构（跨文件才能看懂的部分）

### 三形态入口，同构核心

同一份 `src/core/` 代码跑在三种环境，入口分别是：

1. **独立 Web**：`index.html` + `#app`，`index.js` 直接渲染两块式工作台。
2. **酒馆扩展插件**：`index.js` 检测宿主后经 `host-bridge.js` 把工作台注入扩展设置抽屉，并向原生备份 UI 注入入口按钮。
3. **Node/Vitest**：`worker-client.js` 检测无 `Worker` 时自动主线程降级，转换逻辑零改动可测。

### 分层边界（硬性）

- `src/core/` — 纯逻辑，**禁止 DOM 依赖**。`transform.js`（911 行，convert 主入口）、`plan-preview.js`、`delta.js`、`splitter.js`、`zip-io.js`（vendor zip.js 封装）。
- `src/ui/` — 可 DOM。`workbench-template.js` 是 HTML 模板唯一来源，`host-bridge.js`（1202 行）负责宿主嗅探/CSRF/拉取/恢复/注入。
- `src/storage/` — `db.js`（IndexedDB，DB_VERSION 2，files store 带 `origin` 字段区分 upload/host-export/converted/delta/split-part）、`authority-store.js`（可选后端适配器）。
- `index.js` — 根控制器，串起 detectHost → applyPluginUi → ExportQueue + TaskManager。
- `src/vendor/` — zip.js / fzstd 本地副本，**勿升级改动**，只用其已有 API。

### 关键机制（需读多文件才懂）

**平台代码双轨制**：宿主检测返回 `st|luker|standalone`（平台码），转换器只认 `st|l|tt|pt`（布局码）。凡把宿主平台传给 `convert()` / 文件名模板，必须经 `host-bridge.js` 的 `hostLayoutCode()` 归一（`luker→l`）。`/api/users/backup` 等端点调用则用平台码（ST 不支持 selection、Luker 支持）。

**Worker 并发管线**：`worker-client.js` 把 plan/convert 任务投给 `converter-worker.js`；pause/abort 先 `worker.terminate()` 再重建（见 `034b7ab` 修复——terminate 后必须重置 `workerInstance`）。Node 环境整个 Worker 路径降级为主线程同步执行。

**TaskManager 断点续传**：`task-manager.js` 是纯状态机（running/paused/aborted/done/failed），副作用经 adapter 注入（OPFS checkpoint 或 Authority KV）。`transform.js` 的 `options.signal`/`resumeCrcMap`/`onEntryDone` 三参数与其对接——crc 命中即跳过并计 `resumedCount`。

**Authority 适配器降级链**：`authority-store.js` 探测 `window.STAuthority.AuthoritySDK`，不可用时所有接口返回 `null/false`，调用方无需分支。`createCheckpointAdapter()` 实现与 TaskManager 持久化 adapter 相同的 `{save,load,remove}` 接缝。blob 按 4MB 分块落盘 + KV 存清单。

**宿主 UI 注入**：`host-bridge.js` 用共享 `watchHostDom` MutationObserver（200ms 去抖）统一四个注入点（扩展抽屉/菜单/账号弹层/管理面板行/Luker 备份管理器），幂等 + `dataset.stZipInjected` 防重，宿主重渲染自动自愈。注入元素复用宿主原生类（`menu_button` 等），零新增 CSS。

### 产物统一出口

所有转换/宿主拉取产物进待导出区（`export-queue.js`），**不自动下载**；临时条目在下载/存工作区时才入 IndexedDB。ExportQueue 渲染走 rAF 合帧防批量转换时整表高频重建。

## 踩过的坑（违反即返工）

1. **CSS 双前缀铁律**：`style.css` 所有规则必须带 `.app-container`（独立）或 `.st-converter-drawer-app`（插件）前缀。裸选择器（`.menu_button`/`.inline-drawer` 等酒馆全站类）会污染宿主全站 UI——2026-09 实测发生并修复，严禁回归。配色一律继承宿主 `--SmartTheme*` 变量 + `var(..., 回退值)`，禁止硬编码金色系。
2. **严禁写本地酒馆实例目录**；实例更新只走 Git（`git clone`/`git pull`/原生扩展安装器）。
3. **计划先行**：Trellis 任务 PRD 未回填不得提交代码；`implement.md` 复选框随执行实时勾选。
4. **完成即推送**：测试绿后 `git push` 到 origin，不得只提交不推送。

## Trellis 任务流

本项目用 Trellis 管理任务。当前任务 `python ./.trellis/scripts/task.py current`；工作流 `.trellis/workflow.md`；分层规范 `.trellis/spec/backend/`（core）与 `.trellis/spec/frontend/`（ui）。更全的项目规则与统一开发规则见 [AGENTS.md](./AGENTS.md)。
