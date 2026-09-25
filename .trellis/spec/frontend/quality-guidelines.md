# Quality Guidelines (前端 / 浏览器插件形态)

> 验证矩阵、守卫命令、转义层契约、禁止模式与实测教训。
> **本文事实以 2026-09-24 仓库状态为准**；无法证实者标注「待验证」。

---

## Overview

本项目是**发给用户装进酒馆的扩展/工具插件**，同时能独立运行。因此前端改动额外承担两条责任：
①**不能弄坏别人酒馆**（样式/脚本泄漏会污染宿主全站 UI）；②**装完即可用**（用户不跑构建）。

---

## 验证矩阵（前端改动必须全过）

| 类别 | 命令 | 标准 |
|---|---|---|
| 全量测试 | `npm test` | **39 个测试文件 / 333 passed / 2 skipped**（2026-09-25 快照）。不得低于基线、零回归。 |
| CSS 作用域守卫 | `npm run check:css-scope` | `style.css` 每条规则必须以 `.app-container` 或 `.st-converter-drawer-app` 为作用域根。退出码 0。 |
| DOM 注入守卫 | `npm run check:dom-injection` | `src/ui/**` 与根 `index.js` 的 `innerHTML` / `outerHTML` / `insertAdjacentHTML` 不得含未转义插值。退出码 0。 |
| 单一模板源守卫 | `npm run check:template-source` | `index.html` 只许骨架（业务节点 id 仅 `app` 在白名单内）；`REQUIRED_TEMPLATE_IDS` 全部须定义于 `src/ui/workbench-template.js`。退出码 0。 |
| 宿主行为冒烟 | `npm run dev` + **Dev** 实例 | Dev ST `8001` / Dev Luker `8003`；**默认严禁** Real 实例（`8002` / `8004`）——见下表下方注。 |

> **Real 实例（8004）例外口径**：仅当**该任务**获用户明确授权时才可对 Real 采样，
> 且必须同时满足：① **只读**（不调写端点、不触发转换落盘/覆盖/删除、不写 `Instance/**` 业务数据）；
> ② 需要装载待验提交时走 `git fetch` + `checkout FETCH_HEAD`，**采样后立即 `git checkout -f main` 还原**，
> 并以 `git -C <实例插件目录> status --short` **为空**作为收尾核对项。
>
> 本项目**没有** `lint` / `typecheck` / `build:plugins` 命令。类型契约靠 JSDoc + 运行时守卫。
> 产物是静态站点（`npm run build` = `vite build --base=./`）；插件形态由 `src/ui/host-bridge.js`
> 在宿主页面内注入，**不存在 IIFE 打包、不存在包体积预算（200 KiB）、不存在 CLI**。

---

## 守卫命令与豁免机制

### `npm run check:css-scope`（`scripts/css-scope.js`）
PostCSS AST 解析 `style.css`，覆盖 `@media` / `@supports` 等嵌套规则与逗号分隔的每条选择器。
行级 grep（如 `grep -n "^body"`）**会漏掉嵌套规则**，不可替代守卫。
`@keyframes` 帧规则不作为元素选择器检查；独立页面骨架规则 `body:has(> .app-container)` 是有意保留的例外。

### `npm run check:dom-injection`（`scripts/dom-injection-guard.js`）
扫描 `src/ui/**` 与根 `index.js`，凡 `innerHTML` / `outerHTML` / `insertAdjacentHTML` 的右值：

- 模板插值必须以 `escapeHtml(` 或 `trustedStaticMarkup(` 开头；
- 右值为变量或函数调用时必须显式包裹 `trustedStaticMarkup(...)`；
- 语句所在行或上一行可加 `dom-injection-guard:allow <理由>` 做**语句级豁免**；
- 文件首部可加 `dom-injection-guard:allow-file <理由>` 做**整文件豁免**
  （当前仅 `src/ui/split-deliver-modal.js` 死代码使用）。

审计全部豁免点：

```bash
grep -rn "dom-injection-guard:" src/ index.js
grep -rn "trustedStaticMarkup(" src/ index.js
```

---

## 转义层契约（`src/ui/escape.js`，全仓唯一实现）

| 导出 | 语义 |
|---|---|
| `escapeHtml(value)` | 转义 `&` `<` `>` `"` `'` **五个**字符（元素上下文 + 属性上下文通用）。`null` / `undefined` 视为空串。 |
| `isSafeHttpUrl(value)` | 仅 `http` / `https` 放行，拒绝 `javascript:` / `data:` / `vbscript:`。用于**渲染期**把关 URL。 |
| `trustedStaticMarkup(markup)` | 恒等函数，**仅用于标注可信静态 HTML 片段**。命名刻意冗长刺眼——凡见到它，必须人工确认入参不含任何变量或外部输入。 |

