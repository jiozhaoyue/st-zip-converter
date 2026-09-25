# 样式越界与 dev 端口占位修复（酒馆原生外观 / env-sync 顶替）

## Goal

修三件事：① style.css 以 body 为主体的独立态规则（body:has(> .app-container)，含渐变）会落到宿主/第三方容器上，改变酒馆原生弹窗与控件外观；② 插件自身配色必须继承酒馆 --SmartTheme* 变量，去除渐变与硬编码颜色；③ 本仓 vite dev 占用 5173，与 env-sync 的 Tauri devUrl 同端口，导致其 GUI 窗口被本插件页面顶替

## Background（2026-09-25 现场取证）

用户报告三件事，其中**一件已确证、一件是铁律级隐患、一件待复现**：

### B1 ✅ **已确证**：本仓 dev server 占用 5173，把 env-sync 的 GUI 顶替了

- `curl http://localhost:5173/` → `<title>st-zip-converter</title>`（本仓 Vite dev server，
  进程 `node .../ST-zip-converter/node_modules/vite/bin/vite.js`，监听 `[::1]:5173`）。
- env-sync 的 Tauri 配置：`app/src-tauri/tauri.conf.json:8` **`"devUrl": "http://localhost:5173"`**，
  `beforeDevCommand: pnpm --dir ../webapp dev`，而 `app/webapp/package.json` 的 `dev` 是**裸 `vite`**
  （Vite 默认端口就是 5173）。
- 结果：启动 env-sync 桌面应用（dev 态）→ 窗口加载 `localhost:5173` → 解析到 `::1` → **拿到本插件的页面**
  ⇒ 用户所见「GUI 的 UI 直接变成插件内容」。env-sync 的 webapp 自己跑在 5174（`--port 5174 --strictPort`），
  所以「webui 没变」——与现象完全吻合。
- **根因**：本仓 dev server 用了 Vite 默认端口，未按 L0-16 段位申请独立端口。

### B2 ⚠ **铁律级隐患 + 守卫盲点**：以 `body` 为主体的规则

`style.css` 存在三条以 `body` 为主体的规则（均含 `.app-container`，故能通过 `check:css-scope`）：

| 行 | 选择器 | 问题 |
| --- | --- | --- |
| `style.css:68` | `body:has(> .app-container)` | **主体是 `body`**；`background` 用了 3 层渐变 + `rgba()` 硬编码 |
| `style.css:1798` | `body:has(> .app-container)`（媒体查询内） | 同上 |
| `style.css:1961` | `body:has(> .st-converter-modal-overlay) .app-container` | 以 `body:has` 作门控 |

- 这条规则**含** `.app-container` 字样 → 通过 `check:css-scope` 的「含双前缀」字符串检查，
  **但语义主体是 `body`**：只要宿主页面的 `body` 下出现 `.app-container` 直接子元素，本插件的
  独立态骨架（渐变背景、`font-family`、`line-height`）就会落到**宿主 body** 上。
- 宿主仓内确有第三方使用该类名（`Instance/Dev/Luker/public/scripts/extensions/` 下
  `card-app/style.css`、`card-app/loader.js`、`character-editor-assistant/studio/ai-chat.js`）。
- **本次未复现**：Dev Luker 8003 当前页面上 `body:has(> .app-container)` 命中为 `false`、
  `.app-container` 计数 0、`body` 的 `background-image: none`（探针 `research/pw-scope-hit-probe.cjs`
  → `research/scope-hit.json`）。故「宿主原生弹窗被加渐变」的**触发路径待复现**（OQ-1）——
  **未复现前不得宣称已修**。

### B3 ✅ 已核对：插件自身确实用渐变与硬编码颜色（违反 L0-10）

- `style.css` 共 **8 处 `gradient`**（其中 3 处为 `rgba()` 硬编码：
  `rgba(192,132,252,.04)`、`rgba(13,16,23,.98)`、`rgba(217,119,6,.3)`、`rgba(180,83,9,.4)`）。
- `host-bridge.js` 的扩展安装器模态**挂到 `document.body`** 并用内联 `style.cssText`
  写死深色配色（`#cdd6f4`/`#a6e3a1`/`#f9e2af`/`#11111b`/`#89b4fa` …），不继承宿主主题。
- 用户明确要求：「插件本身也不要出现这种，必须按酒馆颜色」。

### B4 相关事实（避免误判）

- 插件的样式**没有**泄漏到宿主：`style.css` 323 条规则中除 B2 三条外，其余命中的元素
  全在插件容器内（探针 `.../09-25-batch-restore-luker-endpoint/research/pw-style-leak-probe.cjs`）。
