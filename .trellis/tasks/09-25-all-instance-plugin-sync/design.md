# 技术设计 · 全实例插件同装与宿主 DOM 侵入实测治理

> 配套：`prd.md`（需求与验收）、`implement.md`（执行清单）、`research/`（本次全部读数）。

## 1. 边界（改哪些、不改哪些）

| 落点 | 改动性质 |
| --- | --- |
| `src/ui/split-deliver-modal.js` | 自绘模态改主题继承（R4） |
| `style.css:44 / :591` | 去裸字面量（R4） |
| `src/core/plan-preview.js:36` | 去掉 UI 颜色字面量，改传**语义 token**（R4，见 §2.3） |
| `src/ui/host-bridge.js` | 新增 `alertDialog` 适配器（R5）；语义色收敛（§3.3） |
| `src/ui/log-console.js:210`、`index.js` 12 处 | `alert()` → 适配器（R5） |
| `index.js:86` | 去掉 `getElementById('app')` 兜底（R6） |
| `scripts/` + `test/` | 新增 DOM 写入白名单守卫 + 负例（R7） |
| 八处实例目录 | `git clone` / `git pull --ff-only`（R1，**只走 L0-1 允许路径**） |

**不改**：`src/vendor/**`、`src/core/transform.js` 等转换主链路、`shujuku-rebuild` 等其他仓、
任何实例内的非插件文件。不引入构建步骤（L1-MR-11）。

## 2. 契约

### 2.1 宿主对话框适配器扩展（R5）

现状（`.trellis/spec/frontend/host-capabilities.md`）：只有 `confirmDialog(message): Promise<boolean>`。
新增：

```js
// src/ui/host-bridge.js
export async function alertDialog(message: string, title?: string): Promise<void>
```

- 取能力路径**不变**：`getContext().Popup.show.*`（官方文档记载的唯一合法路径，L1-MR-5）。
- **门槛**：`Popup.show.alert` 的**确切形态必须先由官方文档确认**（OQ-3）。
  未确认前**不得**照 `confirm` 的形状外推——这正是 L1-MR-5 禁止的"猜 API"。
  若文档无 `alert`，则退回 `Popup.show` 生成一个单按钮弹窗，或**明确降级为 `window.alert`**
  并在 spec 里写明"宿主无原生 alert，降级为浏览器原生"（诚实降级优于编造 API）。
- 降级链（与 `confirmDialog` 同构，逐级不抛）：原生 `Popup` → `window.alert` → 纯 Node 下 no-op。
- 调用点统一为 `await alertDialog(...)`；`index.js:1390/1395/1405/1409` 的**恢复结果**文案
  需复核：这几条是"操作结果"而非"确认"，改用宿主原生提示后要保证**不丢失信息**
  （文案原样透传，测试断言原文）。

### 2.2 主题继承契约（R4）

- CSS 侧一律 `var(--SmartTheme*, 回退值)`；`var()` 的**回退值**中出现的字面量不算违规
  （现行 spec 已如此，`style.css` 里 11 处 `var(--SmartThemeQuoteColor, #f59e0b)` 属合规）。
- **裸字面量**（不在 `var()` 第二参数位置）一律违规：`style.css:44 --warning: #f59e0b`、
  `style.css:591 color: #f59e0b`。
- JS 侧 `el.style.color = '…'` **不接受 `var()`**，必须经 `host-bridge` 的 `themeAccent()` /
  `themeVar()` 读真实值后写入（该机制上一任务已建立，直接复用，不新造）。
- **自绘浮层的面**（背景/文字/边框/圆角）不得自成一套配色：`split-deliver-modal.js` 的
  `background:#181825; color:#cdd6f4` 这类整面硬编码是本次重点。

### 2.3 语义色（成功/警告/危险）的收敛方式

上一任务残留 R-4 把语义色留作字面量（理由是「宿主无官方语义色变量记载」）。本次**不推翻该结论**，
但把它从"散落字面量"收敛为**单一来源**：

- 在 `host-bridge.js` 集中一处导出 `semanticColor(kind)`（`success|warning|danger`），
  内部优先尝试宿主变量（`--SmartThemeQuoteColor` 等**已确认存在**的变量 + `color-mix` 派生），
  取不到时回退到**一处**字面量常量，并集中注释说明理由。
- `split-deliver-modal.js` 与安装器模态都从这里取，**不再各自写** `#a6e3a1` / `#f38ba8` / `#f9e2af`。
- 验收只看「字面量是否只出现在这一处」，不强制消灭全部字面量——这是对 R-4 的**收敛**而非翻案，
  避免在没有官方变量的情况下编造 API。

### 2.4 DOM 写入白名单契约（R7，本次把 B3 的仪器固化为守卫）

**可写宿主的位置**（穷举，与 B3 实测的 4 次写入一一对应）：

| 宿主锚点 | 允许插入的节点 |
| --- | --- |
| `#extensions_settings2`（或 `#extensions_settings`） | `#st-zip-converter-settings-panel` |
| `#extensionsMenu`（或 `#options` 兜底） | `#st-zip-converter-menu-item` |
| `.userBackupButton` 的父元素 | `#st-zip-converter-native-btn` / `-quick-fetch` |
| `.userBackupManager .backupActionRow` | `#st-zip-converter-luker-manager-btn` |

