<!-- TRELLIS:START -->
# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->

# 项目概览 (st-zip-converter)

SillyTavern / Luker / TauriTavern / PureTavern 数据包互转工具，三形态运行：
1. **独立 Web**（Vite 页面，`index.html` + `#app`）
2. **ST/Luker 扩展插件**（注入宿主扩展设置抽屉，`src/ui/host-bridge.js`）
3. **Node/Vitest**（同构核心，主线程降级，无 Worker）

## 目录与架构边界

- `src/core/` — 转换核心（纯逻辑，禁止 DOM 依赖）：`transform.js`（convert 入口，target ∈ {st,l,tt,pt}，见 `TARGETS`）、`detect.js`、`plan-preview.js`、`delta.js`、`splitter.js`、`worker-client.js`（Web Worker 封装，Node 自动主线程降级）
- `src/ui/` — UI 模块（可 DOM）：`workbench-template.js`（HTML 模板唯一来源）、`host-bridge.js`（宿主嗅探/CSRF/备份拉取/恢复/扩展安装器，**含 `hostLayoutCode()`：宿主平台 luker→l 映射，宿主导出 target 必须经它归一**）、`index.js`（根控制器）、`category-filter.js`、`stash-list.js`、`export-queue.js`、`usage-dashboard.js`、`log-console.js`
- `src/storage/db.js` — IndexedDB 封装（DB_VERSION 2，files store 带 `origin` 字段：upload/host-export/converted/delta/split-part）
- `src/vendor/` — zip.js / fzstd 本地副本，勿升级改动
- `test/` — Vitest（`npm test`，~137 项）
- `docs/superpowers/specs/` 与 `docs/superpowers/plans/` — 设计规格与实施计划；`docs/research/` — Luker 机制研究报告
- `.trellis/` — Trellis 任务系统（见上方 TRELLIS 块）

## 常用命令

```bash
npm test          # Vitest 全量
npx vitest run test/xxx.test.js   # 单文件
npm run build     # vite build --base=./
npm run dev       # vite 开发服务器（独立模式手测）
```

## 关键规则（踩过的坑，务必遵守）

1. **CSS 作用域铁律**：`style.css` 所有规则必须带 `.app-container`（独立模式）或 `.st-converter-drawer-app`（插件模式）双前缀。裸选择器（`.menu_button`/`.inline-drawer`/`.text_pole`/`.checkbox_label` 等酒馆全站类）会污染宿主全站 UI——2026-09 已发生并修复过，严禁回归。禁止在容器上硬编码覆盖 `--SmartTheme*` 宿主主题变量（金色系教训）；配色一律继承宿主变量 + `var(..., 回退值)`。
2. **平台代码 vs 布局代码**：宿主检测返回 `st|luker|standalone`；转换器只接受 `st|l|tt|pt`。凡把宿主平台传给 convert/文件名模板处必须经 `hostLayoutCode()` 归一（`luker→l`）。
3. **宿主端点差异**：`/api/users/backup` ST 不支持 selection（全量导出+插件内过滤），Luker 支持（透传勾选）；恢复端点 `/api/users/restore`。相关端点调用传**宿主平台代码**（st/luker），非布局代码。
4. **宿主 CSS 类复用**：模板使用酒馆原生类（`menu_button`/`text_pole`/`checkbox_label`/`inline-drawer`/`flex-container`），样式定义在 style.css 内作用域化版本。
5. **产物统一出口**：所有转换/宿主拉取产物进待导出区（`export-queue.js`），不自动下载；临时条目下载/存工作区时才入库。
6. **浏览器 API 特性检测**：`showSaveFilePicker`（选位置导出）、drag-out `DownloadURL`（仅 Chromium）、`navigator.storage.estimate`（配额条）——必须检测并回退。

## 文档与实例隔离

- 改 `src/core/` 前读 `.trellis/spec/` 对应层规范；UI 改动前读 `docs/superpowers/specs/2026-09-07-workbench-two-block-redesign.md` 了解现行两块式结构。
- **严禁向本地酒馆实例目录（`Instance/Real/Luker/...` 等）复制/写入任何文件**；实例插件更新只能走 Git。

# Custom Agent Guidelines

- **问答交互规范 (Interactive Ask Question Mandate)**:
  - 遇到需要用户决策、澄清需求、确认配置方案、选择技术路线或任何需要用户输入时，**必须使用交互式问答工具 (`ask_question`)**，严禁输出纯文本让用户手动打字回复。
  - 每次提问必须**聚合多个问题**（涵盖方案选项、细节偏好与技术策略），一次性呈现给用户，避免单条零散交互。
  - 禁止在正文中以提问/等待确认结束回合；需要用户输入时必须调用问答工具。

- **代码编辑与文件修改规范 (Strict Diff & Prohibit Command Writing Mandate)**:
  - **强制使用 diff 工具**: 修改任何现有文件时，**必须且只能**调用 `replace_file_content` 进行精准的局部块级替换（diff）。严禁大面积重写或无意义整文件覆盖。
  - **严禁通过命令写文件**: **绝对禁止**使用终端命令行（包括 `run_command`、PowerShell、bash、`node -e`、`python -c`、`echo`、`cat <<EOF`、重定向符 `>` / `>>`、文件系统 API 脚本等）直接修改、创建或写入项目源码、配置与数据文件。
  - **透明可审查**: 所有代码变动必须具备明确的 diff 记录，以便用户随时审查与回滚。

- **禁止直接写入本地酒馆实例目录 (Strict Prohibit Modifying Local Instances Mandate)**:
  - **严格隔离代码库与运行实例**: 一切开发、修复与单测必须且只能在代码库（`ST-zip-converter`）工作区内进行。
  - **绝对禁止手动复制/写入本地实例**: 严禁向酒馆本地实例目录（如 `Instance/Real/Luker/...`）直接复制、同步或写入代码文件。
  - **必须且只能通过 Git 交付与拉取**: 实例插件的安装与更新必须完全交由 Git（`git clone` / `git pull`）或酒馆原生扩展安装器进行，保持实例目录完全受控于 Git 版本管理。

- **完成即推送 (Push on Completion Mandate)**:
  - 每个工作阶段（任务/提交批次）完成并通过测试后，必须 `git push` 到 origin，不得只提交不推送。
