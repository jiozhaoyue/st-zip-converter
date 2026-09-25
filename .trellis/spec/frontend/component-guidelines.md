# Component Guidelines (Plugin DOM & UI Injection · 宿主内注入规范)

> 宿主酒馆（SillyTavern / Luker）内 UI 注入、DOM 隔离与事件处理的约定。

---

## Overview (概述)

本模块是**发给别人装进酒馆的扩展插件**，因此额外承担「不能弄坏别人酒馆」的责任。三条底线：

- **不用重 UI 框架**：不引入 React / Vue / Svelte，只用原生 DOM 操作。
- **不留全局命名空间**：模块全部是标准 ESM，`globalThis` 上**不挂任何自定义符号**。
  （历史教训：09-04 之前的 IIFE 时代曾把调试钩子挂在 `globalThis.__tavernConvert`；该形态与 `tavern-convert-` DOM 前缀**均已删除**，出现即为陈旧描述。）
- **DOM 隔离靠两件事，不靠命名前缀**：
  1. **样式**：所有 CSS 规则作用域化在 `.app-container`（独立态）/ `.st-converter-drawer-app`（插件态）之下（见下方 CSS Scoping Mandate）；
  2. **注入要素**：id 统一为 `st-zip-converter-*`，防重标记用 `dataset.stZipInjected`。

> 复用宿主原生类（`menu_button` / `text_pole` / `inline-drawer` 等）**只允许出现在标记里**，样式仍须作用域化——宿主用的是同一套设计系统，裸选择器会连带改掉宿主的每一个按钮。

---

## UI Mounting & Self-Healing Injection (宿主注入：幂等 + 自愈)

宿主会在登录/切用户/弹层开关时**整体重渲染**其 DOM，注入的节点会随之消失。因此注入必须：

1. **幂等**：重复调用不产生第二份节点；
2. **自愈**：节点被宿主重渲染抹掉后能自动补回；
3. **多锚点**：同一元素在多个位置出现时（如 `.userBackupButton` 同时存在于账号弹层与管理面板每行）逐个处理。

统一机制是 `src/ui/host-bridge.js` 的共享 `watchHostDom(injectFn)`（`MutationObserver` + 200ms 去抖，**替代各函数各自 `setInterval` 轮询**）：

```javascript
// src/ui/host-bridge.js（节选）
const injectionWatchers = new Set();
let injectionObserver = null;
const INJECT_DEBOUNCE_MS = 200;

function watchHostDom(injectFn) {
  if (typeof document === 'undefined') return;
  injectionWatchers.add(injectFn);
  if (document.readyState === 'loading' || !document.body) {
    document.addEventListener('DOMContentLoaded', () => injectFn(), { once: true });
  } else {
    injectFn();                       // 宿主页面已加载（动态重载场景）
  }
  if (injectionObserver || !document.body) return;
  let scheduled = false;
  injectionObserver = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; runInjectionWatchers(); }, INJECT_DEBOUNCE_MS);
  });
  injectionObserver.observe(document.body, { childList: true, subtree: true });
}
```

注入函数内部用 `dataset.stZipInjected` 做**兄弟位检查**防重（标记随节点消失，observer 自动重注）：

```javascript
// src/ui/host-bridge.js mountNativeBackupButton（节选）
document.querySelectorAll('.userBackupButton').forEach((anchor) => {
  if (!anchor.parentElement) return;
  // 幂等：兄弟位已注入则跳过（弹层重渲染后标记随节点消失，observer 自动重注）
  if (anchor.nextElementSibling?.dataset?.stZipInjected === '1') return;
  anchor.parentElement.insertBefore(makeHostButton({ id: BTN_ID, icon: 'fa-right-left', label: '数据包互转', title: '…', onClick }), anchor.nextSibling);
});
```

### Button Factory Mandate (注入按钮必须经 `makeHostButton()` · 2026-09-25)

注入按钮**一律**由 `src/ui/host-bridge.js` 的模块级工厂 `makeHostButton({ id, icon, label?, title?, onClick? })` 构造，不得就地手搓 DOM：

- `className = 'menu_button menu_button_icon'`（宿主原生类，与原生按钮并排）；
- `dataset.stZipInjected = '1'`（幂等标记，见上文兄弟位检查）；
- 子节点固定为 **图标在前、文案在后**（`<i class="fa-fw fa-solid {icon}">` + `<span>`），文案走 `textContent` 而**非** `innerHTML`；
- click 先 `e.preventDefault()` + `e.stopPropagation()` 再回调 `onClick`。

