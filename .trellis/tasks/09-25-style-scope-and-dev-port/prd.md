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

> 回填方式：逐条现场取证（命令输出 / file:line / 实机读数），2026-09-25 收口时回填；
> 未取证者保持未勾选并记入残留（不得以「已归档」推断已完成）。

- [x] B1 修复：dev/preview 绑定登记端口且 `strictPort` 生效。
  **证据**：`npm run dev` 输出 `➜ Local: http://localhost:3040/`；`netstat` 显示
  `[::1]:3040 LISTENING`；`vite.config.js` 声明 `server.port=3040` + `strictPort:true`、
  `preview.port=4173` + `strictPort:true`。
- [x] env-sync 地址不再被本仓占用。
  **证据**：修复前 `curl http://localhost:5173/` → `<title>st-zip-converter</title>`；
  收口时 5173 无监听（`netstat` 仅剩 env-sync 自己的 5174），本仓 dev 改在 3040。
  ——**待用户侧确认**：env-sync dev 窗口恢复（见残留 R-4）。
- [x] `style.css` 内零以 `body`/`html`/`:root`/`*` 为主体的规则。
  **证据**：探针脚本自测 + 守卫通过；`test/css-scope.test.js` 断言去注释后
  `not.toContain('body:has(')` 且 `not.toMatch(/(^|\})\s*(?:body|html|:root|\*)\s*[,{]/)`。
- [x] `check:css-scope` 新增「主体不得为全局元素」检查，且有负例单测。
  **证据**：`scripts/css-scope.js` 增 `GLOBAL_SUBJECT` + `subjectOf()`；
  `test/css-scope.test.js` **16 例**（含 `body:has(> .app-container)`、`body 作门控的模态规则`、
  `.app-container, body`、`html body …`、裸 `*`、`:root` 等负例，改前会通过、改后全部拦截）。
- [x] `style.css` 零 `gradient`。
  **证据**：`grep -c gradient style.css` = **0**（改前 8 处；修饰性高光条改纯色 `var(--accent)`，
  单条 `opacity: 0.4` 保留层次）。
- [x] 扩展安装器模态不再把自绘深色配色写死在 body 级元素上。
  **证据**：`src/ui/host-bridge.js` 安装器模态的**表面/文字/强调**色全部改
  `var(--SmartTheme*, 回退)`（`--SmartThemeBlurTintColor` / `--SmartThemeBodyColorInverted` /
  `--SmartThemeQuoteColor` / `--SmartThemeBorderColor` / `--SmartThemeBodyColor`）；
  JS 侧 `style.color`（不接受 `var()`）改经 `themeAccent()` 读取真实值；
  成功/告警/危险三个语义色在宿主无官方变量记载（L1-MR-5），保留字面量并集中说明。
- [x] **追加（本次新发现，超出原 AC）**：第三方同名类不再被命中。
  **证据**：合成页（`body > .app-container.third-party`，无本插件 marker）实测——
  改前第三方容器被压成 **840px 列**（`research/hazard-gone.json` 首轮），
  收紧根选择器为 `#app.app-container` 后为 **1264px**（视口自然宽），且 `body` 背景/字体/内边距
  全程 `none/默认/0`。守卫同步拒绝裸 `.app-container`（新增负例）。
- [x] OQ-1 复现结论落 `research/`。
  **结论：未在实例上复现**「宿主原生弹窗被加渐变」的触发路径；已用两条可复核证据替代：
  ① 合成页复现**同形 DOM** 并证明修复后无害（`verify-hazard-gone.cjs` → `hazard-gone.json`）；
  ② 守卫负例锁定该形态。**不主张**已定位用户所见的渐变来源。
- [x] `npm test` 全绿 + 四条守卫退出码 0。
  **证据**：**44 文件 / 410 passed / 2 skipped**（基线 44/406/2，+4 例，零回退）；
  四条守卫 0；`npm run build` 通过。
- [x] 登记端口。
  **证据**：本仓 `vite.config.js` 内注释 + README/CLAUDE 待补（见残留 R-5：
  L0-16 段位表在 `tavern-harness` 真源仓，跨仓规则变更需单独走真源流程，本任务不擅改真源）。

### 残留（本任务收口时**明确未做**，不得读作已覆盖）

| 编号 | 残留项 | 原因 |
| --- | --- | --- |
| R-1 | 「宿主原生弹窗被加渐变」的**原始触发路径**未复现 | 需用户侧所见场景（哪个扩展/操作）才能定位；本任务只消除了同形隐患并补了守卫 |
| R-2 | 用户亲眼确认 env-sync GUI 恢复 | 需用户启动 env-sync dev（本仓已让出 5173） |
| R-3 | 独立态/抽屉态**视觉**回归需人眼确认 | 已用计算样式核对（容器 864/内容 840、居中 288/288、满屏底色、body 不受影响），但未做像素级视觉比对 |
| R-4 | 成功/告警/危险语义色仍为字面量 | 宿主无官方语义色变量记载（L1-MR-5 不猜 API）；已集中注释，将来一处可换 |
| R-5 | L0-16 端口段位表登记（`tavern-harness` 真源仓） | 跨仓共享规则变更需用户确认后走真源同步流程 |

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
