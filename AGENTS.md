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

<!-- UNIFIED-RULES:START -->

> **注意**: 本节内容由统一规则文档自动同步生成，请勿手动编辑。
> 如需修改，请编辑源文件: .trellis/spec/guides/unified-development-rules.md
> 然后运行同步脚本: `pwsh .trellis/scripts/sync-rules.ps1`

---

# 统一开发规则

> **规则源**: `D:\Repo\Tavern-repo\My-repo\Center\.trellis\spec\guides\unified-development-rules.md`  
> **最后更新**: 2026-09-12  
> **适用仓库**: My-repo (8个项目) / Myfork (2个项目) / JS-Slash-Runner (4个项目)  
> **维护者**: jiozhaoyue

---

## 规则层级说明

- **MUST (必须)**: 硬性要求，所有项目必须遵守，违反将导致代码审查不通过
- **SHOULD (应该)**: 强烈建议，除非有充分理由否则应遵守
- **MAY (可以)**: 可选实践，项目可根据实际情况决定是否采用

---

## 1. 交互规范 (MUST)

### 1.1 必须使用交互式问答工具

遇到任何需要用户决策、澄清需求、确认配置方案、选择技术路线或任何需要用户输入时，**必须使用交互式问答工具**（`AskUserQuestion` / `ask_question`），严禁输出纯文本让用户手动打字回复。

**正确示例**:
```javascript
// 调用 AskUserQuestion 工具
AskUserQuestion({
  questions: [
    {
      question: "应该使用哪个 SQLite 引擎?",
      header: "引擎选择",
      options: [
        {label: "WASM (推荐)", description: "更快,但需要浏览器支持"},
        {label: "ASM.js", description: "兼容性好,但性能较差"}
      ]
    }
  ]
})
```

**错误示例**:
```markdown
<!-- 错误：在正文中提问 -->
请问您想使用 WASM 引擎还是 ASM.js 引擎？

请回复您的选择。
```

### 1.2 每次聚合多个问题

调用问答工具时，必须**批量提出多个关键问题**（至少 2 个以上），一次性呈现给用户，避免单条零散交互，提升对齐效率。

**正确示例**:
```javascript
AskUserQuestion({
  questions: [
    {question: "应该使用哪个 SQLite 引擎?", ...},
    {question: "是否启用自动备份?", ...},
    {question: "测试数据集大小?", ...}
  ]
})
```

**错误示例**:
```javascript
// 错误：每次只问一个问题
AskUserQuestion({questions: [{question: "应该使用哪个 SQLite 引擎?", ...}]})
// 等待用户回复后再问下一个...
```

### 1.3 禁止在正文中提问

在聊天正文/Markdown 回复中**严禁出现询问用户的提问内容**，所有问题统一放入交互面板中。

### 1.4 不得主动中止

严格保持工作连续性，不得主动终止流程或放弃交互。如果遇到阻塞问题，使用交互式问答工具询问用户如何继续，而不是停止工作。

---

## 2. 代码编辑规范 (MUST)

### 2.1 强制使用 diff 工具

修改任何现有文件时，**必须且只能**调用 `Edit` / `replace_file_content` 进行精准的局部块级替换（diff）。

**禁止行为**:
- ❌ 大面积重写整个文件
- ❌ 无意义的整文件覆盖
- ❌ 删除并重新创建文件

**正确示例**:
```javascript
Edit({
  file_path: "src/utils.js",
  old_string: "function oldImplementation() {\n  return 'old';\n}",
  new_string: "function newImplementation() {\n  return 'new';\n}"
})
```

**错误示例**:
```javascript
// 错误：用 Write 覆盖整个文件
Write({
  file_path: "src/utils.js",
  content: "... 整个文件的内容 ..."
})
```

### 2.2 严禁通过命令写文件

**绝对禁止**使用终端命令行直接修改、创建或写入项目源码、配置与数据文件。