契约由 `test/host-button-factory.test.js`（6 用例，最小 DOM 桩）锁定——项目**不引入 jsdom**（依赖自包含铁律），故用 `globalThis.document` 手搓桩驱动 `mountNativeBackupButton` / `mountLukerBackupManagerButton`，断言类名、幂等标记、子节点顺序与 tag、`textContent`、click 包裹效果、锚点缺失时静默无操作。

**范围边界（有意不经该工厂）**：

| 不纳入者 | 原因 |
| --- | --- |
| `registerMenuButton()` 注入的 宿主扩展菜单项 | 形态是 `list-group-item flexify-horizontal interactable` + `extensionsMenuExtensionButton` 图标类（宿主菜单项样式），不是 `menu_button`；硬套会破坏宿主菜单外观 |
| 工作台的固定动作按钮（`#btn-convert` / `#btn-host-fetch` / `#btn-restore-luker`） | 是**声明式模板标记**，属单一模板源（见下节）；改由 JS 生成会与 R8 冲突 |

四个注入点（**只注入「整包 ZIP 级」入口**，单体导出如单聊天/单角色卡/单世界书**不注入**）：

| 函数 | 锚点 | 说明 |
| --- | --- | --- |
| `mountSettingsDrawer()` | `#extensions_settings2` / `#extensions_settings` | 工作台主抽屉（`getWorkbenchHtml({ isDrawer: true })`） |
| `registerMenuButton()` | `#extensionsMenu .list-group` | 扩展菜单入口（兼容保留，点击后展开上述抽屉） |
| `mountNativeBackupButton()` | `.userBackupButton`（账号弹层 + 管理面板每用户行） | 「数据包互转」+（仅账号弹层）「一键拉取」 |
| `mountLukerBackupManagerButton()` | `.userBackupManager .backupActionRow` | 仅 Luker 有该锚点，其余宿主自然无操作 |

> **无锚点时不造浮层**：找不到锚点就什么都不做，等 observer 下次触发。**不要**自造右下角浮动按钮之类的非官方挂载点（UI 落点只认官方文档记载的位置）。

### Gotcha：锚点是「按需渲染」的，排查注入时不要只看初始 DOM（2026-09-25 真实误判）

`mountNativeBackupButton` / `mountLukerBackupManagerButton` 的锚点**在页面初始 DOM 中根本不存在**——
它们在宿主弹层被打开时才由模板渲染出来：

```
[Luker] #account_button 点击                                 (user.js:3469)
  └─ openUserProfile() → renderTemplateAsync('userProfile')  → 出现 .userBackupButton
       └─ 点该原生按钮 → openBackupManager()
            └─ renderTemplateAsync('userBackupManager')        → 出现 .backupActionRow
```

真机逐步计数（Dev Luker 8003）：初始 `0 / 0` → 点 `#account_button` 后 `.userBackupButton = 1`、
注入 **2** → 点原生 `.userBackupButton` 后 `.backupActionRow = 5`、注入 **3**。

**教训**：本仓 2026-09-25 曾因「初始 DOM 里 `[data-st-zip-injected="1"]` 为 0」而把注入判为回归，
实际是**探针点错了入口 id**（点了 `#user-settings-button` / `#sys-settings-button` /
`#extensionsMenuButton` / `#user-settings-block`，而 Luker 的正确 id 是 `#account_button`）。

**排查注入类问题时的强制步骤**：

1. 先确认**宿主面板已被打开**（记录用了哪个入口 id 与点击链），再查锚点计数；
2. 初始计数为 0 **不构成回归证据**——它只是说明面板没开；
3. `#st-zip-converter-menu-item`（扩展菜单注入）恒存在，可作为「注入机制是否整体健康」的对照探针。

**另一处实测细节**：`.backupActionRow` 在 Luker 有 **5 行**，但只有 index 0 含原生 ZIP 下载按钮，
故 `querySelector('.userBackupManager .backupActionRow')` 取首个**正是预期落点**（已真机确认）。
另注原生 `.userBackupButton` 自身带 `.disabled` class 但**仍可点击**——`.menu_button.disabled`
在 Luker 上只是外观态，非 `disabled` 属性语义，不要为它加额外分支。

---