**禁止**在各模块自建转义函数。历史教训：`log-console.js` 曾自带只覆盖 3 个字符的私有实现，
漏掉引号转义意味着该值一旦落入属性位置仍可越出属性边界。

---

## 禁止模式

1. **裸 CSS 选择器**（**2026-09 已实际发生并修复的事故**）
   - ❌ `.menu_button` / `.inline-drawer` / `.text_pole` / `.checkbox_label` 等酒馆全站类，以及 `*` / `body` / `:root`
   - ✅ 一切规则以 `.app-container` 或 `.st-converter-drawer-app` 为根
   - 后果：酒馆是单页应用，注入样式与宿主共享同一文档 → **用户整个酒馆界面被破坏**，且用户会认为是酒馆本身坏了。

2. **硬编码配色覆盖宿主主题**
   - ❌ 写死品牌色（金色系教训）覆盖 `--SmartTheme*`
   - ✅ 一律 `var(--SmartThemeQuoteColor, #回退值)` 形式，且必须带回退值

3. **`innerHTML` 插值用户可控数据**
   - ❌ 上传 ZIP 内的文件名/扩展名、包内 JSON 字段（如 `_convert/extensions-manifest.json`）、宿主响应正文、`err.message` 直接插值
   - ✅ `textContent` / `createElement`，或 `escapeHtml(...)` 包裹；静态片段用 `trustedStaticMarkup(...)` 标注
   - 后果：**存储型 XSS**——攻击者分发数据包即可在受害者酒馆同源页面执行任意脚本（可读 `/csrf-token` 与全部聊天）。

4. **无界等待**
   - ❌ 对 fetch / 媒体事件（`canplay` / `error` / `onload`）/ 渲染挂载的 `await` 无超时、无 abort、无 destroy 兜底
   - ✅ 必须经超时或 destroy 信号兜底 settle；**禁止 promise 永远 pending**（实测曾导致测试挂死）

5. **高频回调同步驱动 DOM**
   - ❌ 进度回调（约 50 chunk/秒）直接触发重排重绘
   - ✅ 先经 `requestAnimationFrame` 合帧（实测累积出 14 个 80–107ms 长任务，直接卡顿宿主页面）

6. **外部 CDN 依赖 / 要求用户跑构建**
   - ❌ 从 CDN 拉脚本或样式；要求用户执行 `npm install` / `npm run build`
   - ✅ 第三方库以本地副本放进 `src/vendor/`（**勿升级改动**，只用其已有 API）——用户安装路径就是「填一个 Git URL」

7. **向本地酒馆实例目录写入**
   - ❌ 复制/同步任何文件进 `Instance/**`
   - ✅ 实例插件更新只走 Git（`git clone` / `git pull`）或酒馆原生扩展安装器

8. **自造浮层 / 非官方 UI 落点**
   - ❌ 不在官方文档记载的位置挂 UI、自造全屏浮层
   - ✅ 复杂 UI 走官方 Popup；设置页只放设置；无锚点时不注入

9. **裸用 `confirm()` / `window.confirm` 做确认对话框**
   - ❌ 组件层直接 `if (!confirm('确定删除吗？')) return;`
   - ✅ 走 `src/ui/host-bridge.js` 的 `confirmDialog()`（官方文档路径
     `SillyTavern.getContext().Popup.show.confirm`，不可用时静默降级）；组件经 `confirmFn` DI 接缝注入
   - 后果：插件在酒馆里出现原生浏览器弹窗，与宿主 UI 割裂；且组件无法脱离宿主单测
   - 现役接入面：`stash-list.js`（批量删除 / 行内删除）、`export-queue.js`（清空 / 取消在途恢复）

10. **假设「宿主能力必须动态 `import` 宿主模块」**
   - ❌ 认定 `popup.js` 等宿主模块未挂全局，于是放弃原生路径或改走 `import()` 宿主源码路径
   - ✅ **先查官方文档**：ST 与 Luker 的 `public/scripts/st-context.js` 都把 `Popup` / `POPUP_TYPE` /
     `POPUP_RESULT` 挂在 `SillyTavern.getContext()` 上（ST `st-context.js:225`、Luker `st-context.js:2663`），
     `docs.sillytavern.app` 亦记载 `Popup.show.confirm(title, message)`
   - 后果：真实案例——本仓一度据此把「原生确认弹窗」判为需跨任务延期，实际它是**官方文档路径**、
     一次会话即可完成。**凭印象断定 API 不可用，会凭空造出一个假依赖**
   - 另注：宿主路径随安装形态变化（ST 在 `public/scripts/extensions/third-party/**`、
     Luker 在 `data/<user>/extensions/**` 平铺），跨宿主相对路径 `import()` 本就不可靠

---

## 单一模板源（取代原「多入口同源同改」）

