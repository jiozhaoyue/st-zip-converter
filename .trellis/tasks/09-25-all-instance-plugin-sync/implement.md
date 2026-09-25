# 执行清单 · 全实例插件同装与宿主 DOM 侵入实测治理

> 规则：**复选框随执行实时勾选**，不得任务收尾时凭记忆批量补勾（L0-2）。
> 每完成一项就把命令输出/读数写进该项下方，未取证者保持未勾选。

## 阶段 0 · 前置核查（三处不猜 API / 不猜事实，全部查完再动代码）

- [x] **0.1（OQ-1）核实 TT / PT 的第三方扩展加载机制**。
      **结论**：TT 走标准 `manifest.json` 加载器（`TauriTavern/src/scripts/extensions.js:695-715`：
      `fetch(getExtensionResourceUrl(name,'manifest.json'))`），**契约兼容 ST**；
      但落点是运行期可选的 data root（`docs/CurrentState/ThirdPartyExtensions.md:133`、
      `ExtensionDEV.md:36-39`），而 `Instance/{Dev,Real}/TauriTavern` **没有 `data/`**，
      且其安装由 Rust gitoxide 建受管 embedded repo（手工 clone 只得 `unmanaged` 状态）。
      ⇒ TT **不装**，登记替代路径（启动后经其扩展管理器用 URL 装）。
      PT 是**纯浏览器 Profile**：`apps/web/src/features/extensions/README.md:3/:54/:56` 明载
      包存 M13 浏览器 blobs、`local/global` 只是标签、"no multi-user server directory"，
      安装来源只支持远程 URL ⇒ **没有磁盘目录可 clone**，PT **不装**。
      完整证据表：`research/instance-install-table.md` B/C 两节。
- [x] **0.2（OQ-3）查官方文档确认宿主是否有原生 alert**。
      **结论**：`docs.sillytavern.app`（Writing Extensions）只文档化 `Popup.show.confirm` /
      `.input` / `.text` 三个方法，**没有 `alert`**；`.text(header, text)` 即"只显示信息"的那个
      （返回被点击按钮结果）。运行时交叉核对（`research/host-api-check-8003.json`）：
      `getContext().Popup.show` 的方法键**恰为** `['confirm','input','text']`，与文档一致；
      `POPUP_RESULT` 有 AFFIRMATIVE/CANCELLED/NEGATIVE/CUSTOM1..9，`POPUP_TYPE` 有 CONFIRM/CROP/DISPLAY/INPUT/TEXT。
      ⇒ R5 的 `alertDialog` 宿主路径用 **`Popup.show.text`**（文档记载，非外推），
      **不得**编造 `Popup.show.alert`。
- [x] **0.3（OQ-2）实测宿主 `Popup` 的 `z-index`**。
      **读数**（`research/host-api-check-8003.json`）：宿主原生 `.popup` 的
      `z-index = auto`（`position: fixed`，无数值层级）；页面上最高层依次为
      `#stcj-root`/`#toast-container` **999999**、`.magic-panel-wrapper` **100000**、
      `#hide-helper-modal-overlay`/`#qr-assistant-modal-overlay` **99999**（多为其他扩展）。
      ⇒ 本插件 split 模态的 `100000` 与页面里另一个模态同层，**压得住 `z-index:auto` 的宿主弹窗**。
      另发现**本插件内部两套模态层级不一致**：`split-deliver-modal.js:59` 用 `100000`，
      而 `style.css:1955` 的自有模态 overlay 用 `9999`（且该规则是死规则，见 0.4）。
- [x] **0.4** 复核 `style.css:1955` 是否命中 split-deliver 的 overlay。
      **结论：不命中，且该规则本身是死规则**。`index.js:1707-1717` 建的
      `#st-converter-modal-overlay`（同时带 id 与 class）被 append 到 **`document.body`**，
      而 `#app.app-container` 是它的**子**（`:1716 modalOverlay.appendChild(appContainer)`）；
      规则 `#app.app-container .st-converter-modal-overlay` 要求方向**相反** ⇒ **永久不命中**。
      split-deliver 的 overlay 挂在 body 且 id 是 `split-deliver-modal` ⇒ 同样不命中。
      **副产物结论**：R4 改 split 配色**只需改 JS 内联样式，`style.css` 不必动**；
      同时登记一条缺陷：`openConverterModal()` 是导出 API（`plugin.test.js:34` 断言其存在、
      `workbench-template.js:7` 记载其存在），但 overlay 自身**零样式**——该路径一旦被调用，
      模态不会全屏居中。