## Event Handling & Host Coexistence (事件处理与宿主共存)

1. **阻止事件冒泡**：注入元素常嵌在宿主的下拉/弹层里，点击不得导致其意外关闭，且要 `preventDefault()` 防止 `<a>`/表单语义触发导航：
   ```javascript
   // src/ui/host-bridge.js（节选）
   btn.addEventListener('click', (e) => {
     e.preventDefault();
     e.stopPropagation();
     onClick();
   });
   ```
2. **下载生命周期与内存回收**：用不可见 `<a download>` 触发下载后必须延迟 `revokeObjectURL`，否则 Blob 常驻内存（用户在酒馆标签页一开就是几天）：
   ```javascript
   // src/ui/export-queue.js（节选）
   function triggerBlobDownload(blob, name) {
     // Node/Vitest 降级：无 DOM 时跳过浏览器下载动作（状态机路径仍被单测覆盖）
     if (typeof document === 'undefined') return;
     const url = URL.createObjectURL(blob);
     const a = document.createElement('a');
     a.href = url;
     a.download = name;
     document.body.appendChild(a);
     a.click();
     document.body.removeChild(a);
     setTimeout(() => URL.revokeObjectURL(url), 60_000);
   }
   ```
   全仓约定回收延时 **60_000 ms**（`export-queue.js` / `stash-list.js` / `view.js` 一致）。`src/ui/split-deliver-modal.js` 里的 1000 ms 属待清理死代码，**不要照抄**。
3. **浏览器能力必须检测再回退**：`window.showSaveFilePicker`（选位置导出，见 `export-queue.js` 的 `exportToLocation`：不支持或用户取消 → 回退普通下载）、拖出 `DataTransfer` 的 `DownloadURL`（仅 Chromium）、`navigator.storage.estimate`（配额条）——三者都必须特性检测。
4. **高频回调必须 rAF 合帧**：进度回调、队列批量渲染等高频 DOM 写入先经 `requestAnimationFrame` 合并（最新值胜出），禁止逐 chunk/逐条目同步写 DOM（实测累积出 14 个 80–107ms 长任务、宿主整页卡顿）。现存实现锚点：`export-queue.js:401`、`log-console.js:298`、`view.js:56`。
5. **有界等待**：任何 `await`（`fetch` / 媒体事件 / 渲染挂载 promise）都必须经**超时或 abort 信号**兜底 settle，禁止让 promise 永远 pending（历史事故：`IframeRenderer.render` 只等 `onload`，iframe 被 destroy 后永久悬置）。

### Bounded Fetch Contract (有界 fetch 契约 · 2026-09-24)

> 定稿于任务 `09-24-perf-hardening-transfer-memory`（审计 R-01 / R-02 / R-05 / R-15）。
> 触发场景：新增或改动任何网络 `await`。

**模块与导出**（`src/ui/fetch-bounds.js`；放 UI 层因其依赖 Web API `fetch`，`src/core/` 仍禁 Web/存储依赖）

```js
export class TimeoutError extends Error {}        // name === 'TimeoutError'
export const SHORT_FETCH_TIMEOUT_MS = 10_000;     // 凭证类短请求
export const DEFAULT_FETCH_TIMEOUT_MS = 120_000;  // 通用默认
export const UPLOAD_TIMEOUT_MS = 0;               // 大包上传（0 = 不设硬超时）；唯一调整点

fetchWithTimeout(url, init = {}, { timeoutMs, signal, label } = {})
  → Promise<Response>

readJsonBounded(response, { timeoutMs, signal, label } = {})
  → Promise<unknown>   // 响应体读取的有界兜底
```

> **为什么需要 `readJsonBounded`**：`fetch` resolve 只代表**响应头**到达。`fetchWithTimeout`
> 在 resolve 时已 `finally` 摘掉外部 signal 监听并清掉定时器，因此其后的
> `await response.json()` **既无超时也不再响应取消**——正落在 L1-MR-7 里。
> 凡「已拿到 Response 再读体」的地方都必须经 `readJsonBounded`，不得裸 `await response.json()`。

**语义表**

| 条件 | 行为 |
| --- | --- |
| `timeoutMs > 0` 且超时 | 内部 abort → 抛 `TimeoutError`（带 `label` / `timeoutMs`，供 UI 区分文案） |
| `timeoutMs === 0` | **不设硬超时**，仅由外部 `signal` 兜底（长上传用，见下） |
| 外部 `signal` abort | 抛 `AbortError`（与超时区分：文案「取消」vs「超时」） |
| 外部 `signal` 已 abort | **入口短路**——直接抛错，不发起请求 |
| 正常返回 | `finally` 中**必定** `clearTimeout`（否则 Vitest 进程挂住） |

