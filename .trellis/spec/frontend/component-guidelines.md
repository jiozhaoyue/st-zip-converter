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
  anchor.parentElement.insertBefore(makeButton(...), anchor.nextSibling);
});
```

四个注入点（**只注入「整包 ZIP 级」入口**，单体导出如单聊天/单角色卡/单世界书**不注入**）：

| 函数 | 锚点 | 说明 |
| --- | --- | --- |
| `mountSettingsDrawer()` | `#extensions_settings2` / `#extensions_settings` | 工作台主抽屉（`getWorkbenchHtml({ isDrawer: true })`） |
| `registerMenuButton()` | `#extensionsMenu .list-group` | 扩展菜单入口（兼容保留，点击后展开上述抽屉） |
| `mountNativeBackupButton()` | `.userBackupButton`（账号弹层 + 管理面板每用户行） | 「数据包互转」+（仅账号弹层）「一键拉取」 |
| `mountLukerBackupManagerButton()` | `.userBackupManager .backupActionRow` | 仅 Luker 有该锚点，其余宿主自然无操作 |

> **无锚点时不造浮层**：找不到锚点就什么都不做，等 observer 下次触发。**不要**自造右下角浮动按钮之类的非官方挂载点（UI 落点只认官方文档记载的位置）。

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

## Dual-Template Sync Mandate (多入口同源同改铁律 · AGENTS.md L1-MR-10)

同一套 UI 有**两份独立维护的副本**：独立态 `index.html`（静态 markup，Vite 不经过模板模块处理，`index.js` 直接操作其 DOM）与插件态 `src/ui/workbench-template.js`（`getWorkbenchHtml()`，经 `mountSettingsDrawer` 与模态路径注入）。

**铁律**：任何结构改动（新增元素 id、区块重组）必须在**同一次提交内同时改两处**，否则某一种入口静默失效。

改动清单：
1. 改 `src/ui/workbench-template.js`
2. 同步改 `index.html`
3. 对触碰到的 id 在两处各查一次：`grep -c "<new-id>" index.html src/ui/workbench-template.js` —— 两处都须 ≥1
4. 独立态实机验证：`npm run dev` 打开 `http://localhost:5173`，确认新元素在 DOM 中

### 已知偏差（2026-09-24 静态核对 · 未实机验证）

两副本**当前已分歧**：

- `src/ui/workbench-template.js` 已是两块式（`wb-block` / `#stash-list` / `#stash-batch-bar` / `#log-console-mount`）；
- `index.html` 仍是旧版多抽屉布局（`#host-export-card` / `#workspace-panel-drawer` / `#workspace-archive-list`），**不含** `wb-block`、`#stash-list`、`#stash-batch-bar`、`#log-console-mount`；
- 后果：`index.js` 的 `refreshArchiveManagerUI()` 在 `getElementById('stash-list')` 为空时**直接 return**（`index.js:257`）。

证据（静态可证）：`grep -n "stash-list\|wb-block\|log-console-mount" index.html` → 无命中。

**待验证**（验证方法）：独立 Web 模式下「上传暂存区列表」是否真的不渲染——`npm run dev` 后拖入一个 zip，观察 `#workspace-archive-list` 是否始终为空。
**在验证之前，不要以任一侧为「正确版本」去删改另一侧。**

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

### Guard commands (两条静态守卫)

```bash
npm run check:css-scope        # CSS 作用域：每条选择器必须根在 .app-container / .st-converter-drawer-app
npm run check:dom-injection    # innerHTML/outerHTML/insertAdjacentHTML 不得有未转义插值
```

两条都可以单独跑（无需 `npm test`）。DOM 注入守卫的豁免约定：单条语句用 `dom-injection-guard:allow <理由>` 注释，整文件用 `dom-injection-guard:allow-file <理由>`（当前仅死代码 `src/ui/split-deliver-modal.js` 使用）。
