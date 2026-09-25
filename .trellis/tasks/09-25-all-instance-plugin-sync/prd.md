# 全实例插件同装与宿主 DOM 侵入实测治理

## Goal

三件事：① **八处宿主目录**把插件装/更到最新（四宿主 × Dev/Real）；② 在**跑得起来的 Luker 两实例**上实机实测；③ 对「插件有没有侵入宿主」给出**可复核的断言**（不是猜），并据实测发现改进插件。

---

## Background（2026-09-25 现场取证，全部带命令/读数）

### B1 ✅ 事实：插件当前只装在 Luker 两处，且已是最新

| 位置 | 状态 |
| --- | --- |
| `Instance/Dev/Luker/data/default-user/extensions/st-zip-converter` | git clone，`f26dcd5` = 本仓 HEAD，工作区干净 |
| `Instance/Real/Luker/data/default-user/extensions/st-zip-converter` | 同上 |
| `Instance/{Dev,Real}/SillyTavern/public/scripts/extensions/third-party/` | **只有 `.gitkeep`**，插件从未安装 |
| `Instance/Dev/TauriTavern/src/scripts/extensions/third-party/` | **空** |
| `Instance/{Dev,Real}/PureTavern/apps/web/.generated/public/scripts/extensions/` | 待核（PT 的扩展落点与 ST 不同） |

当前在跑的实例只有 **8003（Dev Luker）/ 8004（Real Luker）**；8001/8002（ST）未监听。

### B2 ✅ 已证伪：「插件触发宿主原生 toastr 通知」，**不是本插件干的**

用户原话报「通知的弹出来的小长方形」，并确认指的是**酒馆原生 toastr 通知**。取证结论是本插件**无关**，三条独立证据：

1. **静态**：`grep -rni toastr src/ index.js` → **零命中**。插件从不调酒馆通知。
2. **动态动作矩阵**（`research/pw-action-toast-probe.cjs`，8003/8004 认证态）：
   6 个插件入口动作——打开账号弹层 → 点注入按钮「数据包互转」→ 点扩展菜单项 → 点宿主原生
   `.userBackupButton` → 点备份管理器注入按钮 → 一键拉取（真实拉 Dev 数据包）——
   **8003 上 0 条 toast**。
3. **结构上不可能**：宿主那条「Extension updates available」通知
   （`Instance/Dev/Luker/public/scripts/extensions.js:2006/2028`）只对
   **`manifest.auto_update === true`** 的扩展生效；本仓 `manifest.json` **无该字段**。
   该通知另有 `notifyUpdates` 开关 + 每日一次节流（同文件 `1977-1990`）。

**实测抓到的真凶（8004，页面加载时）**：

```
toastr.success('数据库已加载！', '数据库')
  at window.toastr.success   …/third-party/Zero/index.js:39
  at showToastr_ACU          …/third-party/shujuku-rebuild/index.js:99221
  at mainInitialize_ACU      …/third-party/shujuku-rebuild/index.js:130578
  at extensionMain           …/third-party/shujuku-rebuild/index.js:192694
DOM: div.toast.acu-toast.acu-toast--success
```

即**另一个仓 `shujuku-rebuild`** 在页面加载时弹的自绘通知（经 `Zero/index.js:39` 调 `window.toastr`）。
8003 没装该扩展，故 0 条。**该现象不由本仓负责**（用户答复：该项「无偏好」，按不阻塞处理）。
—— 如实登记一个不确定性：`--fetch` 之后重跑 8004 未再复现该条（怀疑与该扩展的 DB 加载条件有关），
故「何时必弹」本任务不做断言。

### B3 ✅ 决定性结论：本插件**不触碰宿主的任何既有元素**

仪器：`research/pw-dom-write-audit.cjs` —— 在**任何页面脚本之前**劫持 DOM 写 API
（`appendChild`/`insertBefore`/`removeChild`/`replaceChild`/`setAttribute`/`removeAttribute`/
`Element.remove`/`classList.add|remove|toggle`），按**调用栈**把每次写入归属到具体脚本
（栈里含 `st-zip-converter` 即判为本插件所为）。非侵入性已核：插桩后控制台错误与插桩前基线
**逐条一致**（`Failed to load resource 404` ×2 + 三条其他扩展的 PAGEERROR）。