**合流实现**：手动 `addEventListener('abort', …)` 把外部 signal 转发到内部 controller，
**不用** `AbortSignal.any`——手动转发在全部目标环境行为一致，省掉特征检测与回退两条路径。
`restoreToHost` 的外部 `signal` 用同一手法转发到它持有的在途控制器。

**恢复链路逐点（`src/ui/host-bridge.js`）**

| 请求 | 兜底方式 |
| --- | --- |
| `getCsrfToken()` / `getHandle()` | `SHORT_FETCH_TIMEOUT_MS` |
| `POST /api/users/restore`（大包上传） | `UPLOAD_TIMEOUT_MS`（默认 `0`）+ 取消入口 |
| 成功/失败两条响应体读取 | `readJsonBounded`（`SHORT_FETCH_TIMEOUT_MS`） |

> **上传为什么默认不设硬超时**：120MB 包在慢速上行下超过任何固定阈值都属正常，硬超时会打断
> **正常**恢复。验收口径「超时**或** AbortSignal」由取消入口与 `signal` 满足。
> 设上限只需改 `UPLOAD_TIMEOUT_MS` 一处（`restoreToHost` 默认值与 `index.js` 显式传参同源）。

**取消入口（R-01）**：在途控制器由 `host-bridge.js` **持有**（不在 UI 层），
导出 `cancelRestoreInFlight()`；待导出区在 `restoreInFlight` 时渲染「取消恢复」按钮
（置于空状态提前返回**之前**——空队列也必须可见）。取消抛 `AbortError`，
UI 文案必须是「已取消 + 宿主可能仍在处理，请稍后核对数据」，**不得**报「失败」。
落点在 host-bridge 的原因：无 DOM 的 Node 环境下该路径**可被单测覆盖**。

**并发互斥**：`restoreInFlight` 模块级标志 + `isRestoreInFlight()` 导出；`restoreToHost` 入口判重
（在途则抛错），`try/finally` 保证复位；UI 侧在途时禁用**全部**「写回宿主」入口
（`export-queue.js` 每行按钮 + 选中批操作条；`index.js` 的 `#btn-confirm-restore`）。

**伪成功禁令**：响应体 `response.json()` 解析失败**禁止** catch 成 `{ success: true }`。
正确返回 `{ success: false, unconfirmed: true, reason }`，UI 三态文案：成功 / 未确认（宿主可能仍在处理）/ 失败。

**测试点（`test/restore-chain.test.js`）**

- mock fetch 真挂起（且**必须响应 `init.signal`**，否则测试自身挂死）→ 断言按 `timeoutMs` 抛 `TimeoutError`。
- `timeoutMs=0` + 无 signal → 不抛超时；正常响应后 `vi.getTimerCount() === 0`（无残留定时器）。
- 体读取：挂起 → `TimeoutError`；`signal` 取消 → `AbortError`；已取消 → 不求值 `json()`；体自身抛错原样透传。
- 在途第二次 `restoreToHost` → reject `/已有恢复任务正在进行/`；首次 settle 后标志复位（含抛错路径）。
- 取消入口：`cancelRestoreInFlight()` 无在途时返回 `false`；在途时返回 `true` 且 promise 抛 `AbortError`，
  事后控制器释放（再调仍为 `false`）；外部 `signal` 合流路径同样可中止。
- 响应体解析失败 → `success === false && unconfirmed === true`；响应体挂起 → 短超时后同样 `unconfirmed`。

---

## Host Native Dialog Adapter

> **已迁至 [`host-capabilities.md`](./host-capabilities.md)**（2026-09-25 拆分，因本文件已超
> Trellis 的 `context_injection.max_file_bytes` 上限、继续增长会被静默截断）。
> 该节含：确认对话框适配器 `confirmDialog()` 的 7 段式契约、错误矩阵、测试点与 Wrong/Correct 对照。

---

## Host Capability Acquisition