> **2026-09-25 起本仓不再有两份 UI 副本**，原「同源同改」自查法（`grep -c` 两处均须 ≥1）**已作废**。

`index.html` 是空骨架（仅 `#app.app-container` + 脚本入口），`src/ui/workbench-template.js` 的
`getWorkbenchHtml(opts)` 是唯一的结构来源，三态（`isStandalone` / `isDrawer` / `isModal`）由同一函数产出。
因此结构改动**只需改一处**，但必须：

1. 跑 `npm run check:template-source`（会同时校验 `index.html` 不含业务节点、模板含全部必需节点）；
2. 跑 `test/single-template-source.test.js` 的三态一致性断言（三态各产出全部 41 个必需节点）；
3. 若新增/删除业务节点，同步更新 `scripts/single-template-source.js` 的 `REQUIRED_TEMPLATE_IDS`——
   **不更新清单等于守卫失效**。

细节与历史事故（旧双副本分歧导致独立态缺失 `#stash-list`）见
[`component-guidelines.md`](./component-guidelines.md) 的 Single Template Source Mandate 一节。

---

## 纯逻辑必须可单测：闭包内的逻辑先抽出来

**问题**：`index.js` 的 `main()` 是个巨大的闭包，逻辑写在里面就**无法被单测覆盖**。
真实案例：分包阈值归一化最初写在 `main()` 内的 `parseSplitInputMb()` 里，
任务验收要求「有单测覆盖非法输入」，却因闭包边界无从下手而长期挂空。

**约定**：凡有**判定/归一/约束语义**的逻辑（哪怕只有几行），抽成 `src/core/**` 或 `src/ui/**` 的
**具名导出纯函数**，闭包内只留 DOM 取值与副作用调用。

```javascript
// ✅ 纯函数在 src/core/splitter.js（可单测，5 条用例）
export function normalizeSplitMb(raw) {
  if (raw === '' || raw === null || raw === undefined) return 0;
  const num = Number(raw);
  if (!Number.isFinite(num)) return 0;
  const asInt = Math.floor(num);
  return asInt >= MIN_SPLIT_MB ? asInt : 0;
}

// index.js 的闭包内只做 DOM 取值
function parseSplitInputMb() {
  return normalizeSplitMb(splitInput ? splitInput.value : null);
}
```

**同类接缝**：需要宿主能力（弹窗、确认对话框）时，组件**不在内部直接调宿主**，
而是声明 `confirmFn` 之类的可选注入参数并在缺省时自行降级——
这样组件的默认路径仍可在 Node 下被单测驱动（见 `component-guidelines.md` 的
Host Native Dialog Adapter 第 7 节）。

---

## Pre-Development Checklist

改 `src/ui/`、`index.html` 或 `style.css` 之前：

- [ ] 读 [`directory-structure.md`](./directory-structure.md) 确认改动落点（`src/core/` **禁止 DOM 依赖**）
- [ ] 新增 DOM 插值一律走 `src/ui/escape.js`；不放行裸 `innerHTML` 插值
- [ ] 新增样式一律带 `.app-container` / `.st-converter-drawer-app` 前缀，配色继承宿主变量
- [ ] 若改动 UI 结构，改 `src/ui/workbench-template.js` **一处即可**，并同步 `REQUIRED_TEMPLATE_IDS` + 跑 `check:template-source`
- [ ] 若涉及高频回调，接 `requestAnimationFrame` 合帧
- [ ] 若涉及 `await`，确认有超时 / abort 兜底
- [ ] 若注入宿主 UI，走共享 `watchHostDom` + `makeHostButton()` 工厂并打 `dataset.stZipInjected` 防重标记
- [ ] 若需确认对话框，走 `host-bridge.js` 的 `confirmDialog()`，组件层经 `confirmFn` 注入（禁裸 `confirm()`）
- [ ] 若有判定/归一逻辑写在 `main()` 闭包里，先抽成具名纯函数再动手

## Quality Check

- [ ] `npm test` 全绿（≥ 333 passed / 2 skipped，零回归）
- [ ] `npm run check:css-scope` 退出码 0
- [ ] `npm run check:dom-injection` 退出码 0
- [ ] `npm run check:template-source` 退出码 0
- [ ] 手测默认只针对 Dev 实例（8001 / 8003）；Real（8004）仅在该任务获明确授权时只读采样，且用后还原实例

---

## 相关文档

- [`subagent-collaboration.md`](../guides/subagent-collaboration.md) —— 子代理派发纪律（来源唯一性 / 并行不阻塞 / 写权限边界）
- [`tavern-datapack-formats.md`](../guides/tavern-datapack-formats.md) —— 四平台包布局、导入语义与互转约定
- `.trellis/tasks/archive/2026-09/09-23-perf-security-audit/research/00-audit-index.md` —— 性能与安全审计汇总索引（「立即修复 / 后续优化」两档）