**禁止的命令**:
- ❌ `echo "..." > file.js`
- ❌ `cat <<EOF > file.js`
- ❌ `node -e "fs.writeFileSync(...)"`
- ❌ `python -c "open('file.js', 'w').write(...)"`
- ❌ PowerShell 重定向符 `>` / `>>`
- ❌ 任何直接写文件的脚本

**例外情况**:
- ✅ 构建产物（`npm run build` 生成的 `dist/` 目录）
- ✅ 测试临时文件（在 `test/` 或 `tmp/` 中，且测试结束后清理）
- ✅ 日志文件（`.log` 文件）

### 2.3 透明可审查

所有代码变动必须具备明确的 diff 记录，以便用户随时审查与回滚。

**原因**: 
- 可追溯性：用户可以看到每一次修改
- 安全性：防止恶意代码注入
- 协作性：团队成员可以理解变更历史

---

## 3. 实例隔离规范 (MUST)

### 3.1 严格隔离代码库与运行实例

一切开发、修复与单测**必须且只能在代码库工作区内进行**。

**代码库路径**（可修改）:
- `D:\Repo\Tavern-repo\My-repo\*`
- `D:\Repo\Tavern-repo\Myfork\*`
- `D:\Repo\Tavern-repo\JS-Slash-Runner\*`

**实例路径**（**严禁修改**）:
- `D:\Repo\Instance\Real\Luker\*`
- `D:\Repo\Instance\Test\SillyTavern\*`
- 任何用户实际运行的酒馆安装目录

### 3.2 绝对禁止手动复制/写入本地实例

**严禁**向酒馆本地实例目录直接复制、同步或写入代码文件。

**禁止操作**:
- ❌ `cp src/index.js D:\Repo\Instance\Real\Luker\extensions\third-party\my-plugin\`
- ❌ `xcopy /E /Y dist\* D:\Repo\Instance\...\`
- ❌ 在 VS Code 中拖拽文件到实例目录
- ❌ 使用 rsync / robocopy 同步到实例

### 3.3 必须且只能通过 Git 交付

实例插件的安装与更新必须完全交由以下方式进行：

**允许的更新方式**:
1. ✅ **Git 更新**: 在实例目录内执行 `git pull`
2. ✅ **初次安装**: 在实例扩展目录内执行 `git clone <repo-url>`
3. ✅ **酒馆原生扩展安装器**: 通过 UI 界面安装扩展
4. ✅ **酒馆助手**: 如果项目使用酒馆助手分发

**工作流程**:
```bash
# 1. 在代码库中开发
cd D:\Repo\Tavern-repo\My-repo\ST-BgLoader
# ... 修改代码 ...
git add .
git commit -m "feat: add new feature"
git push origin main

# 2. 在实例中更新（用户操作，不是 AI 代理操作）
cd D:\Repo\Instance\Real\Luker\extensions\third-party\ST-BgLoader
git pull
# 或在酒馆 UI 中点击"更新扩展"
```

**原因**:
- 版本可控：实例中的代码永远对应一个 Git commit
- 可回滚：如果更新出问题，可以 `git checkout` 回退
- 协作友好：其他开发者可以通过 Git 历史理解变更

---

## 4. 完成推送规范 (MUST)

### 4.1 每个工作阶段必须推送

每个工作阶段（任务/提交批次）完成并通过测试后，**必须 `git push` 到 origin**，不得只提交不推送。

**工作流程**:
```bash
# 1. 完成功能开发
# ... 修改代码 ...

# 2. 运行测试
npm test

# 3. 提交
git add .
git commit -m "feat: implement feature X"