> **已迁至 [`host-capabilities.md`](./host-capabilities.md)**（2026-09-25 同上拆分）。
> 该节含：宿主能力获取决策树（`getContext()` 优先 → 已注明理由的根绝对路径 import → 静默降级）、
> 根绝对路径为何跨宿主可达、形状校验优先于「加载成功」、降级反例的正确构造法（含 404 踩坑记录）、
> 现存能力面与获取方式表、以及「宿主能力差异用显式声明表，禁止布尔推导」。
>
> 同文件另含 **「UI 控件的合宪性：任何控件必须有消费点」**（死控件的三步取证法 + 处置约定 +
> 概念撞名禁令 + 文档不要写死节点数）。

---

## Platform-Specific Notices in UI (平台差异提示)

- **SillyTavern 备份端点不含 `secrets.json`**：ST 的 `/api/users/backup` 服务端默认排除密钥文件；Luker 的选择项可带 `secrets: true`。UI 必须明确告知用户这一差异。
  > ⚠ **本仓已无 CLI**（`cli.js` 已随 09-04 统一工作台重构删除）。提示文案**禁止**再引用任何「用 xx CLI 处理」的说法。
- **ST 目标的手动导入说明**写死在 `src/core/transform.js` 的 `INSTALL_MD` 常量里，随 ST 目标产物落盘（解压后覆盖到 `data/<handle>/`，含「覆盖前请先备份原目录。secrets.json 已包含在本包内(会覆盖现有密钥)。」）。改文案请改该常量。
- **报告不截断**：`src/ui/view.js` 把报告拆成三个折叠屏，各自带条数——丢弃项（`丢弃项清单 (N 条 - 派生缓存或不兼容)`）、脱敏排除项（`脱敏与排除清单 (N 条 - 按类目主动过滤)`）、警告项（`警告与适配提示 (N 条)`），**全量**写入，不再有「只显示前 10 条」的截断。
- **恢复模式必须让用户显式选择**：`增量合并 (推荐)` / `全量覆盖` 二选一（`index.html` 与模板中的 `#restore-modal`），不得默认静默覆盖宿主数据。

---

## CSS Scoping Mandate (Luker UI 异常教训 · 2026-09-07)

**严禁全局选择器泄漏到宿主页面。** 插件 CSS 在宿主环境注入时，`*`、`body`、`:root`、页面级 `::-webkit-scrollbar` 会覆盖宿主主题与布局——实测曾把 Luker 的浅色主题变量 `--SmartThemeBodyColor` 覆盖为黑曜底色并把宿主 body 强制改为 flex 布局（即"Luker UI 变得很奇怪"的根因）。

约定：

1. **变量定义域**：所有 CSS 变量定义在双容器选择器上（`style.css:8` 起），配色一律继承宿主变量 + 回退值：
   ```css
   /* style.css（节选，实际内容以此为准） */
   .app-container,
   .st-converter-drawer-app {
     --bg-primary: var(--SmartThemeBodyColor, #14161c);
     --border-color: var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.14));
     --accent: var(--SmartThemeQuoteColor, #f59e0b);
     --text-main: var(--SmartThemeBodyColorInverted, #f2f4f8);
     /* ... */
   }
   ```
   **严禁在此硬编码覆盖宿主 `--SmartTheme*` 变量**（09-07 金色系教训：回退值只是独立态的中性深色，不是品牌色）。
2. **reset 范围**：通配 reset 只允许容器内前缀形式 `.app-container *, .st-converter-drawer-app *`。
3. **body 骨架**：独立/模态态用 `body:has(> .app-container)`（页面背景与布局）与 `body:has(> .st-converter-modal-overlay) ...`（模态态）；插件模式**绝不触碰宿主 body**。
4. **滚动条**：页面级 `::-webkit-scrollbar` 必须写成容器后代选择器。
5. **新增样式自查**：跑 `npm run check:css-scope`（见下方自动化守卫），而不是只 grep 行首——行级 grep 会漏掉 `@media` 内嵌规则与逗号分支。

## Host Detection Protocol (宿主识别协议 · 2026-09-07)

Luker 前端**同时暴露** `globalThis.SillyTavern`（script.js:360 `= lukerApi`）与 `globalThis.lukerContext`（scripts/lukerContext.js）。`window.luker` 与 `#luker-app` 在 Luker 实例中不存在（死信号）。判定协议：