- 插件在 8003 上**确实已加载**（`#st_zip_converter_settings` / `#st-zip-converter-menu-item` /
  `#app.st-converter-drawer-app` 均在 DOM 中，`index.js`/`style.css` HTTP 200）；
  页面上的 3 个 404 属其他插件（`/api/plugins/server-plugin-manager/probe`、`/api/plugins/command-exec/sandbox/get`）。

## Requirements

- **R1（P0）dev/preview 端口不得占用 5173**：本仓 `npm run dev` / `preview` 必须绑定
  **L0-16 登记的独立端口**并 `strictPort`（建议 `3040`，与 Tavern-Viewer 3010 / TavernHeadless 3020 /
  PureTavern remote-server 3030 同列，间隔 10）；同时在 L0-16 与 README 登记。
- **R2（P0）消灭以 `body`/`html`/`:root`/`*` 为主体的规则**：独立态骨架改为以独立态根为主体
  （`#app`/`.app-container` 作主体，不得用 `body:has(...)` 兜主体）；
  `style.css:68/1798/1961` 三处必须改写或删除。
- **R3（P0）修补 `check:css-scope` 守卫的盲点**：「选择器含双前缀」不足以保证作用域——
  必须新增检查：**任一规则的主体（最后一个复合选择器）不得是 `body`/`html`/`:root`/`*`**，
  并加负例单测（`body:has(> .app-container) { … }` 必须被判失败）。
- **R4（P1）配色全部走宿主变量**：去净 `gradient`（8 处）与硬编码 `rgba()`/hex；
  一律 `var(--SmartTheme*, 回退值)`（L0-10）。扩展安装器模态二选一并写明取舍：
  （a）改用宿主原生 Popup（长期正确，改动大）；（b）保留自绘但继承宿主变量（本次小步）。
- **R5（P1）env-sync 侧只改本仓**：不动 env-sync 仓——由本仓让出 5173 即可；
  若用户仍希望 env-sync 显式声明端口，记为下游建议而非本任务改动。
- **R6（P0）复现优先**：OQ-1 的触发路径必须先复现（哪个扩展/操作让宿主 `body` 出现 `.app-container`），
  再动手改；无法复现则按「隐患消除 + 守卫补洞」交付，并在报告中如实说明**未复现**。

## Acceptance Criteria

> 回填方式：逐条现场取证（命令输出 / file:line / 实机读数），不得事后凭记忆勾选（L0-2）。

- [ ] B1 修复：`npm run dev` 在登记端口启动且 `strictPort` 生效（命令输出为证）；
  同机 `localhost:5173` 不再是本仓页面（复查 `<title>`）。
- [ ] env-sync dev 窗口加载到的是 **env-sync 自己的 UI**（DOM/标题取证），不再是插件页面。
- [ ] `style.css` 内**零**以 `body`/`html`/`:root`/`*` 为主体的规则（含 `body:has(...)` 形式）。
- [ ] `check:css-scope` 新增「主体不得为全局元素」检查，且有负例单测（改前应失败、改后通过）。
- [ ] `style.css` 零 `gradient`；硬编码颜色仅允许出现在 `var(..., 回退值)` 中（grep 复核）。
- [ ] 扩展安装器模态不再把自绘深色配色写死在 `document.body` 上（继承宿主变量或改原生 Popup）。
- [ ] OQ-1 复现结论落 `research/`：**复现成功**（给出触发路径 + 修复前后宿主 body 计算样式对比）
  或**如实标注未复现**（不得写成「已修」）。
- [ ] `npm test` 全绿（基线 **44 文件 / 406 passed / 2 skipped**，不得回退）+ 四条守卫退出码 0。
- [ ] L0-16 与 README 登记本仓 dev/preview 端口。

## Out of Scope

- 不改 env-sync 仓（含其 `tauri.conf.json` 的 `devUrl`）——本仓让出端口即可。
- 不重构整份样式体系（只做作用域纠正 + 去渐变/去硬编码）。
- 不改 `src/vendor/**`；不引入构建步骤（L1-MR-11）。

## Open Questions

- **OQ-1**：「宿主原生弹窗被加渐变」的**具体触发路径**是什么？（哪个扩展/操作让宿主 `body` 下出现
  `.app-container`；也可能是别的原因——需先复现再归因。）
- **OQ-2**：登记端口取 `3040` 是否可用（先探测占用），是否需要同时给 `preview` 另行登记
  （现有 4173 已登记为 Vite preview——确认本仓是否沿用 4173）。
- **OQ-3**：安装器模态走 (a) 宿主原生 Popup 还是 (b) 自绘 + 继承变量（影响改动量与后续一致性）。
- **OQ-4**：`#app.st-converter-drawer-app` 与独立态的 `#app.app-container` 共用 `#app` 这个 id，
  是否存在同页冲突风险（待核）。
