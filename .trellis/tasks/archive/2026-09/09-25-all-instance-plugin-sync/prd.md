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

> **2026-09-26 收口更正**：写本节时把该文件当作**待修的活代码**，后续核实它其实是
> **死代码**——`index.js:73` 只 `import { renderSplitDeliveryModal }` 而**全仓无任何调用点**
> （文件头注释也已自标为「待清理死代码（审计 S-09）」）。因此本节列出的配色问题**不再是待修项**，
> 而是**删除依据**。经用户批准该文件已删除，连带 `src/ui/archive-manager.js`（全仓 0 引用）。
> 下方内容保留作证据记录。

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

> 回填方式：逐条现场取证（命令输出 / file:line / 实机读数），2026-09-26 收口时回填；
> 未取证者保持未勾选并记入残留（不得以「已归档」推断已完成）。

- [x] **R1** 八处目录逐处取证。
  **证据**：`research/instance-install-table.md` —— 表 8 行齐全。
  ST/Luker 共四处均 `f26dcd5` → 拉取后 `1640118`（= 本仓 `origin/main`）；
  两处 ST 为首次 `git clone --depth 1`，落点在宿主 `.gitignore:18/:54` 内，
  两个 ST 实例仓 `git status --short` **均为空**（未弄脏）。
  TT/PT 共四处按例外条款**不装**，理由有 file:line 证据（见下表与残留 R-1）。
- [x] **R2** 8003 与 8004 实机读数落 `research/`。
  **证据**：`research/verify-changes-8003.json`、`verify-changes-8004.json` ——
  两处 `pluginLoaded=true`、设置面板/菜单项存在、账号弹层两个注入点均在；
  `pluginOwnFailedRequests: []`（本插件零失败请求，页面上的 3 个 404 经带 URL 采集确认为
  `/api/plugins/server-plugin-manager/probe`、`/api/plugins/command-exec/sandbox/get`、
  `/scripts/extensions/popup.js`，**均非本插件发出**）。8004 全程只读。
- [x] **R3** 仪器可重复执行 + 负例自检通过 + 归因读数。
  **证据**：`pw-dom-write-audit.cjs --selftest` → `selftest: PASS`、退出码 0，
  合成样本四类违规全部被抓（`violationsTotal=4`）；
  真实读数（新代码 `1640118` 下重跑）：整页 **23860** 次 DOM 写操作，本插件 **17** 次
  （13 写自己容器内 + **4 全部落在声明锚点**），`violationsTotal=0`（四类各 0）；
  CSS：**343 条规则、0 条命中插件容器之外**；`body`/`html` 的 class+内联 style 与
  「屏蔽插件」对照**逐字节相同**。见 `research/FINDINGS.md` §2/§3。
- [x] **R4** 硬编码配色处理（**范围经现场取证后改判**）。
  **证据**：原目标 `src/ui/split-deliver-modal.js` 经核实为**死代码**（`index.js:73` 只 import
  不调用；文件头亦自标 S-09 待清理），经用户批准与 `src/ui/archive-manager.js`
  （全仓 0 引用）**一并删除**；`index.js` 的未使用 import 同步移除。
  live 目标已修：`src/core/plan-preview.js` 的 6 个颜色字面量 → 语义 token
  （`ACTION_TOKENS`），新增 `src/ui/action-colors.js` 映射到 `style.css` 的 `--st-action-*`；
  `@supports not (color-mix)` 块里重复的 `rgba(245,158,11,.24)`/`#f59e0b` 收敛为
  `var(--accent-soft-fallback)`/`var(--accent)`。
  **实机读数**（8003/8004 一致）：`--st-action-synth` = `rgba(225,138,36,1)` **等于**宿主
  `--SmartThemeQuoteColor`（不再是写死的 `#f59e0b`），`--st-action-copy` = `#10b981`。