1. **前端判定（detectHost）**：`globalThis.lukerContext` 存在（try/catch 惰性 getter）→ luker；否则 `SillyTavern` 存在或 `#extensionsMenu` → st；否则 standalone。**顺序不可颠倒。**
2. **服务端校验（verifyHostPlatform）**：`GET /version`。Luker 形状 `{agent:"Luker:2.7.0:...", stCompatVersion, pkgVersion}`；ST 形状 `{version}` 或 `{agent:"SillyTavern:..."}`。`agent` 前缀或 `stCompatVersion` 字段存在 → luker。不一致以服务端为准并 logger.warn。
3. **导出后软校验（validateBackupShape）**：Luker 导出含 manifest.json，ST 导出不含；不一致仅告警不阻断。
4. **ST 宿主 selection 限制**：ST `/api/users/backup` 全量 glob 导出忽略 selection 参数——ST 宿主必须请求 `FULL_SELECTION`，类目勾选由插件内 transform 过滤生效；Luker 直接透传 selection。
5. **平台码 vs 布局码（双轨制，高频坑）**：`detectHost()` 给的是**平台码** `st | luker | standalone`，而 `convert()` 只认**布局码** `st | l | tt | pt`（`src/core/transform.js` 的 `TARGETS`）；把宿主平台传给 `convert()` 或文件名模板前必须经 `hostLayoutCode()` 归一（`luker → l`），否则抛 `convert: target 必须是 st|l|tt|pt 之一`。两端点调用则相反、要传平台码。
   > 完整表述（含端点侧的权威说明）见 [Hook Guidelines](./hook-guidelines.md) —— **那一处才是权威**，本节仅作指路，不要在此另起一套说法。

---

## Single Template Source Mandate (单一模板源 · 2026-09-25 取代原「双模板同源同改」)

> **本节取代旧条目**（AGENTS.md L1-MR-10 的「两份副本必须同源同改」）。
> 2026-09-25 起**不再有两份副本**，因此「同源同改」这条铁律在本仓**已不适用**——
> 改为「只允许一个源」的结构性保证。旧条目的历史事故见本节末。

**现行结构**：`index.html` 是**空骨架**，`src/ui/workbench-template.js` 的 `getWorkbenchHtml(opts)` 是**唯一**的结构来源。

```
index.html（骨架，约 22 行）
  └─ <div id="app" class="app-container"></div>   ← 空容器，无任何业务节点
        ↑ bootstrap() 检测到 #app 存在且为空时注入
     getWorkbenchHtml({ isStandalone: true })
```

三个入口共用同一函数（`src/ui/workbench-template.js:28`）：

| 入口 | 调用 | 差异 |
| --- | --- | --- |
| 独立 Web | `getWorkbenchHtml({ isStandalone: true })`（`index.js` 的 `bootstrap()`） | `chrome = !isDrawer` → 有页头/页脚 |
| 插件抽屉态 | `mountSettingsDrawer()` → `getWorkbenchHtml({ isDrawer: true })` | 不出页头；多一个 `#status-row` 与 `#btn-storage-inspector` 存储入口 |
| 模态态 | `openConverterModal()` → `getWorkbenchHtml({ isModal: true })` | 多一个 `#btn-close-converter-modal` 关闭按钮 |

**三态唯一允许的分支差异就是上表右列**，业务节点集合必须完全一致。

### 机器断言（不得只靠人眼）

`test/single-template-source.test.js` 用 `it.each` 对三态各跑一遍，断言：

1. 三态均产出全部必需业务节点 id（清单源：`scripts/single-template-source.js` 的 `REQUIRED_TEMPLATE_IDS`，
   **节点数由该数组决定，本文件不写死数字**）→ `missing` 必须为空数组；
2. 折叠区为宿主原生 `inline-drawer`，且**不得**回退到 `<details>`；
3. 三态的分支差异被**正向断言**锁死：`isModal` 才有 `btn-close-converter-modal`、`isStandalone` 没有；`isDrawer` 才不出 `class="app-header"`、才有 `btn-storage-inspector`。

守卫 `npm run check:template-source`（`scripts/single-template-source.js`）双向扫：

- 扫 `index.html`：出现业务节点 id、`menu_button` / `inline-drawer` 等宿主原生类 → 违规（只有 `app` 在白名单 `ALLOWED_STANDALONE_IDS` 内）；
- 扫 `src/ui/workbench-template.js`：缺少 `REQUIRED_TEMPLATE_IDS` 中的任一节点 → 违规。
- 输出约定沿用 `scripts/css-scope.js`：`文件:行号`，违规退出码 1。