8003（认证态，含打开账号弹层与抽屉）读数：

| 指标 | 读数 |
| --- | --- |
| 整页 DOM 写操作总数 | **22425** |
| **本插件所为** | **17** |
| 其中写在自己容器内 | 13 |
| 其中写宿主元素 | 4 —— **全部落在声明过的锚点上** |
| 改动宿主**既有节点**的属性/class | **0** |
| 删除宿主**既有节点** | **0** |

4 次宿主写入逐条（`research/dom-writes-8003-verdict.json`）：

| 次数 | op | 宿主锚点 | 插入的节点 |
| --- | --- | --- | --- |
| 1 | appendChild | `#extensions_settings2` | `#st-zip-converter-settings-panel.st-converter-drawer-wrapper` |
| 1 | appendChild | `#extensionsMenu` | `#st-zip-converter-menu-item.list-group-item` |
| 1 | insertBefore | 账号弹层 `.flex-container` | `#st-zip-converter-native-btn.menu_button` |
| 1 | insertBefore | 账号弹层 `.flex-container` | `#st-zip-converter-native-btn-quick-fetch.menu_button` |

**样式侧同样干净**（`research/pw-dom-intrusion-audit.cjs`，浏览器自己解析 `style.css`）：
**343 条规则、0 条命中插件容器之外的元素**；`body` / `html` 的 class 与内联 style 在
「屏蔽插件资源」与「正常加载」两组下**逐字节相同**。

**顺带清掉上一任务的遗留 OQ-4**：宿主 Luker 全仓 `grep -rn 'id="app"' public/` **零命中**，
`getElementById('app')` 亦零命中 ⇒ `#app` id 争用**不存在**（但见 R5，代码里仍有裸取兜底）。

### B4 ⚠ 实测发现的真问题：`split-deliver-modal.js` 是「第二个自绘深色模态」

上一任务（`09-25-style-scope-and-dev-port`）已把 `host-bridge.js` 的**扩展安装器模态**改成
继承 `var(--SmartTheme*)`，但其残留表 R-4 只覆盖了那一处。本次实测发现**同一类问题的另一个文件**，
且更严重——`src/ui/split-deliver-modal.js:58-113` 整块 `style.cssText` + 内联 `style`
是**一整套硬编码的 Catppuccin 深色主题**，挂在 `document.body` 上：

| 行 | 硬编码 | 性质 |
| --- | --- | --- |
| `:59` | `overlay.style.zIndex = '100000'` | 层级高于宿主弹窗（`Popup` 用 ~`9999`） |
| `:62` | `background: #181825; color: #cdd6f4;` | 整面底色/文字，**完全不继承宿主主题** |
| `:62` | `border: 1px solid rgba(245,158,11,0.35)`、`box-shadow … rgba(245,158,11,0.2)` | 金色品牌色（09-07 教训明令禁止） |
| `:69,77,84` | `#a6adc8`、`#f59e0b`、`rgba(255,255,255,0.1)` | 同上 |
| `:97` | `background: #f59e0b; color: #11111b;` | 金色按钮 + 纯黑文字 |
| `:112` | `rgba(137,180,250,0.1)` 蓝色提示卡 | 同上 |

同类残留（程度轻，但同属 L0-10）：

- `style.css:44` `--warning: #f59e0b;`（而相邻 `:36 --accent` 是 `var(--SmartThemeQuoteColor, #f59e0b)`，**同一份文件里两套写法**）；
- `style.css:591` `color: #f59e0b;`（裸字面量，非 `var()` 回退）；
- `src/core/plan-preview.js:36` `color: '#f59e0b'` —— **纯逻辑层产生了 UI 颜色字面量**，
  跨层泄漏（`src/core/` 按 CLAUDE.md 是"纯逻辑、禁 DOM 依赖"）；
- `host-bridge.js` 安装器模态：`#a6e3a1`×9 / `#f38ba8`×7 / `#f9e2af`×4 —— 即上一任务的 R-4，
  当时以「宿主无官方语义色变量记载」为由保留为字面量。

### B5 ⚠ 实测发现：16 处**浏览器原生** `alert()`/`confirm()` 未走宿主原生 Popup

