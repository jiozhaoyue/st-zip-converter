# 样式越界与 dev 端口占位 — 技术设计

> 上游：`prd.md`（Requirements / AC）。本文件只写技术设计与取舍。

## 1. R1 端口：让出 5173

### 1.1 现状

- 本仓 `npm run dev` → `vite`（无端口声明）→ 默认 **5173**，`host` 绑定 `[::1]`。
- env-sync 的 Tauri devUrl 固定 5173（`app/src-tauri/tauri.conf.json:8`），其 webapp `dev` 也是裸 `vite`。

### 1.2 改法

```js
// vite.config.js（新增 server/preview 段）
server: { port: 3040, strictPort: true },
preview: { port: 4173, strictPort: true },   // 4173 已在 L0-16 登记为 Vite preview
```

- `strictPort: true` 是**关键**：端口被占时**直接失败**而不是静默顺延（顺延会让「谁的页面」再次错位）。
- 端口选号：`3040`（L0-16 段位 3010 起、间隔 10；3010 Viewer / 3020 Headless / 3030 PureTavern remote-server）。
  落地前先探测 `3040` 是否被占。

### 1.3 为什么要在本仓改而不是改 env-sync

env-sync 的 devUrl 是它自己的既定配置；**冲突的成因是本仓占用了通用默认端口**。
按 L0-16「出厂默认禁用、需要显式指定」的同一逻辑，本仓显式声明端口即可解除冲突，
且对下游零改动（`tauri.conf.json` 不用动）。

## 2. R2 作用域纠正：`body:has(> .app-container)` 必须消失

### 2.1 三条规则的真实意图与改法

| 现选择器 | 意图 | 改法 |
| --- | --- | --- |
| `style.css:68` `body:has(> .app-container)` | 给**独立态**页面骨架上背景/字体/行高 | 主体改为独立态根：**`#app.app-container`**（`index.html` 的根是 `id="app"` + `class="app-container"`，插件态不会出现该 id）。字体/行高等继承属性落在该容器上即可覆盖独立态整页 |
| `style.css:1798`（媒体查询内）同上 | 独立态窄屏骨架 | 同样改为主体 `#app.app-container` |
| `style.css:1961` `body:has(> .st-converter-modal-overlay) .app-container` | 模态打开时约束容器 | 主体改为 `.app-container`，条件改用 `:has()` 于容器自身：`.app-container:has(> .st-converter-modal-overlay)`；若结构性不可行，则在模态 open/close 时给容器加 `.is-modal-open` 类（JS 侧一行，仍不碰宿主 body） |

### 2.2 为什么不能只删条件

`body` 上的 `font-family` / `line-height` 是**继承属性**，删掉会改变独立态排版；
迁到 `#app.app-container` 后继承链仍完整（body → #app → 后代），视觉等价。

### 2.3 显式取舍

- 插件态（`.st-converter-drawer-app`）**本来就不该**靠 `body:has(...)` 生效，故改动对其零影响。
- 完成后 `style.css` 中 `body` 字样应**只出现在注释里**。

## 3. R3 守卫补洞：`check:css-scope` 增加「主体检查」

### 3.1 盲点

现守卫是「每条规则的选择器**包含** `.app-container` 或 `.st-converter-drawer-app`」——
是个**子串检查**，`body:has(> .app-container)` 因此过关，而它真正的样式主体是 `body`。

### 3.2 补法（PostCSS AST，落在 `scripts/css-scope.js`）

对每条规则的 selector 逐个（逗号分隔的）复合选择器取**最后一个 compound**，判定其
**首个 token**：

- 若为类型选择器且名为 `body` / `html` → **失败**
- 若为 `:root` 伪类或 `*` 通用选择器 → **失败**
- 其余照旧要求包含双前缀之一

### 3.3 必须带负例

新增守卫的**负例测试**（改前失败、改后通过）是这条的唯一可信度来源：
构造 `body:has(> .app-container) { color: red }` 断言守卫报错。
同时把 `style.css:68/1798/1961` 作为**回归样本**纳入守卫测试的输入。