### 历史事故（旧「双模板」时期的真实偏差）

`index.html` 曾是 441 行旧多抽屉结构（含 `#workspace-panel` / `#host-export-card` / `#btn-clear-workspace`），
与插件态的 `workbench-template.js`（`wb-block` 两块式）**已经分歧**，
后果是独立态 `refreshArchiveManagerUI()` 在 `getElementById('stash-list')` 为空时直接 return（L1-MR-10 违规）。
`test/single-template-source.test.js` 保留了反向断言，确保这些旧节点**不得复活**：

```javascript
expect(html).not.toContain('workspace-panel');
expect(html).not.toContain('host-export-card');
expect(html).not.toContain('btn-clear-workspace');
```

## Export Queue Pattern (统一待导出区 · 2026-09-07)

所有产物（宿主直出 / 转换生成 / 增量补丁 / 分卷）都先进内存态 `ExportQueue`（`src/ui/export-queue.js`），**不**直接写 IndexedDB、也不自动触发下载：

- `enqueue({ blob, name, targetLayout, origin, ephemeral, autoDownload })`——`ephemeral: true` 的临时产物只在「下载」或「存工作区」时才落库，避免重复存储；
- `stash()` 写入 `files` store 并带上条目的 `origin`，统一工作区列表据此打来源徽标；
- 分卷产物必须 `origin: 'split-part'` 入队（**不得**直接调 `saveFile`）；
- `src/ui/split-deliver-modal.js` 是**待清理死代码**：`renderSplitDeliveryModal` 在 `index.js` 里被 import 但**全仓无调用点**，该文件因此持有 `dom-injection-guard:allow-file` 整文件豁免（见 `scripts/dom-injection-guard.js`）。接回或删除前，不要把它当作可用参考实现。

### Escalation (2026-09-07 第二次诊断)：裸原生类选择器同样是污染

上面那条作用域约定当时**不完整**，而且这个遗漏真的发到了用户实例上。
除了 `:root` / `body` / `*` / 滚动条规则之外，**裸的酒馆原生类选择器**同样会污染宿主：
`.menu_button`（宿主样式表内 39 条原生规则）、`.inline-drawer`（13 条）、`.text_pole`、`.checkbox_label`、`.flex-container`、`.flex1`、`.badge`……
插件 `<style>` 里一条无作用域的 `.menu_button { ... }` 会重排宿主 UI 的**每一个**按钮（含顶栏）——当时实测：注入插件 CSS 后宿主 chrome 上出现 5 处计算样式差异。

**绝对规则**：`style.css` 中**每一个**选择器都必须以 `.app-container `（独立态祖先）或 `.st-converter-drawer-app `（插件挂载点）开头。
不存在「看起来只在插件里用」的例外——宿主用的就是同一套设计系统。

### Automated guard (2026-09-23)：行级 grep 已不够

grep 只能看到顶层规则行；嵌在 `@media` / `@supports` 里的裸选择器、以及逗号选择器列表中的任一分支，会被完整漏掉（真实回归：两个响应式 `@media` 块里带着裸的 `body`、`.app-header`、`.controls-row` …）。

**规则**：每一个选择器——顶层的、嵌套的、逗号分隔的每一支——都必须以 `.app-container` / `.st-converter-drawer-app` 为作用域根。
脚本额外宽容两类形：

- 独立态骨架：`body:has(> .<class>)` 形式（当前实际用到两个：`body:has(> .app-container)`、`body:has(> .st-converter-modal-overlay) ...`）；
- `@keyframes` 内的百分比帧不是元素选择器，直接跳过。

守卫：`npm run check:css-scope`（`scripts/css-scope.js` 用 PostCSS AST 走查，单测在 `test/css-scope.test.js`）必须通过，输出为 `CSS 作用域检查通过：style.css`。
PostCSS 只是 devDependency，用于这条解析期守卫，**不进浏览器运行时**。

### Guard commands (四条静态守卫)

```bash
npm run check:css-scope         # CSS 作用域：根必须为本插件自有容器，且主体不得是 body/html/:root/*
npm run check:dom-injection     # innerHTML/outerHTML/insertAdjacentHTML 不得有未转义插值
npm run check:template-source   # index.html 只许骨架；业务节点必须全部定义于 workbench-template.js
npm run check:control-consumer  # 每个交互控件必须有消费点声明（防死控件）+ 声明表不得含僵尸条目
```

