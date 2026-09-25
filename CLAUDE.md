# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

四酒馆（SillyTavern / Luker / TauriTavern / PureTavern）数据包互转工作站。**纯前端为主、Authority 服务端为可选增强层**——核心功能在纯浏览器环境完整闭环，Authority 可用时自动增强（产物持久化/断点托管），不可用时静默降级，绝不阻塞主路径。

## 常用命令

```bash
npm test                          # Vitest 全量（当前 226 passed / 2 skipped / 34 文件）
npx vitest run test/xxx.test.js   # 单文件
npx vitest run -t "用例名"         # 单条用例
npm run dev                       # vite 开发服务器，独立模式手测（http://localhost:5173）
npm run build                     # vite build --base=./（产出 GitHub Pages 静态站点）
npm run check:css-scope           # CSS 双前缀铁律守卫（PostCSS AST）
npm run check:dom-injection       # DOM 注入守卫（innerHTML 未转义插值）
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
5. **子代理只准用自身能力 + 并行不阻塞**：只调用本 agent 平台自带的子代理功能（Copilot 即 `runSubagent`）；**禁止调用其他 agent**（`trellis channel spawn` 的 claude/codex worker、pebrel delegate、外部 CLI agent 等）。多个子代理必须**一次性并发派发**，主代理同一轮内并行推进自身工作，不串行、不空等、不轮询。

## Trellis 任务流

本项目用 Trellis 管理任务。当前任务 `python ./.trellis/scripts/task.py current`；工作流 `.trellis/workflow.md`；分层规范 `.trellis/spec/backend/`（core）与 `.trellis/spec/frontend/`（ui）。更全的项目规则与统一开发规则见 [AGENTS.md](./AGENTS.md)。

<!-- TAVERN-RULES:START v1.2.0 -->
<!-- 本块由 tavern-harness/scripts/sync_tavern_rules.py 自动生成，请勿手动编辑 -->
<!-- 真源: tavern-harness · rules/ · 仓群 my-repo · v1.2.0 -->
<!-- 同步时间: 2026-09-25T16:18:59+08:00 -->
<!-- 内容哈希: sha256:09ab3bcdfd41d464（仅覆盖规则正文，不含本头部与「项目覆盖」节） -->
<!-- 覆盖声明: 本仓如需覆盖某条规则，请在文末「项目覆盖」节声明并说明理由 -->

# 统一开发规则（v1.2.0）

> 本块为**自包含全文**，不依赖任何外部路径；由 `tavern-harness` 真源仓同步生成，请勿手动编辑。
> 适用仓群：**My-repo 仓群（酒馆扩展 / 工具插件）**。

## 规则层级

- **MUST** — 硬性要求，违反即审查不通过
- **SHOULD** — 强烈建议，除非有充分理由
- **MAY** — 可选实践

## L0 全局规则（跨仓群通用）

> 适用于 `My-repo` / `Myfork` / `JS-Slash-Runner` 三大仓群的全部仓库。
> 标注「与全局同源」的条目同时存在于用户级 `~/.claude/CLAUDE.md`；在此重复收录是为了让
> Codex / Cursor / Gemini / Copilot 等**非 Claude** agent 也能读到（全局配置只对 Claude 生效）。

### L0-1 实例隔离铁律 (MUST) ｜与全局同源，仓群实践强化

**规则**：开发与测试只在**代码库工作区**内进行。**严禁**向本地酒馆实例目录（`D:\Repo\Tavern-repo\Instance\**`）复制、写入、删除、覆盖任何文件。实例获取插件/扩展只走三条路：`git clone` / `git pull`、酒馆原生扩展安装器、酒馆助手。

**原因**：`Instance/Real/**` 下是用户的**真实聊天数据**（GB 级，且含会话密钥文件）。人工复制文件是最容易发生的污染路径。

**违反后果**：真实聊天记录被覆盖或污染、会话密钥泄漏，且**不可恢复**（无回滚手段，属红线）。

---

### L0-2 计划先行铁律 (MUST) ｜与全局同源

**规则**：Trellis 任务在 `task.py start` 前必须回填 `prd.md`（Requirements / Acceptance Criteria 不得为 `TBD`）；复杂任务另需 `design.md` + `implement.md`。`implement.md` 的复选框**随执行实时勾选**，禁止任务结束后凭记忆批量补勾。

**原因**：前作 `09-12-multi-repo-rules-dev-env` 的教训——代码写完三片后 PRD 仍为 `TBD`，人机意图发生漂移，事后无法判断"完成"的定义。

**违反后果**：验收标准缺失 → 无法判断任务是否完成 → 返工重做。

---

### L0-3 检索先行（双通道）(MUST) ｜与全局同源

**规则**：动手实现任何功能前，**必须先检索**是否存在现成方案 / 工具 / 库 / 技能，不造轮子。双通道（两者都应尝试）：
1. `WebSearch` / `WebFetch`（可用时）
2. **GitHub API 检索**：`api.github.com/search/repositories`（可用 `gh search repos` 或 curl）

**国际搜索引擎被屏蔽时，用 GitHub API 替代**（`api.github.com` 在本机可访问）。**发起调用即算满足**——无命中结果同样放行。

**原因**：本机网络环境下通用搜索引擎不可靠，但 GitHub API 稳定可达；用户明确要求不重复造轮子。

**违反后果**：重复实现已有成熟方案，浪费工时并引入自维护负担（用户明确表示要避免"自己维护的地狱"）。

---

### L0-4 变更必须可审：diff 工具 + 块级编辑 (MUST) ｜与全局同源

**规则**：比较代码/文件变更**一律使用 diff 类工具**，不得仅靠肉眼通读全文。修改现有文件必须**块级替换**（`Edit`），禁止 `Write` 整文件覆盖；禁止用 shell 重定向 / `node -e` / `echo` 直接改写源码与数据。

**原因**：整文件覆盖会把未读到的内容静默丢弃；肉眼比对无法发现细微差异。

**违反后果**：静默丢失他人或历史的修改，且 diff 无法审出，事后追溯困难。

---

### L0-5 交互问答规范 (MUST) ｜与全局同源

**规则**：需要用户决策时**必须使用交互式问答工具**（Claude Code 的 `AskUserQuestion` 或其平台等价物），**严禁在正文里提问然后结束回合**（会阻塞流程）。每次聚合 ≥2 个问题。凡涉及**重大方向性决策**（架构取舍、重构 vs 重写、技术选型、大范围删除/迁移），必须先列出候选方案与利弊、给出推荐，经用户选定后再动手。

**原因**：正文提问会让用户面对无结构的长文本，且容易被忽略而卡住任务；结构化选项能让用户几下点完。

**违反后果**：流程阻塞或用户未注意 → agent 擅自拍板 → 方向性返工。

---

### L0-6 高风险操作安全门禁（PARDON）(MUST) ｜与全局同源

**规则**：执行任何高风险或不可逆操作前，**必须显式向用户确认并获得授权**：

| 触发场景 | 门禁要求 |
| --- | --- |
| 删除 / 覆盖任何已有文件 | 列出目标文件路径与删除理由，等待批准 |
| 安装任何包（npm / pip / cargo / go get） | 说明包名、版本、用途并获授权 |
| 大规模重构或分支清理 | 先给完整设计、影响范围与回滚预案 |
| 不确定该怎么做 | **先问，不猜**（走 L0-5） |

**原因**：这些操作多数不可逆，且影响面常超出当下任务。

**违反后果**：不可逆的数据或历史丢失。

---

### L0-7 Git 与推送纪律 (MUST) ｜仓群实践（SillyTavern-Timelines 成文政策）

**规则**：
- 每次 `git commit` 完成后**必须推送到远程**，禁止只做本地提交。推送目标固定为 `origin`（自己的 fork 或自有仓），**绝不推送到 `upstream`**。
- **凡承载共享知识或工具的仓库（规则真源、脚手架、同步器、脚本集），必须建立远程仓；默认建为私有仓**
  （`gh repo create <name> --private`），因为这类仓常含本机路径、实例配置等不宜公开的细节。确需公开时先脱敏。
- **缺 remote 的仓视为"未完成"**，不得当作已交付。
- 例外仅当用户在同一轮明确说"先不要推"。
- 拉取上游只用 `git pull --ff-only`；**不要把 `reset --hard` 当默认排障步骤**。
- 签名材料（证书、Profile、密钥库、密码）**不得提交**到仓库。

**原因**：真源/工作成果不在任何会被推送的版本库里 → 迟早丢失。前作「统一规则」系统的真源仓 `Center` 与同步脚本正是因为从未推送而整体消失，是本次重建规则的直接教训。

**违反后果**：成果丢失；或误推上游造成对外事故、污染公开 fork。

---

### L0-8 子代理模型与并发纪律 (MUST) ｜本仓群专用（**修正前作过时条目**）

**规则**：
- 本仓群的子代理**一律使用能力较低的小模型**，禁止用旗舰模型做子代理。当前指定：`DeepSeek-V4-Flash[free]`（模型 ID `claude-haiku-4-5-20251001`）。**禁止使用 Kimi K3 做子代理**。
- 子代理**并发控制在 ≤3**：本机走免费端点，实测 6 并发即出现 `502` 熔断。失败时**先落盘部分结果再重试**。
- 子代理任务必须**自包含**：明确检索范围、具体问题、期望输出。

**原因**：子代理承担的是"读多写少"的检索/提炼工作，小模型成本低且够用；旗舰模型用于主脑判断。免费端点有并发熔断。

**违反后果**：成本浪费与端点熔断；任务中断且中间结果丢失。

> **修正记录**：前作 v1.0.0 §5 写 `gemini-3-flash-preview`、§9 又写 `claude-sonnet-4`，自相矛盾。本条为唯一有效版本。

---

### L0-9 宿主适配只许进桥接层 (MUST) ｜仓群实践

**规则**：平台差异（SillyTavern / Luker / PureTavern / TauriTavern）必须集中在**单一 host-bridge 模块**内处理，不得散落到业务层。

**原因**：四个宿主的 API 面差异大且各自演进；散落判断会导致每加一个宿主就要改遍全仓。

**违反后果**：新增宿主支持变成全仓大改；宿主差异判断互相矛盾。

---

### L0-10 宿主 CSS 作用域纪律 (MUST) ｜仓群实践（**有真实事故**）

**规则**：注入宿主的样式**严禁全局选择器泄漏**——不得使用 `*` / `body` / `:root` / 裸酒馆原生类名；所有自定义类必须带**双前缀**；配色一律继承宿主变量（`--SmartTheme*`）并提供回退值，**禁止硬编码颜色**。

**原因**：插件样式泄漏会污染整个酒馆 UI。**2026-09 已在本仓群实际发生并修复过一次**（`ST-zip-converter/AGENTS.md:51` 记有该事故）。

**违反后果**：宿主人机界面被破坏，用户直接可见的故障。

---

### L0-11 纯前端优先 + 适配器降级 (MUST) ｜与全局同源（仓群多仓独立收敛）

**规则**：纯前端项目引入服务端能力时，一律走「**适配器 + 特性检测 + 静默降级**」：后端可用时增强，不可用时纯前端路径（IndexedDB / OPFS / 内存）**保持全功能**。后端调用必须 fire-and-forget 或显式降级，**严禁纯前端主路径阻塞或失败于后端不可用**。适配器通过依赖注入接缝与核心状态机对接，核心层不感知后端存在。

**原因**：`SillyTavern-Timelines` 与 `PureTavern` 两个仓**各自独立收敛到同一模式**，说明这是用户的实际设计偏好而非偶然。`Authority` 自身即此范式的样板（Host Bridge 失败仅 `console.warn`，不阻断插件加载）。

**违反后果**：用户没装后端就整个插件不可用——违背"插件可独立运行"的产品定位。

---

### L0-12 跨宿主插件禁用 Host Bridge (MUST) ｜**本仓群新增硬约束**（2026-09 判定）

**规则**：需要**跨宿主**（SillyTavern + Luker 等）运行的插件，**禁止依赖 Authority 的 Host Bridge**（宿主补丁路径）。必须使用 Authority 的**可移植子集**（SQL / KV / Blob / 文件 / HTTP / Jobs / Events / Trivium 的公开适配层 API），并在代码里显式标注所用能力的宿主可用性。

**原因**：Host Bridge 是**逐宿主打补丁**的机制——它按宿主版本号做门禁（`supportedPackageVersions: ["1.18.0"]`）且补丁面在宿主间分叉。Luker 上实测被版本门禁拒绝。但 Authority 的**能力内核与宿主解耦**（Host Bridge 失败仅 `console.warn`，不阻断插件加载），所以禁用 Host Bridge 不会损失核心能力。

**违反后果**：插件在 Luker 上静默失去聊天修订/事务语义，产生**难以排查的数据不一致**（表现为功能时好时坏，而非直接报错）。

---

### L0-13 测试即质量门、零回归 (MUST) ｜仓群实践

**规则**：发版前测试必须全绿，**不接受回退**。改动涉及构建/产物时，必须跑对应的产物一致性校验（Authority 仓为 `npm run sync:installable && npm run check:installable`）。端到端测试**只允许对 Dev 实例**运行。

**原因**：本仓群已有以测试规模换稳定性的先例（`ST-shujuku-rebuild` 约 7700 条用例、零回退）。

**违反后果**：回归上线；对 Real 实例跑 E2E 会污染真实数据（触发 L0-1 红线）。

---

### L0-14 文档先行 (SHOULD) ｜仓群实践

**规则**：改动前先读 `.trellis/spec/` 中对应层的规范；复杂功能先写设计文档再写代码。工具/插件的对外说明必须与实现同步更新。

**原因**：spec 是跨会话、跨 agent 的知识载体；不先读就会重复踩已经记录过的坑。

**违反后果**：重复踩坑，且经验无法沉淀。

---

### L0-15 中文（文档 / 注释 / 回复）(SHOULD) ｜与全局同源

**规则**：文档、代码注释、与用户的回复**一律中文**（代码标识符、命令输出、专有名词除外）。

**原因**：用户为中文母语者；且本仓群文档现状已全部中文（与 Trellis spec 模板默认的"English only"相反，属**有意覆盖模板默认**）。

**违反后果**：可读性下降，用户需要额外翻译成本。

---

### L0-16 端口申请段位（实例段独占 · 出厂默认禁用 · 周边工具自 3010 起）(MUST) ｜仓群实践（2026-09 定稿）

**规则**：酒馆生态的端口按段位管理，新服务选端口前必须对照：
- **实例段 `8001–8004` 独占**（8001 Dev ST / 8002 Real ST / 8003 Dev Luker / 8004 Real Luker），禁止挪用；
- **`8000` 为出厂默认，禁止直接使用**：任何脚本/CI/服务启动不得绑定或请求 8000，需要 ST 兼容默认值的场景必须显式覆盖环境变量/配置（不改上游分发物）；
- **`3000` 划归系统保留**：任何酒馆项目不再使用（实测被系统 `svchost` 实占，且多个工具默认撞车）；
- **周边工具自 `3010` 起申请**（Tavern-Viewer → 3010、TavernHeadless → 3020、PureTavern remote-server 显式注入 3030），间隔 10 为后续同类工具留号；
- 已登记独占端口：`8899`（PureTavern web dev，`strictPort`）、`4173`（Vite preview）、`8233`（nocturne 后端内部）、`6080`（noVNC）。

**原因**：8000 六处出厂默认互抢、3000 三方撞车（工具默认 + 系统实占）都是实测形态；且 Dev/Real 实例仅差 1 个端口，端口混乱直接放大误连真实数据的风险（P-11/P-14/P-15）。

**违反后果**：服务按默认配置启动必然失败；或误占实例段端口造成误连真实数据区（不可逆）。

---

### L0-17 Trellis 工程纪律（交付物落点 · 市场源）(MUST) ｜仓群实践（2026-09-25 实证）

**规则**：

**(1) 任务交付物的落点与范围门。** Trellis 管理的仓里，`.gitignore` 普遍排除 `.trellis/tasks/` 与 `.trellis/workspace/`，但**保留** `.trellis/spec/`。因此：

- 任务收口时，**规范条文必须落 `.trellis/spec/`**；任务目录（`prd.md` / `design.md` / `deliverables/` / `research/`）只作工作副本，**不是持久化载体**。
- **spec 页面必须自包含**（内联条文与 file:line 证据），**不得**写"详见任务目录的 xxx"——那在其他机器上就是悬空引用。
- 判断"有无改动产品代码"用 **`git status --short` 输出为空**；**不得**用 `git diff --stat` 判断"改动是否只在任务目录"——被忽略的目录**根本不出现在 diff 里**。

**(2) Trellis 市场源须用 SSH 形式。** Trellis 的模板/工作流市场源语法为 `provider:user/repo[/subdir][#ref]`；`gh:` / `github:` 前缀走 `raw.githubusercontent.com`，**对私有仓返回 404**，且其 git 回退（`preferGit`）**仅**对 SSH / 自建 host 触发。故私有仓作市场源必须写成 `git@github.com:<owner>/<repo>`。

**原因**：

- （1）2026-09-25 在 `ST-Delegation-of-authority` 的治理规划收口时实测——`.gitignore` 排除 `.trellis/tasks/`（提交 `4f0193e`「公开 fork 防泄露」），任务目录交付物**不进 git、不推送**，随归档即不可见，与 P-1 同形；且用 `git diff --stat` 做范围门**永远得到空结果**，看起来像"什么都没改"。
- （2）同日实测：`raw.githubusercontent.com` 本机可达（HTTP 200 / 0.65s），但 `jiozhaoyue/tavern-harness` 为**私有仓**，其 raw 路径返回 **404**；Trellis 源码 `dist/utils/workflow-resolver.js` 的 `parseRegistrySource` 对 `gh:` 走 HTTP，**不自动回退 git**。

**违反后果**：

- （1）成果随任务归档消失（复现 P-1）；或 spec 引用悬空、agent **静默拿不到规范**（P-4 同形）；范围门失效导致误判"没动产品代码"。
- （2）按 `gh:` 形式配置市场源必然失败，且报错形态是 404 / 需认证，易被误判为网络问题而反复排查。

## L1 仓群规则 — My-repo（酒馆扩展 / 工具插件形态）

> 适用于 `My-repo` 仓群（ST-BgLoader、ST-Switcher、ST-chatfilesys-rebuild、ST-git-improve、ST-shujuku-rebuild、ST-zip-converter 等）。
> 这些项目是**发给别人装进酒馆的扩展/工具插件**，因此额外承担"不能弄坏别人酒馆"的责任。

### L1-MR-1 插件必须可独立运行，后端增强只能可降级 (MUST)

**规则**：任何功能的主路径必须在**纯浏览器**闭环可用。服务端（Authority 等）只作可选增强层，走「适配器 + 特性检测 + 静默降级」（见 L0-11）。扩展被装进一个没装后端、甚至没联网的酒馆时，必须依然工作。

**原因**：用户明确的项目定位——"既然开发了触及基础的插件，不去利用起来变得有高级功能，就可惜了"，但前提是**不耦合**。`ST-zip-converter` 已在 2026-09-21 明确裁定"纯前端为主、Authority 为可选增强层，不转向前后端混合架构"。

**违反后果**：用户没装后端时插件整体不可用 → 直接违背产品定位。

---

### L1-MR-2 事实源必须在酒馆服务端原生目录 (MUST)

**规则**：需要持久保存的用户资产（背景、主题、数据包等），**事实源一律放在酒馆服务端的原生目录**（如 `data/<user>/backgrounds/`），与酒馆原生文件同一逻辑同一位置。浏览器 `CacheStorage` / `IndexedDB` **只配当缓存**，且必须可清理、可重建。

**原因**：**2026-09-13 用户亲自纠正过错误方向**——`ST-BgLoader` 一度走"浏览器优先"路线，被判定是错的，随后做了存储倒置重构。浏览器存储会被清、会丢、用户看不见，不是"用户的文件"。

**违反后果**：用户资产变成"藏在浏览器里的东西"，换设备/清缓存即丢失，且用户无法管理。

---

### L1-MR-3 CSS 双前缀铁律 + CI 自查 (MUST)

**规则**：扩展注入宿主的样式表，**每条规则都必须带本扩展专属前缀**（如 `.app-container` 独立态 / `.st-converter-drawer-app` 插件态）。**严禁**裸选择器（`.menu_button`、`.inline-drawer`、`.text_pole`、`.checkbox_label` 等酒馆全站类）、`*`、`body`、`:root`。配色一律 `var(--SmartTheme*, 回退值)`，禁止硬编码。

**自查**：`grep '^\.' style.css | grep -vc 'app-container\|<本扩展前缀>'` 必须为 **0**。

**原因**：**2026-09 已实际发生并修复过一次全站 UI 污染事故**（记录在 `ST-zip-converter/AGENTS.md`）。酒馆是单页应用，注入的 CSS 与宿主共享同一文档。

**违反后果**：用户整个酒馆界面被破坏——可见故障，且用户会认为是酒馆本身坏了。

---

### L1-MR-4 UI 落点只认官方文档记载的位置 (MUST)

**规则**：
- 扩展**设置页只放设置**，不要塞复杂交互界面。
- 复杂 UI 用**官方 Popup** 呈现，不要自造浮层。
- 需要注入在消息旁的内容，**挂官方 RENDERED 事件**，不要自己监听 DOM 变动。

**"不在官方文档里的位置，就是禁止的位置。"**

**原因**：宿主 DOM 结构会随版本变动；非官方挂载点没有兼容性承诺，且容易与其他扩展冲突。

**违反后果**：宿主升级后扩展 UI 消失或错位——而且是在用户那边才暴露。

---

### L1-MR-5 API 事实以官方文档为准，禁止翻源码找 API (MUST)

**规则**：写调用宿主/框架 API 的代码时，依据**官方文档**；**不得**通过阅读宿主源码去"发现"API 用法，也不得凭记忆写。

**原因**：宿主源码里的内部函数不构成公开契约，随版本可改。

**违反后果**：写出依赖内部实现的代码，宿主升级即碎。

---

### L1-MR-6 三形态同构（一套核心，三种入口）(SHOULD)

**规则**：同一份纯逻辑核心应能跑在三种入口——① 独立 Web 页（`index.html`）② 酒馆扩展插件（host-bridge 注入）③ Node 测试环境（无 `Worker` 时自动主线程降级）。纯逻辑层**禁止 DOM 依赖**。

**原因**：这是本仓群已验证的架构（`ST-zip-converter` 的 `src/core` 三形态同构），使核心逻辑可 100% 单测、且不因宿主差异而分叉。

**违反后果**：核心逻辑无法单测，只能靠手工点界面验证。

---

### L1-MR-7 有界等待：任何 await 都必须能 settle (MUST)

**规则**：对 DOM 媒体事件（`canplay`/`error`/`onload`）、跨源 `fetch()`、渲染/挂载 promise 的 `await`，**必须经超时或 destroy 信号兜底 settle**。**禁止让渲染/挂载 promise 永远 pending**。

**原因**：实测挂死案例——`IframeRenderer.render` 只等 `onload`，快速切换时 iframe 被 destroy，promise 永久悬置，导致测试挂死（stress test 3）。

**违反后果**：测试卡死或生产环境静默挂起，极难定位。

---

### L1-MR-8 Worker 生命周期：terminate 后必须置空引用 (MUST)

**规则**：`worker.terminate()` 之后**必须**把持有该 Worker 的变量重置为 `null`（或等价失效标记）。被 terminate 的 Worker 会**静默忽略**所有后续 `postMessage`。另注意 `AbortSignal` **不能** `postMessage`，须在主线程监听。

**原因**：实测事故（commit `034b7ab`）——忘记重置导致此后**每一次**转换都永久静默挂死。

**违反后果**：功能"看起来没报错但就是不动"，排查成本极高。

---

### L1-MR-9 高频进度回调必须 rAF 合帧 (MUST)

**规则**：流式/高频回调（如 ~50 chunk/秒的进度更新）驱动 DOM 时，必须先合帧（`requestAnimationFrame`），不得同步触发重排/重绘。

**原因**：实测累积 14 个 80–107ms 长任务，直接卡顿宿主页面。

**违反后果**：宿主整页卡顿，用户体感为"我酒馆好卡"。

---

### L1-MR-10 多入口产物必须同源同改 (MUST)

**规则**：同一 UI 若存在**两份独立维护的副本**（典型：独立态的 `index.html` 与插件态的模板文件），结构改动**必须在同一次提交内同时改两处**，并加自查（如 `grep -c "<new-id>" index.html src/ui/workbench-template.js` 两处均须 ≥1）。

**原因**：`ST-zip-converter` 的 `index.html` 与 `src/ui/workbench-template.js` 是同 UI 两份副本，只改一处会让独立模式断裂。

**违反后果**：某一种入口模式下功能缺失，且平时不易发现。

---

### L1-MR-11 依赖自包含：装完即可用，不需要用户跑构建 (MUST)

**规则**：通过酒馆"扩展管理器 Git URL 一键克隆"安装后，**不得**要求用户执行 `npm install` / `npm run build`。第三方库（zip.js、fzstd 等）以**本地封装副本**形式放进 `src/vendor/` 并标明**勿升级改动**，只用已有 API。

**原因**：用户安装路径就是"填一个 Git URL"，任何额外构建步骤都会变成 `Failed to resolve module specifier` 报错。

**违反后果**：插件在用户机器上装不起来。

---

### L1-MR-12 宿主目录约定：Luker 扩展平铺，禁止嵌套 third-party (MUST)

**规则**：Luker 用户私有扩展放 `data/<user>/extensions/<name>/`（**平铺，绝不嵌套 `third-party`**）；全局扩展放 `public/scripts/extensions/third-party/<name>/`。

**原因**：实测发现，嵌套成 `third-party/third-party` 会让该目录下**所有**子插件全军覆没。

**违反后果**：一次性弄坏用户安装的全部扩展。

---

### L1-MR-13 质量门槛：`npm test` 全绿 (MUST)

**规则**：发版前测试必须全绿、零回归。常用命令：
```bash
npm test                          # 全量（例：ST-zip-converter 187 项 / 30 文件）
npx vitest run test/xxx.test.js   # 单文件
npx vitest run -t "用例名"         # 单条用例
```
部分项目无独立 lint/typecheck——类型契约靠 JSDoc + 运行时守卫，**质量门槛就是 `npm test` 全绿**。

**原因**：见 L0-13。

**违反后果**：回归上线。

---

### L1-MR-14 开源安全基线 (MUST)

**规则**：提交前确认——零个人隐私（本地绝对路径、真名、私有邮箱）、零凭据、真实数据彻底隔离（`*.zip` / `data-zip/` / `data-*/` / `samples/` 严禁入库）、Git 提交使用隐私中继邮箱。

**原因**：本仓群多数是要公开发布/开源的插件，泄露不可撤回。

**违反后果**：个人路径与真实聊天数据永久留存在公开仓库历史里。

## 坑与教训（跨仓真实案例）

> **收录标准**：每条必须**带真实案例与后果**（"违反会怎样"）。只有标题没有正文的条目一律不收——前作规则体系正是这样腐烂的。
> 影响**多个仓**的坑进本节；只影响单仓的坑留在该仓 `AGENTS.md` 的自有区域（块外）。

### P-1 规则真源不在会被推送的版本库里 → 整体消失

**案例**：前作统一规则系统（v1.0.0，2026-09-12）把真源放在 `Tavern-repo/Center/`——**一个不属任何仓库、从未推送的平级目录**。结果：`Center/` 目录与 `sync-rules.ps1` 脚本**双双消失**，只剩 3 个仓库里内容相同、且被同步器截断的残留块。

**后果**：整套规则系统归零，且无处可恢复。

**防护**：真源必须落在**带 remote 且实际推送**的 Git 仓（本仓 `tavern-harness`）；副本块自包含，即使真源丢失副本仍可用。

---

### P-2 同步器有损（截断）比"不同步"更糟

**案例**：前作块内**大量章节只剩标题**——"**禁止的命令**:" 后为空、FAQ 只剩 "A:"。同步器做了有损摘要/截断，且无校验。

**后果**：agent 读到"半截规则"，比没有规则更危险（会误以为规则已覆盖）。

**防护**：块**原样承载完整正文**，禁止任何摘要；同步后以内容哈希校验；`--verify` 可随时检测漂移。

---

### P-3 规则条目自相矛盾且过时 → 无人可信

**案例**：前作 §5 写"子代理模型 `gemini-3-flash-preview`"，§9 又写"本项目用 `claude-sonnet-4`"；实例路径写作 `D:\Repo\Instance\Real\Luker`（实为 `D:\Repo\Tavern-repo\Instance\Real\Luker`，且**根本没有 `Test` 目录**）。

**后果**：规则失去权威性，agent 各取所需，等于没有规则。

**防护**：同一事实只允许有一处权威表述；过时条目在同步时修正并记录（见本文件末"变更记录"）。

---

### P-4 符号链接 / `@` 引用分发：失效是静默的

**案例**：`JS-Slash-Runner` 仓群真源为 `.cursor/rules/*.mdc` 八件套，各项目的 `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` 是 10 行 `@` 引用，其余平台文件是符号链接（25 条 mode `120000` 已入 git）。实测：**5 个项目中只有 1 个存在真源** → `ST-msg-btn-mgr`、`tavern_helper_template` 的 8 行引用**全部悬空**。

**后果**：文件本身看起来完好，agent **静默拿不到任何规则**、不报错。比"内容截断"更隐蔽。

**防护**：不用符号链接/`@` 引用分发统一规则；用**自包含块**（块内不引用任何外部路径）。

**同一坑的第二次事故（2026-09-21，本次建设过程中）**：新同步器按"文件名"逐个写入时，
把 `AGENTS.md`、`CLAUDE.md`、`GEMINI.md` 当成三个目标——但它们其实是**同一个物理文件**
（前者是后者的符号链接）→ **同一个文件被写入三次，叠出三个规则块**。

**教训**：处理"多文件分发"时，**必须按物理路径（realpath）去重**，不能信任文件名。
符号链接的坑不只在"分发方式"上，也在"消费方"上。

---

### P-5 裸 CSS 选择器污染整个酒馆 UI（已实际发生）

**案例**：`ST-zip-converter` 的 `style.css` 使用了酒馆全站类名（`.menu_button` / `.inline-drawer` / `.text_pole` / `.checkbox_label` 等）的裸选择器。**2026-09 实测发生并修复**，此后定为"双前缀铁律"。

**后果**：用户整个酒馆界面被破坏——用户会认为"酒馆本身坏了"。

**防护**：见 L1-MR-3；CI 自查 grep 必须为 0。

---

### P-6 Worker terminate 后未置空引用 → 此后每次调用永久静默挂死

**案例**：`ST-zip-converter` 中 `worker.terminate()` 之后未把 `workerInstance` 置回 `null`（commit `034b7ab`）。被 terminate 的 Worker 会**静默忽略**所有 `postMessage`。

**后果**：功能"不报错但就是不动"，且**每一次后续转换都挂死**，排查成本极高。

**防护**：见 L1-MR-8。

---

### P-7 无界等待（promise 永不 settle）→ 测试挂死

**案例**：`ST-zip-converter` 的 `IframeRenderer.render` 只等 iframe `onload`；快速切换时 iframe 被 destroy，promise **永久悬置**，导致 stress test 3 挂死。

**后果**：测试卡死，CI 无法收敛。

**防护**：见 L1-MR-7（有界等待）。

---

### P-8 高频回调未合帧 → 宿主整页卡顿

**案例**：`ST-zip-converter` 流式 fetch 约 50 chunk/秒，同步调用 `setProgress` 累积出 **14 个 80–107ms 长任务**。

**后果**：宿主页面可感知卡顿。

**防护**：见 L1-MR-9（rAF 合帧）。

---

### P-9 把"浏览器存储"当事实源 → 方向性返工

**案例**：`ST-BgLoader` 一度按"浏览器优先"设计媒体存储，**2026-09-13 被用户当面纠正**："媒体从设计上就该存酒馆服务端原生目录"，随后做了存储倒置重构。

**后果**：大量返工；用户资产变成"藏在浏览器里、用户看不见也管不了"的东西。

**防护**：见 L1-MR-2（事实源在服务端原生目录）。

---

### P-10 Luker 扩展目录嵌套 `third-party` → 该目录下所有子插件覆没

**案例**：Luker 用户私有扩展应平铺在 `data/<user>/extensions/<name>/`。若嵌套成 `third-party/third-party`，该目录下**所有**子插件失效。

**后果**：一次性弄坏用户安装的全部扩展。

**防护**：见 L1-MR-12。

---

### P-11 Dev / Real 实例只差一个端口号 → 误连真实数据

**案例**：本机实测端口为顺序分配且**无冲突**：`8001` Dev ST / `8002` Real ST / `8003` Dev Luker / `8004` Real Luker。且 Dev 与 Real 的**宿主版本完全一致**——版本号无法用于区分。

**后果**：自动化脚本指向 Real 侧的端口即操作真实聊天数据（GB 级、上千个会话），**不可逆**。这是当前环境的最大风险点，且**风险不是端口冲突而是误连**。

**防护**：见 L0-1 与 L1-MF-10；E2E 只允许对 `Instance/Dev/**`。

---

### P-12 本地实例仓的 `origin` 可能误指上游

**案例**：本机某个从上游 fork 出来的宿主实例仓，其 `origin` 指向了**上游仓库**（而该 fork 自己的 remote 另起了名字）。

**后果**：在该目录执行 `git push origin` **会误推上游仓库**——对外事故。

**防护**：见 L1-MF-1。推送前先 `git remote -v` 确认 `origin` 是谁；修复前**不要**在该目录做任何 push。

---

### P-13 把内部实现当公开 API（翻源码找 API）

**案例**：宿主源码中的内部函数不构成公开契约，随版本可改。

**后果**：宿主升级后代码静默失效。

**防护**：见 L1-MR-5（API 事实以官方文档为准）。

---

### P-14 8000 出厂默认值六处互抢

**案例**：本机六处配置使用 ST 出厂默认 8000（Luker 两份 compose、ST/Luker 两份 `default/config.yaml`、PureTavern remote-server 默认、TauriTavern default），任何两个同时启动即互抢端口。

**后果**：服务按出厂默认启动必然失败，且报错形态是「端口被占」而非「配置撞车」，排查时容易误判。

**防护**：见 L0-16。8000 标记「出厂默认、禁止直接使用」；启动必须显式指定端口，不改上游分发物。

---

### P-15 3000 三方撞车 + 系统实占

**案例**：Tavern-Viewer 与 TavernHeadless 均默认 3000，且该端口被系统 `svchost` 实占——两个工具按默认配置启动**必然失败**（谁先启动谁占，后到者挂）。

**后果**：工具启动即失败；若误以为「端口被占是残留进程」而反复清理，会浪费时间且可能误杀系统进程。

**防护**：见 L0-16。3000 划归系统保留；周边工具按段位自 3010 起申请（Viewer→3010、Headless→3020）。

---

### P-16 Dev/Real 目录名不可假设语义（TauriTavern 倒挂实例）

**案例**：`Instance/Dev/TauriTavern` 一度是**残缺仓**（src-tauri 等 1289 个被跟踪文件被从工作区删除），而 `Instance/Real/TauriTavern` 反而完整——与「Dev 完整、Real 是数据区」的直觉**完全倒挂**。

**后果**：若按目录名假设「Dev 一定可构建」，E2E 测试目标会在构建阶段静默失败；反向假设「Real 不完整不能碰」也会漏掉真实数据风险。

**防护**：见 L1-MF-10。实例状态以**现场取证**为准（git status / 文件清单），不以目录名推断；E2E 目标必须先验证端口白名单与实例实际可用性。

---

### 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v1.2.0 | 2026-09-25 | 新增 L0-17「Trellis 工程纪律（交付物落点 · 市场源）」；修正 `ST-shujuku-rebuild` 的记账路径 |
| v1.1.0 | 2026-09-21 | 首次以「自包含块」形式发布；修正前作过时条目（实例路径、子代理模型）；新增 L0-12「跨宿主插件禁用 Host Bridge」；新增本节「坑与教训」并强制「每条带后果」 |

## 项目覆盖

<!-- TAVERN-RULES:END -->