**门禁 G0**：✅ 通过（0.1–0.4 均有结论；OQ-3 证实宿主无原生 alert ⇒ 走 `show.text`）。

## 阶段 1 · R1 八处实例安装/更新（只走 git clone / git pull --ff-only）

- [x] **1.1** Luker 两处：`git fetch origin` + `git pull --ff-only`。
      **读数**：两处均 `Already up to date.`，`git log -1` = `f26dcd5b820f7e4a283a7f385ab73ec687cf886a`
      = 本仓 `origin/main` HEAD；`git status --short` 空。
- [x] **1.2** ST 两处：`git clone --depth 1`（ST 自己的安装器也是 depth 1）。
      **读数**：两处克隆成功，`git log -1` = `f26dcd5…`；`manifest.json` 可解析。
      落点 `public/scripts/extensions/third-party/st-zip-converter` 已在宿主 `.gitignore:18/:54` 内
      ⇒ 两个 ST 实例仓 `git status --short` **均为空**（未弄脏实例仓）。
- [x] **1.3** TT 两处、PT 两处：依 0.1 结论**不装**，机制不兼容的证据与替代路径
      见 `research/instance-install-table.md` B/C 两节（含 file:line 引文）。
- [x] **1.4** 取证表落 `research/instance-install-table.md`：八行齐全，
      含路径 / 方式 / `git log -1` / 是否等于 HEAD / 备注，另附 A 节"宿主仓未被弄脏"。

**门禁 G1**：✅ 通过（八行齐全；不装的四处均有 file:line 机制证据，非"没做"）。

## 阶段 2 · R3 仪器固化（先证明仪器能抓到违规，再看它报 0）

- [x] **2.1** 两个仪器已可重复执行（文件头有完整用法注释），复跑命令集中在
      `research/FINDINGS.md` §7。
- [x] **2.2 负例自检**：新增 `pw-dom-write-audit.cjs --selftest`——把**合成**的操作序列
      （1 非锚点插入 + 2 改锚点属性 + 1 删宿主节点 + 1 合规锚点插入 + 1 写自己家）
      喂给**同一个** `analyze()`，断言四类违规都被抓到。
      **读数**：`selftest: PASS`，退出码 **0**；`violationsTotal=4`
      （insertOutsideAnchor=1 / attrOrClassOnForeign=2 / removalOfForeign=1）。
      **自检当场找出一个真漏洞**：首版判定只看「目标在不在锚点上」，
      于是 `classList.add` 打在锚点（如 `#extensionsMenu`）上会被判**合规**——
      等于允许插件改宿主菜单项的 class。已改为按操作类型分开判：
      **插入类才看锚点，改动类/删除类只认「目标是不是自己的节点」**。
- [x] **2.3** 撤销合成数据，对真实采集重跑 → `dom-writes-8003-verdict.json`：
      `pluginWritesIntoSelf=13`、`pluginWritesIntoHost=4`（**全部** `ofWhichInsertOnDeclaredAnchor=4`）、
      `violationsTotal=0`（四类各 0）。
- [x] **2.4** 仪器非侵入性复核：插桩后控制台错误与基线**逐条一致**
      （`Failed to load resource 404`×2 + `SyntaxError: Unexpected reserved word` +
      `TypeError: $(...) is not a function` + `Identifier 'SPresetSettings' has already been declared`）。
      过程中另修两个仪器自身的坑：`home()` 未守卫 DocumentFragment（曾打断 jQuery 的 IIFE，
      整页 `jQuery is not defined`）、`classList.*` 取不到 owner（曾把自有图标误报成"改宿主元素"）。

**门禁 G2**：✅ 通过（2.2 已**看到违规被抓到**，2.3 的 0 才有意义）。

> **范围修正（现场取证后，2026-09-26）**：R4 的原始目标 `src/ui/split-deliver-modal.js`
> 经核实是**死代码**（`index.js:73` 只 import 不调用），去"修"它的配色等于装修没人进的屋子。
> 用户批准后**直接删除**该文件与 `src/ui/archive-manager.js`（另一处全仓 0 引用）。
> 因此 R4 的 live 目标改判为：`plan-preview.js` 的颜色字面量（**真被 UI 消费**）、
> `style.css` 的两处裸字面量、以及 0.4 查出的**死规则**。