**禁止**（守卫判据，任一命中即失败）：

1. 以 `document.body` / `document.documentElement` / `#options` 之外的**非白名单宿主节点**为父的
   `appendChild` / `insertBefore` / `insertAdjacentHTML`；
2. 对**非本插件节点**调 `setAttribute` / `classList.*` / `style.*`；
3. 用 `removeChild` / `remove()` 删除**非本插件节点**。

守卫形态与既有四条同构（`scripts/css-scope.js` 的 CLI 约定与退出码语义），
命名 `scripts/dom-scope.js`，命令 `npm run check:dom-scope`。
**必须带负例单测**：故意写 `document.body.appendChild(el)`、故意对宿主节点 `classList.add`，
改前必须通过（守卫还没写）、写完必须被拦——否则无从区分"没违规"与"守卫失灵"。

### 2.5 容器来源契约（R6）

`main(appRoot)` 的**唯一合法来源**：独立态 = `index.html` 的 `#app`；插件态 =
`mountSettingsDrawer` 回调传入的 `panel.querySelector('#app')`。删除默认参数里的
`document.getElementById('app')` 兜底，改为**无参数即不初始化**（早返回 + `logger.warn`）。
理由：兜底会在插件态命中**页面里任意** `#app`，把整棵工作台挂到第三方容器里——
实测 Luker 无 `#app`（B3），但这是"当前没炸"而非"不会炸"。

## 3. 数据流

本次**不新增数据流**，全部是 UI 呈现层与守卫层改动。唯一跨层改动是 §2.3：
`plan-preview.js` 不再产出颜色字面量，改产出**语义 token 字符串**（如 `'warn'`），
由 UI 层经 `semanticColor()` 解析——恢复 `src/core/` 的"纯逻辑、无呈现依赖"边界（CLAUDE.md 硬性分层）。

## 4. 取舍

| 取舍点 | 选择 | 理由 |
| --- | --- | --- |
| `alert` 改宿主原生 | 先核官方文档；无 `alert` 则**诚实降级**并在 spec 写明 | L1-MR-5 禁止猜 API；编造一个"看起来对"的调用比保留 `window.alert` 更危险（宿主升级即碎） |
| `z-index: 100000` | 先实测宿主 `Popup` 的层级（OQ-2）再定 | 不猜层级；若宿主更高，保留；若更低，降到宿主模态之下或说明为何必须压过 |
| 语义色 | 收敛到一处，不消灭 | 宿主无官方语义色变量；消灭会让"危险色"变成主题色，语义丢失 |
| TT/PT 安装 | 先核实加载器，不适配就不装并登记 | 硬塞进去不加载 = 假的"已同装"，比不做更糟 |
| 实例安装方式 | `git clone` / `git pull --ff-only` | L0-1：严禁复制文件进实例目录 |
| 任务结构 | **单任务**，不再拆父子 | C 的改动清单由 B 的实测结果**确定**（本次已完成 B，清单已穷举见 prd R4/R5/R6/R7）；三块交付串行且互相依赖，拆父子只会制造人工依赖记账 |

## 5. 兼容性与降级

- **四宿主**：`alertDialog` 在 ST/Luker 走原生 Popup；TT/PT 无 `getContext()` 时走 `window.alert`；
  独立 Web 态同样 `window.alert`。**任何一档都不得让主路径抛错**（L1-MR-1 / L0-11）。
- **无宿主环境（Node/Vitest）**：适配器返回 `void`，不阻断调用方（与 `confirmDialog` 的
  「`window.confirm` 也不可用 → 返回 `true`」同构）。
- **CSS 改动**：全部落在本插件自有选择器（`#app.app-container` / `.st-converter-drawer-app` /
  `#st-converter-modal-overlay`）下，不得新增以 `body`/`html`/`:root` 为主体的规则（L0-10 + 现行守卫）。
- **`#st-converter-modal-overlay`** 与 `split-deliver-modal` 的 overlay **是两个不同 id**，
  R4 只改后者的配色；改前须核 `style.css:1955` 那条规则是否也命中它（若是，避免双份样式打架）。

## 6. 回滚形态

逐条独立、可单独回滚，互不依赖：

| 改动 | 回滚方式 |
| --- | --- |
| R4 配色 | `git revert <该提交>`；配色是纯呈现，无状态迁移 |
| R5 对话框 | 同上；调用点保留 `await`，回退后仍成立（`alertDialog` 内部降级到 `window.alert`） |
| R6 容器来源 | 同上；删掉早返回即可恢复兜底 |
| R7 新守卫 | 从 `package.json` 摘掉 `check:dom-scope` 即可，不影响运行时 |
| R1 实例安装 | 各实例内 `git checkout <安装前哈希>`；或用宿主原生扩展管理器卸载（**不手删文件**） |

无数据迁移、无协议变更、无持久化结构变更 → 回滚不需要补偿动作。