spec 已立 `Host Native Dialog Adapter`（`getContext().Popup.show.confirm`，
见 `.trellis/spec/frontend/host-capabilities.md`），但只接入 4 处；**`alert` 一处没接**：

- `index.js` 12 处：`:910`（差量补丁提示）、`:1230/:1234/:1254/:1258`（恢复不可用）、
  `:1291/:1356`（已有恢复任务）、`:1390/:1395/:1405/:1409`（恢复结果/失败）
- `src/ui/host-bridge.js:1357`、`src/ui/log-console.js:210`
- 另 `src/ui/archive-manager.js:188` 的裸 `confirm(` —— 该文件**无任何 import 引用**（死代码），
  与 spec 自检里「已知死代码」的说法一致，本次一并处置。

在酒馆里，这些会弹出浏览器自带样式的小方框，与酒馆 UI 割裂——正是「插件侵入宿主观感」的一类。

### B6 注入面清单（供 R5 判定，非违规）

插件在宿主页上共 5 个注入口：① `#extensions_settings2` 设置抽屉面板；
② `#extensionsMenu` 扩展菜单项；③ 账号弹层「数据包互转」+「一键拉取」两个按钮；
④ 管理面板每用户行；⑤ Luker 备份管理器动作行。前 4 项本次实测覆盖（B3），
第 ⑤ 项由 `research/pw-action-toast-probe.cjs` 的 E 步确认存在（`managerBtnPresent: true`）。

---

## Requirements

- **R1（P0）八处宿主目录全部装/更到最新**：四宿主 × Dev/Real 各一份插件。
  - Luker 两处已 git clone：`git -C <dir> pull --ff-only` 校对到 `origin/main` HEAD；
  - ST 两处、TT 两处、PT 两处为**首次安装**：按各自扩展落点 `git clone`（**只走 L0-1 允许的
    `git clone` 路径**，严禁复制文件进实例目录）；
  - 安装后逐处取证：路径存在、`git log -1` 哈希 = 本仓 HEAD、`manifest.json` 可读。
  - **TT/PT 例外条款**：若核实其第三方扩展加载机制与 ST 不兼容（不能直接吃
    `third-party/<name>/manifest.json` 形态），则该处**不安装**，如实登记原因与证据，
    不得为了让清单好看而硬塞。

- **R2（P0）实机实测落在 Luker 两实例**：8003（Dev）与 8004（Real）。
  8004 上的动作限**只读**（不跑 `--fetch`，不触发真实数据包导出）。
  ST 8001/8002 当前未运行，本任务**不擅自启动实例服务器**；若需 ST 实测，先向用户要授权。

- **R3（P0）DOM 侵入给断言、不给猜测**：把 B3 的两条仪器（DOM 写归因 + CSS 命中域）
  固化为**可重复执行的验证手段**，并落进 spec 的「验证手段」小节；
  含一个**负例自检**（故意让插件写一个宿主既有节点，断言仪器能抓到），
  以证明"0 违规"是测出来的而不是仪器失灵。

- **R4（P0）消灭 `split-deliver-modal.js` 的整套硬编码深色主题**：
  表面/文字/边框/强调色一律改 `var(--SmartTheme*, 回退值)`；金色品牌色与 `#11111b` 去除；
  `z-index` 复核到不压过宿主弹窗层级（或给出保留理由）。
  同批处理 `style.css:44` / `style.css:591` / `src/core/plan-preview.js:36` 三处字面量。

- **R5（P1）原生 `alert()`/`confirm()` 全部改走宿主原生 Popup**：
  在既有 `Host Native Dialog Adapter` 上补 `alertDialog`（或统一 `notifyDialog`），
  16 处调用点逐一替换；无宿主时降级到 `window.alert`（保持纯前端可用，L1-MR-1）。
  死代码 `src/ui/archive-manager.js` 一并处置（删除或加 `dom-injection-guard:allow-file` 之外的
  明确死代码标记——**删除前需用户批准**，见 Out of Scope）。

- **R6（P2）消除裸取 `#app` 的兜底**：`index.js:86 main(appRoot = document.getElementById('app'))`
  的默认值会在插件态"若无容器则命中页面里任意 `#app`"——虽然实测 8003/8004 上宿主无 `#app`
  （B3），但这是把整棵工作台挂到别人容器里的潜在路径。改为**显式传入或返回不初始化**。