# 4. 推送（必须！）
git push origin main
```

### 4.2 Session 结束时必须推送

完成功能开发、Bug 修复或 Session 结束时，必须执行 `git commit` 并**立即执行 `git push`** 推送至远程仓库，保证云端始终具备最新代码。

**检查清单**:
- ✅ 所有修改已提交（`git status` 显示干净）
- ✅ 测试通过（`npm test` 或等效命令）
- ✅ 已推送到远程（`git log origin/main..main` 显示为空）

**例外情况**:
- 如果是 WIP (Work In Progress) 提交，可以在提交信息中标注：`git commit -m "WIP: partial implementation"`
- 但仍然应该推送，让团队成员知道进展

---

## 5. 子代理模型固定 (MUST)

### 5.1 固定使用 gemini-3-flash-preview

任何派发子代理的场景（Agent/Task 工具、Workflow 子代理、Codex spawn、自定义 agent 定义等）**一律使用 `gemini-3-flash-preview` 模型**。

**正确示例**:
```javascript
// Workflow 中
agent("分析代码结构", {
  model: "gemini-3-flash-preview",
  effort: "low"
})

// Agent 工具中
Agent({
  description: "探索代码库",
  prompt: "找出所有 API 端点",
  model: "gemini-3-flash-preview"
})
```

**配置文件示例**:
```toml
# .codex/agents/default.toml
model = "gemini-3-flash-preview"
```

```yaml
# .claude/agents/custom-agent/agent.yml
model: gemini-3-flash-preview
```

### 5.2 例外情况

**不支持指定子代理模型的平台**:
- 如果平台机制不支持指定子代理模型，不派发，由主代理亲自执行同等探索。

---

## 6. 检索先行规则 (MUST)

### 6.1 实现前必须检索

动手实现任何功能之前，**必须先检索**「是否存在现成方案 / 工具 / 技能 / 库」，不造轮子。

### 6.2 双通道检索

发起任一通道的检索即算满足；两个通道都应尝试：

**通道 1: WebSearch / WebFetch**（当前环境可用时）
```javascript
WebSearch({query: "luker plugin development best practices"})
WebFetch({url: "https://luker.cups.moe/zh-CN/development", prompt: "提取插件开发步骤"})
```

**通道 2: GitHub API 检索**（国际搜索引擎被屏蔽时，用 GitHub API 替代）
```bash
# 使用 gh CLI
gh search repos "luker plugin" --language=javascript

# 或使用 curl
curl "https://api.github.com/search/repositories?q=luker+plugin"
```

### 6.3 search-gate hook 强制校验

`search-gate` hook 已注册于 `~/.claude/settings.json`，会话内未检索前，实现类写操作（Edit/Write/写类 Bash）会被拦截。

**豁免路径**:
- `.trellis/` （规划文档）
- `docs/` （文档）
- `tasks/` （任务跟踪）
- 只读操作（Read/Glob/Grep）

**紧急禁用开关**:
```bash
$env:TRELLIS_SEARCH_GATE = 0  # 临时禁用
```

---

## 7. 构建与测试规范 (SHOULD)

### 7.1 测试优先

- 改 `src/core/` 前读 `.trellis/spec/` 对应层规范
- UI 改动前读 `docs/superpowers/specs/` 中的设计文档

### 7.2 测试必须通过

发版前必须零回退。运行 `npm test` 或等效命令，确保所有测试通过。

### 7.3 构建命令标准化

推荐使用以下标准命令名称（项目可根据实际情况调整）：

| 命令 | 用途 | 示例 |
|------|------|------|
| `npm test` | 全量测试 | `npm test` |
| `npm run build` | 构建产物 | `npm run build` |
| `npm run typecheck` | 类型检查 | `npm run typecheck` |
| `npm run smoke` | 产物冒烟测试 | `npm run smoke` |
| `npm run dev` | 开发服务器 | `npm run dev` |

### 7.4 测试覆盖率

- 核心逻辑（`src/core/`）应有 ≥80% 测试覆盖率
- UI 层可以较低覆盖率，但关键交互流程应有集成测试

---

## 8. 文档先行规范 (SHOULD)

### 8.1 改动前先读文档

- `.trellis/spec/` — 对应层规范
- `docs/superpowers/specs/` — 设计文档
- `docs/superpowers/plans/` — 实施计划
- `README.md` / `AGENTS.md` — 项目概览

### 8.2 新功能必须有设计文档

复杂功能（预计 >100 行代码或涉及多个模块）应在 `docs/superpowers/specs/` 中有对应设计文档，包含：
- 功能目标
- 技术方案
- 数据结构
- API 设计
- 测试策略

---

## 9. 项目特定覆盖机制

某些规则在特定项目中可能需要覆盖。覆盖方式：

### 9.1 在项目 AGENTS.md 中声明覆盖

```markdown
## 项目特定规则覆盖