- [x] **R5** 原生 `alert`/`confirm` 全部改走宿主原生 Popup。
  **证据**：新增 `alertDialog(message, title?)`，宿主路径用**官方文档记载**的
  `Popup.show.text`（文档与运行时键集均为 `['confirm','input','text']`，**无 alert**），
  16 处调用点全部替换（`index.js` 12、`host-bridge.js` 1、`log-console.js` 1）；
  自检 `grep -rn "[^a-zA-Z.]alert(" src/ index.js` → **0 命中**；
  `confirm` 自检 → **0 命中**（原死代码处随文件删除归零）；
  `test/alert-dialog.test.js` 6 例全过（**故意不提供 `show.alert`**，实现回退即失败）。
- [x] **R6** 容器来源唯一化。
  **证据**：`main(appRoot)` 去掉默认参数与 `||` 兜底，改早返回 + `logger.warn`；
  `bootstrap()` 改为**先判 `host.isPlugin` 再找容器**（原先只看 `#app` 存不存在）。
  实机核对：`r6_noMainDefaultFallback=true`、`r6_hostFirstBranchLine=759`、
  全仓**代码中**唯一的 `getElementById('app')` 在 **1786 行**（> 759，即只在独立态分支内）。
- [x] **R7** 新增守卫 + 负例单测。
  **证据**：`scripts/dom-scope.js` + `npm run check:dom-scope`；
  `test/dom-scope.test.js` **13 例全过**（6 类负例 + 4 类正例 + 不误报 + 真仓现状）；
  真仓 15 文件零未声明写入；6 处确属必要的宿主写入已加带理由的 `dom-scope:allow` 标记。
  **负例当场逼出守卫自身两个真缺陷并已修**：① 可选链 `?.` 形态**静默漏报**；
  ② 锚点白名单因取错括号位置而**形同虚设**（详见 implement.md 阶段 6 与 spec `dom-write-scope.md` §6）。
- [x] `npm test` 全绿、零回退 + `npm run build` 通过。
  **证据**：**46 文件 / 429 passed / 2 skipped**（基线 44/410/2，+2 文件 +19 例，零回退）；
  `npm run build` `✓ built in 963ms`。
- [x] 五条静态守卫退出码 0（css-scope / dom-injection / template-source / control-consumer / dom-scope）。
- [x] **R1 附加**：ST/Luker 四处插件的 `manifest.json` 均可解析
      （`name=st-zip-converter` / `version=1.0.0` / `js=index.js` / `css=style.css`）。
- [x] **R5 附则**：`CONFIRM_DIALOG_TITLE` 更名 `HOST_DIALOG_TITLE`（确认与提示共用），
      `test/confirm-dialog.test.js` 断言的标题字符串不变、7 例仍全过。
- [x] 本任务新增/更正的 spec 条文已落 `.trellis/spec/`（**自包含**，内联读数与 file:line）：
      新建 `frontend/dom-write-scope.md`；增补 `frontend/host-capabilities.md`（信息提示契约 +
      "宿主无 alert"实证）；更正 `frontend/index.md` 与 `frontend/quality-guidelines.md` 的
      **过时计数与作废声明**（原「`body:has` 是有意保留的例外」已于上一任务移除，
      本次一并更正）；`frontend/component-guidelines.md` 的守卫清单 4 → 5 条。

### 残留（**明确未做**，不得读作已覆盖）