- **R7（P1）把「只写自己容器 + 白名单锚点」变成机器守卫**：新增静态守卫
  （与既有四条守卫同构），断言 `src/ui/**` 里对宿主 DOM 的写入只允许落在白名单锚点上；
  加负例单测（故意写 `document.body.appendChild(...)` 必须被判失败）。

## Acceptance Criteria

> 回填方式：逐条现场取证（命令输出 / file:line / 实机读数），收口时回填；
> 未取证者保持未勾选并记入残留（不得以「已归档」推断已完成）。

- [ ] **R1** 八处目录逐处取证表（路径 / 是否 git 仓 / `git log -1` 哈希 / 与 HEAD 是否一致），
      TT/PT 若不适配则给出机制不兼容的证据与结论。
- [ ] **R2** 8003 与 8004 各至少一轮实机读数落 `research/`（插件已加载、抽屉/菜单项/账号弹层注入点存在、
      无本插件报错）；8004 全程只读。
- [ ] **R3** 两条仪器可重复执行（脚本在 `research/` 内有用法注释），
      跑出 `cssViolations = 0`、`pluginWritesIntoHost` 全部落在白名单锚点、
      `attrOrClassOnForeignNode = 0`、`removalOfForeignNode = 0`；
      **且**负例自检通过（人为违规能被抓到）。
- [ ] **R4** `grep -c gradient`/硬编码色统计：`split-deliver-modal.js` 零硬编码色值；
      `style.css:44/591`、`plan-preview.js:36` 已修；实机（8003）下该模态表面色为宿主变量派生值。
- [ ] **R5** `grep -rn "[^a-zA-Z.]alert(" src/ index.js` 在业务层为 **0**（仅适配器内部保留降级）；
      `confirm` 自检命令与 spec 一致；每处替换后行为不变（有测试覆盖或实机核对）。
- [ ] **R6** `main()` 不再有 `getElementById('app')` 兜底；插件态容器来源唯一。
- [ ] **R7** 新守卫退出码 0；负例单测改前通过、改后拦截；五条守卫（原四条 + 新一条）全绿。
- [ ] `npm test` 全绿、零回退（基线：44 文件 / 410 passed / 2 skipped）；`npm run build` 通过。
- [ ] 本任务新增的 spec 条文落 `.trellis/spec/`（**自包含**，内联读数与 file:line，
      不写"详见任务目录"——任务目录被 `.gitignore` 排除，归档即不可见）。

## Out of Scope

- **不改 `shujuku-rebuild` / `Zero` 等其他仓**（B2 的真凶在那边；用户答复该项「无偏好」，
  按不阻塞处理：只在本仓 spec 记下「插件不得往宿主 body 塞自绘 toast」的约定，供后续跨仓任务用）。
- **不擅自启动 ST 8001/8002 实例服务器**（重操作，需用户授权）。
- **不删除任何文件**（含死代码 `src/ui/archive-manager.js`）：删除属 PARDON 门禁项，
  本任务只登记建议，动手指令留给用户。
- 不做整份样式体系重构（只处理 B4/B5 点名的位置）。
- 不改 `src/vendor/**`；不引入构建步骤（L1-MR-11）。
- 不处理 B2 里「8004 重跑未复现」的不确定性（那是别的仓的行为）。

## Open Questions

- **OQ-1**：TT（`src/scripts/extensions/third-party/`）与 PT（`apps/web/.generated/public/scripts/extensions/`）
  是否真的能吃 ST 形态的第三方扩展（`manifest.json` + `index.js` + `style.css`）？
  需现场核其加载器实现；不适配则按 R1 例外条款登记不装。
- **OQ-2**：`split-deliver-modal.js` 的 `z-index: 100000` 是否高于宿主 `Popup` 层级？
  若高于，宿主弹窗会被本插件模态压住——需实测宿主 `Popup` 的 `z-index` 再定（不猜）。
- **OQ-3**：R5 的 `alertDialog` 走 `getContext().Popup.show.alert`？
  须核官方文档/宿主源码确认该 API 形态（L1-MR-5：不得翻源码猜 API，须以官方文档为准）。