四条都可以单独跑（无需 `npm test`）。DOM 注入守卫的豁免约定：单条语句用 `dom-injection-guard:allow <理由>` 注释，整文件用 `dom-injection-guard:allow-file <理由>`（当前仅死代码 `src/ui/split-deliver-modal.js` 使用）。
第三条守卫的判据与三态一致性断言见上文「Single Template Source Mandate」。
第四条守卫的由来与局限见 [`host-capabilities.md`](./host-capabilities.md) 的「UI 控件的合宪性」一节。

---

## 样式作用域：主体检查 + id 双条件（2026-09-25，有实测事故）

### 背景：两条真实的越界路径

`style.css` **同时被独立态与插件态加载**，所以「选择器是否含本插件前缀」**不等于**「样式只作用于本插件」。
2026-09-25 实测到两条越界：

1. **以 `body` 为主体**：`body:has(> .app-container) { … }`（原独立态页面骨架）——它**含** `.app-container`
   字样，因此通过当时的守卫，但真正的样式主体是 `body`。只要宿主页面里出现 `.app-container` 的
   **body 直接子元素**（宿主仓内确有第三方扩展用该类名，如 `card-app`、
   `character-editor-assistant/studio`），本插件的独立态骨架（当时含 3 层渐变背景、字体、行高）
   就会落到**宿主 body** 上。
2. **只按类名限定根**：`.app-container { width:100%; max-width:840px; … }`（以及全部
   `.app-container .x` 后代规则）会命中**任何**带 `app-container` 类名的第三方容器。
   合成页实测（`body > .app-container.third-party`）：第三方容器被压成 **840px 列**。

### 现行契约（违反即返工）

- **根选择器**：独立态/模态态一律写 **`#app.app-container`**（本插件两处根
  ——`index.html` 骨架、`index.js` 的模态容器——都带 `id="app"`）；抽屉态写 `.st-converter-drawer-app`；
  模态覆盖层写 `#st-converter-modal-overlay`。**裸 `.app-container` 一律不允许**（守卫会拦）。
- **主体禁止**：任何选择器的**最后一个复合选择器**（主体）不得是 `body`/`html`/`:root`。
  （`*` 允许出现在容器之后，如 `#app.app-container *`；裸 `* { … }` 会被根检查拦下。）
- **独立态专属样式**（页面背景/居中/最小高度）必须挂在 **marker 类**
  `#app.app-container.app-standalone` 上——marker 只出现在 `index.html` 骨架里，第三方不可能带。
  满屏底色用 `::before { position: fixed; inset: 0; z-index: -1 }` 实现，避免把「满屏底色」
  与「840px 内容列宽」挤在同一元素上。
- **插件自身配色**一律 `var(--SmartTheme*, 回退值)`，**禁止渐变**与硬编码品牌色
  （2026-09-25 清理：`style.css` 8 处 `gradient` 全部改纯色 `var(--accent)`）。
  宿主页上的自绘弹窗（如扩展安装器模态）同样如此；JS 侧 `style.color = '…'` **不接受 `var()`**，
  须经 `hostBridge` 的 `themeAccent()` / `themeVar()` 读真实值。

### 守卫的判据（`scripts/css-scope.js`）

对每条规则的每个逗号分支：① 主体不得是全局元素 → 违规；② 根必须是上列自有容器 → 否则违规。
负例在 `test/css-scope.test.js`（16 例），含 `body:has(> .app-container)`、`.app-container, body`、
`html body …`、裸 `*`、`:root`、裸 `.app-container`——改前会通过、改后必须拦截。

### 验证手段（可复用）

- 独立态布局回归：计算样式读数（容器宽 864 / 内容 840、左右留白相等、`body` 背景 `none`）。
- 越界消除：合成页 `body > .app-container.third-party` → 断言第三方容器为视口自然宽、
  `body` 背景/字体/内边距全程未被改动。

### 附：dev server 端口必须显式声明（同日事故）

本仓 `vite` **不能**用默认端口：env-sync 桌面应用的 Tauri `devUrl` 就是
`http://localhost:5173`（`env-sync/app/src-tauri/tauri.conf.json`），占用它会让该 GUI 窗口
加载到**本插件页面**。现约定：`server.port = 3040`、`preview.port = 4173`，均 `strictPort: true`
（端口被占时**直接失败**，不得静默顺延）。