## 4. R4 配色：去渐变、去硬编码

### 4.1 渐变（8 处）

| 行 | 用途 | 替换 |
| --- | --- | --- |
| 72-74 | 独立态 body 背景（3 层渐变） | 单一 `var(--bg-primary)` 纯色（或 `color-mix` 与变量混合，不再用字面 `rgba()`） |
| 153 / 231 / 1464 | 头部/卡片/模态顶部的「高光条」 | 纯色 `var(--accent)` 或直接删除（装饰性，用户已明确不要特效） |
| 916 | 批量转换按钮 | `var(--SmartThemeQuoteColor…)` 之类主题色纯色 |
| 2284 | 配额进度条填充 | `var(--accent)` 纯色 |

原则：**装饰性渐变一律删**（用户要「简洁、像酒馆原生」）；有信息含义的（进度条）改纯色。

### 4.2 硬编码颜色

`style.css` 与 `host-bridge.js` 的 `style.cssText` 中的 `#rrggbb` / `rgba()`：
一律替换为 `var(--SmartTheme*, 回退值)`；回退值允许，但**不得**再出现与宿主主题无关的品牌色。

### 4.3 安装器模态（`host-bridge.js`，挂 `document.body` + 内联硬编码）

- **本次（推荐 (b)）**：保留自绘结构，但把内联硬编码换成宿主变量
  （`var(--SmartThemeBlurTintColor)` / `--SmartThemeBodyColor` / `--SmartThemeBorderColor` …），
  并在无宿主变量时有中性回退。
- **后续（(a)）**：迁移到宿主原生 Popup（`callGenericPopup`）——改动大，需重排交互，
  记为独立后续项（不在本任务 AC 内）。
- 无论 (a)/(b)，都**不得**再把自绘深色配色写到 body 级元素上而不继承主题。

## 5. R6 复现实验（先复现，再归因）

1. 在 Dev Luker 8003 上安装/启用一个「可能挂 `.app-container` 到 body」的扩展
   （宿主仓内候选：`card-app`、`character-editor-assistant`）。
2. 打开发送面板，用探针 `research/pw-scope-hit-probe.cjs` 轮询：
   `document.body.matches('body:has(> .app-container)')`、`body` 的 `backgroundImage`、
   以及 `.app-container` 的父链。
3. 若翻转 → **复现成功**：记录触发路径 + 修复前后对比（同一实验重复一次）。
4. 若始终不翻转 → 如实标注**未复现**，并把「宿主原生弹窗渐变」的来源另案排查
   （可能是宿主主题/其他扩展），不得硬说是本插件。

## 6. 验证矩阵

| 层 | 手段 |
| --- | --- |
| 守卫单测 | `check:css-scope` 负例 + 三处回归样本 |
| grep 复核 | `grep -nE "^\s*(body|html|:root|\*)" style.css` 零命中；`grep -c gradient style.css` 为 0 |
| 端口 | `npm run dev` 输出端口 + `curl localhost:5173` 不再是本仓页面 |
| 实机 | Dev 8003 复现实验；env-sync dev 窗口标题/DOM 取证 |
| 回归 | `npm test`（基线 44/406/2）+ 四条守卫 0 + `npm run build` |

## 7. 风险与回滚

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 改 `body` 规则导致独立态排版变化 | 独立态外观回归 | 迁移继承属性到 `#app.app-container`，改造后逐项比对独立态截图/计算样式 |
| 去渐变后视觉过简 | 观感变化 | 用户明确要求简洁与酒馆配色，按主题色纯色即可 |
| 端口 3040 被占 | dev 起不来 | 先探测；被占则顺延 3050 并登记 |
| 守卫补洞误伤既有规则 | CI 红 | 先跑守卫收集现有违规清单，再逐条修，最后开启严格模式 |
| 复现失败 | 归因不确定 | 如实标注未复现（PRD AC 已写入该要求） |

**回滚**：R1（端口）与 R2/R3/R4（样式+守卫）分两次提交，可独立回滚；守卫补洞与其样式修改
必须同批（否则守卫会红）。