- [x] **3.1（原目标改判）** `split-deliver-modal.js` 已删除（见阶段 8.2 的删除记录与理由）；
      同批删除 `src/ui/archive-manager.js` 与 `index.js:73` 的未使用 import。
- [x] **3.2** `style.css` 两处裸字面量：
      `--warning`（`:44` 一带）保持令牌块内定义不动（与 `--danger`/`--success` 同属"宿主无官方
      语义色变量"的既定残留 R-4，本次不翻案）；新增 `--accent-soft-fallback`，
      把 `@supports not (color-mix)` 块里的 `rgba(245,158,11,0.24)` 与 `#f59e0b`
      收敛成 `var(--accent-soft-fallback)` / `var(--accent)` —— **字面量只许出现在令牌块一处**。
- [x] **3.3** `src/core/plan-preview.js`：新增 `ACTION_TOKENS` / `ACTION_TOKEN_FALLBACK`，
      `ACTION_LABELS[*].color` → `.token`（`copy|route|migrate|synth|drop|filter`）。
      **core 不再产出任何颜色字面量**（原先 6 个 hex 被 UI 直接写进 `style.borderColor`）。
- [x] **3.4** 新增 `src/ui/action-colors.js`（`actionTokenVar()`，token → `var(--st-action-*)`）；
      `style.css` 令牌块新增 6 个 `--st-action-*`（`synth` 跟随宿主 `--SmartThemeQuoteColor`）；
      两个消费点 `category-filter.js` / `file-tree-picker.js` 改经该桥取色。
      （`var()` 可直接赋给 `style.borderColor` 等 CSS 声明——浏览器在计算值时替换，
      与 `themeAccent()` 那类"需要真实色值"的场景不同，已在模块注释里写明区别。）
- [x] **3.5（额外，0.4 查出的真缺陷）** `style.css` 的死规则已修：选择器由
      `#app.app-container .st-converter-modal-overlay, .st-converter-drawer-app .st-converter-modal-overlay`
      改为 **`#st-converter-modal-overlay`**（主体是覆盖层自身，与实际 DOM 方向一致）。
      守卫 `css-scope.js` 的 `ALLOWED_ROOTS` 早已含该选择器——守卫本来就在等这个写法。
- [x] **3.6** 实测核对：见阶段 7 的实机读数（`plan-preview` 动作徽标色为 `var()` 派生值）。

## 阶段 4 · R5 原生 alert/confirm 改走宿主原生 Popup

- [x] **4.1** 新增 `alertDialog(message, title?)`（`host-bridge.js`）。
      **宿主路径用 `Popup.show.text`**：官方文档只文档化 `confirm`/`input`/`text`（无 alert），
      运行时键集亦恰为 `['confirm','input','text']` ⇒ 用文档记载的 `.text`，不外推。
      降级链同 `confirmDialog`：宿主 `.text` → `window.alert` → 纯 Node 静默返回。
      常量 `CONFIRM_DIALOG_TITLE` 更名 `HOST_DIALOG_TITLE`（确认与提示共用）。
- [x] **4.2** 16 处调用点全部替换：`index.js` **12** 处（async 上下文用 `await` 不便时统一 `void`）、
      `host-bridge.js:1357`、`log-console.js:210`（两处均 `await`，闭包是 async）。
- [x] **4.3** 死代码 `src/ui/archive-manager.js:188` 的裸 `confirm(`：**已随文件删除**（用户批准）。
- [x] **4.4** `test/alert-dialog.test.js` 新增 **6 例**：原生可用走 `.text` 且参数序 `(header,text)`
      且不再调 `window.alert`、标题可覆盖、只有 confirm/input 时降级且**文案原样透传**、
      原生抛错静默降级、`getContext` 抛错降级、纯 Node 不阻断。
      **故意不提供 `show.alert`**——实现若哪天改回 `show.alert`，第 1 例会失败。
- [x] **4.5** 自检：`grep -rn "[^a-zA-Z.]alert(" src/ index.js` → **0 命中**；
      `confirm` 自检 → **0 命中**（原先是死代码里的 1 处，删除后归零）。