| 编号 | 残留项 | 原因 |
| --- | --- | --- |
| R-1 | TT / PT 四处**未安装**插件 | 两宿主的安装契约不允许「离线目录 clone」：TT 的 data root 是运行期可选的、且安装由 Rust gitoxide 建受管 embedded repo；PT 干脆**没有服务端扩展目录**（包在浏览器 Profile）。替代路径 = 各自启动后经其扩展管理器用 Git URL 安装。证据见 `research/instance-install-table.md` B/C |
| R-2 | ST 两实例**未做实机加载验证** | 8001/8002 当前未监听；启动实例服务器属重操作，本任务未擅自执行。四处已装的 ST 副本仅做了文件级取证 |
| R-3 | `openConverterModal()` 修复仅由选择器/DOM 契约保证，**未做像素级实机核对** | 该导出 API 在仓内无调用点（`plugin.test.js:34` 只断言其存在），无法从 UI 触发；死规则已按实际 DOM 方向改正，守卫亦接受该写法 |
| R-4 | 语义色（`--warning`/`--danger`/`--success` 及 `--st-action-*` 的部分项）仍为字面量 | 宿主无官方「语义色」变量记载（L1-MR-5 不猜 API）；本次只做**收敛**（集中到 `style.css` 令牌块一处），不翻案 |
| R-5 | 8003/8004 上仍有**其他扩展**造成的控制台报错与 3 个 404 | 非本插件（已用带 URL 的请求采集逐条确认） |
| R-6 | `shujuku-rebuild` / `Zero` 在 8004 加载时弹「数据库已加载！」toastr | 属**另一仓**；用户答复该项无偏好。本仓只在 spec 记下约定，未跨仓改动。重跑未复现，故不断言其触发条件 |

## Out of Scope

- **不改 `shujuku-rebuild` / `Zero` 等其他仓**（B2 的真凶在那边；用户答复该项「无偏好」，
  按不阻塞处理：只在本仓 spec 记下「插件不得往宿主 body 塞自绘 toast」的约定，供后续跨仓任务用）。
- **不擅自启动 ST 8001/8002 实例服务器**（重操作，需用户授权）。
- ~~不删除任何文件~~ **（2026-09-26 修正）**：原计划「只登记建议不动手」已由用户当场批准变更为
  **删除两个死代码文件**（`src/ui/archive-manager.js`、`src/ui/split-deliver-modal.js`）——
  删除理由、核实过程与替代方案已列出并获批（见 implement.md 阶段 3.1）。
  **除此两文件外，本任务未删除任何其他文件**；后续若还要删文件，仍需单独走 PARDON 门禁。
- 不做整份样式体系重构（只处理 B4/B5 点名的位置）。
- 不改 `src/vendor/**`；不引入构建步骤（L1-MR-11）。
- 不处理 B2 里「8004 重跑未复现」的不确定性（那是别的仓的行为）。

## Open Questions（2026-09-26 全部收口）

- **OQ-1 ✅ 已答**：TT 的扩展加载契约**兼容 ST 形态**（读 `manifest.json`，见
  `TauriTavern/src/scripts/extensions.js:695-715`），但其落点 data root 是**运行期可选**的、
  安装由 Rust gitoxide 建受管 embedded repo ⇒ 离线目录 clone 不可行；
  PT **没有服务端扩展目录**（`apps/web/src/features/extensions/README.md:3/:54/:56`）。
  ⇒ 两宿主均不装，替代路径见残留 R-1。
- **OQ-2 ✅ 已答**：宿主 `.popup` 的 `z-index` 为 **`auto`**（`position: fixed`，无数值层级）；
  页面上最高层是其他扩展的 `999999`/`100000`/`99999`。本插件 split 模态（**已删除**）曾用 `100000`。
  自有模态 overlay 用 `9999` —— 层级不统一一事随死代码删除而消解。
- **OQ-3 ✅ 已答**：官方文档与运行时**都没有** `Popup.show.alert`；
  信息提示的宿主方法 = **`Popup.show.text`**（文档标为 "Information display"）。
  `alertDialog` 即按此实现（见 spec `host-capabilities.md`）。
- **OQ-4（上一任务遗留）✅ 已答**：Luker 宿主全仓 `grep -rn 'id="app"' public/` **零命中**，
  `getElementById('app')` 亦零命中 ⇒ id 争用不存在。
  但发现更要害的同类隐患并已修：`bootstrap()` 原先按 `#app` 存在与否判独立态（见 R6）。