本项目覆盖以下统一规则：

- **完成推送规范**: 本项目使用 `develop` 分支开发，推送到 `origin develop` 而非 `origin main`
- **子代理模型**: 本项目使用 `claude-sonnet-4` 作为子代理模型（原因：需要高级推理能力）
```

### 9.2 覆盖必须说明理由

每个覆盖必须包含：
1. 覆盖的规则名称
2. 覆盖后的行为
3. 覆盖的理由

---

## 10. 规则变更流程

### 10.1 提议变更

如果需要修改统一规则：
1. 在 `.trellis/tasks/` 中创建任务，说明变更理由
2. 更新本文档
3. 运行同步脚本更新所有项目：`pwsh .trellis/scripts/sync-rules.ps1`
4. 提交并推送

### 10.2 规则版本

本规则文档遵循语义化版本：
- 当前版本：**v1.0.0** (2026-09-12)
- 主版本号（1）：破坏性变更（删除规则、改变规则语义）
- 次版本号（0）：新增规则
- 修订号（0）：澄清措辞、修复错误

---

## 11. 常见问题 (FAQ)

### Q1: 如果我不同意某条 MUST 规则怎么办？

A: 
1. 首先尝试理解规则背后的原因（通常在"原因"部分说明）
2. 如果仍有疑问，使用 `AskUserQuestion` 询问用户
3. 如果确实有充分理由覆盖，在项目 AGENTS.md 中声明覆盖并说明理由

### Q2: search-gate hook 误杀了我的合理操作怎么办？

A:
1. 检查是否真的进行了检索（即使没找到结果也算）
2. 如果确实已检索但仍被拦截，报告 bug
3. 紧急情况下可以临时禁用：`$env:TRELLIS_SEARCH_GATE = 0`

### Q3: 子代理模型固定为 gemini-3-flash-preview 的原因是什么？

A:
- 成本优化：flash 模型成本低，适合大量子代理调用
- 性能平衡：对于探索/搜索类任务，flash 模型足够
- 一致性：避免不同子代理使用不同模型导致行为不一致

### Q4: 我可以在测试中违反"实例隔离规范"吗？

A:
- 单元测试/集成测试：不可以，必须使用 mock 或测试固件
- E2E 测试：可以，但必须使用**专用测试实例**（如 `Instance/Test/Luker`），而非生产实例

### Q5: 如果项目没有 `.trellis/` 目录怎么办？

A:
- 运行 `trellis init` 初始化 Trellis（如果可用）
- 或手动创建 `.trellis/spec/` 和 `.trellis/tasks/` 目录
- 或将相关文档放在 `docs/` 目录中

---

## 12. 相关资源

- [Trellis 工作流程](../.trellis/workflow.md)
- [项目规则提取报告](./.trellis/tasks/09-12-multi-repo-rules-dev-env/research/extracted-rules.md)
- [规则同步脚本](./.trellis/scripts/sync-rules.ps1)
- [Luker 开发文档](https://luker.cups.moe/zh-CN/development)
- [全局 CLAUDE.md 规则](~/.claude/CLAUDE.md)

---

**最后更新**: 2026-09-12  
**维护者**: jiozhaoyue  
**联系方式**: 通过 GitHub Issues 或项目内交互式问答


---

<!-- UNIFIED-RULES:END -->