## 阶段 5 · R6 去掉 `#app` 裸取兜底

- [x] **5.1** `main(appRoot)` 删除默认参数与 `|| document.getElementById('app')`，改早返回 + `logger.warn`。
- [x] **5.2（范围扩大，现场发现更要害的一处）** `bootstrap()` 原先**只看 `#app` 存不存在**就决定走独立态——
      插件态下只要页面有第三方 `#app`，就会把整棵工作台写进别人的容器且永不挂宿主抽屉。
      已改为**先判 `host.isPlugin`，再找容器**；独立态找不到骨架时 warn + 返回。
- [x] **5.3** 三个调用点（`index.js:1741/1763/1771`）均显式传入容器，逐个核对无遗漏。
- [x] **5.4** 独立态与插件态回归见阶段 7。

## 阶段 6 · R7 DOM 写入白名单守卫

- [x] **6.1** 新增 `scripts/dom-scope.js`（与 `css-scope.js` 同构：`export checkDomScope(code, file)`
      + CLI + 退出码语义；词法扫描屏蔽注释/字符串但**保留偏移**，以便回原文取选择器字面量）。
- [x] **6.2** `package.json` 加 `check:dom-scope`。
- [x] **6.3** `test/dom-scope.test.js` **13 例**：含 6 类负例（裸 body/documentElement/head、
      可选链形态、非白名单选择器、非字面量选择器、方括号取法、insertAdjacentHTML/replaceChild/prepend）
      与 4 类正例（局部变量、白名单锚点、allow 标记、整文件豁免）+ 不误报 + 真仓现状断言。
- [x] **6.4** 五条守卫全绿（另加 `check:control-consumer`，共 5 条）。

**负例测试当场逼出守卫自身的两个真缺陷（都已修，且写进注释防止回归）**：
1. **可选链静默漏报**：`document.querySelector('#evil')?.appendChild(x)` 报 0 违规——
   对象表达式收集在 `?` 处断掉、目标变空串被跳过。
2. **白名单形同虚设**：取选择器字面量时算错了 `(` 的位置（取到了写入方法的括号，它在对象**之后**），
   于是永远取不到字面量、锚点检查从不生效。真仓当时"通过"只是因为它恰好全走局部变量。
   —— 这两条正是"只看 0 违规无法区分没违规与守卫失灵"的活证据。

## 阶段 7 · R2 实机实测 + 全量验证

- [ ] **7.1** 8003（Dev）：插件态读数（抽屉/菜单项/账号弹层注入点、无本插件报错）+ DOM 写归因。
- [ ] **7.2** 8004（Real）：同 7.1，**全程只读**（不跑 `--fetch`、不触发真实数据包导出）。
- [ ] **7.3** `npm test` 全绿零回退（基线 44 文件 / 410 passed / 2 skipped）+ `npm run build` 通过。
- [ ] **7.4** 独立态回归（`npm run dev`，3040 端口）+ 计算样式读数。

**门禁 G3**：7.3 全绿 + 四条→五条守卫全 0 才允许进入阶段 8。

## 阶段 8 · 收口

- [ ] **8.1** spec 更新（**自包含**，内联读数与 file:line，不得写"详见任务目录"）：
      - `host-capabilities.md`：`alertDialog` 契约 + 宿主是否有原生 alert 的**实证结论**；
      - `component-guidelines.md`：DOM 写入白名单锚点契约 + 两条仪器用法 + 负例自检要求；
      - 若 OQ-1 有结论，补 TT/PT 扩展加载机制一节。
- [ ] **8.2** 回填 `prd.md` 全部验收项（逐条带证据；未做者登记残留）。
- [ ] **8.3** 提交并**推送 origin**（L0-7；确认 `git remote -v` 的 origin 是本仓）。
- [ ] **8.4** 归档任务 + 记 journal。

## 回滚点

| 阶段 | 回滚动作 |
| --- | --- |
| 1 | 各实例 `git checkout <安装前哈希>` / 宿主原生扩展管理器卸载（**不手删文件**） |
| 3 / 4 / 5 | `git revert <该提交>`（均为呈现层，无状态迁移） |
| 6 | `package.json` 摘掉 `check:dom-scope` |
