# host-detect 终验记录（Phase 5）

> 验证日期：2026-09-07 · 全部为真机实测结论

## 1. 宿主识别验证（Playwright 实测 Luker 8004 真机）

- Luker 实例全局对象：`hasSillyTavern: true`，`hasLukerContext: true`，`#extensionsMenu: false`，`#luker-app: false`
  → 证实旧代码（依赖 window.luker / #luker-app 死信号 + SillyTavern 判 st）**必然把 Luker 误判为 ST**。
- 新 `detectHost()` 在 Luker 真机返回 `{platform:'luker', confidence:'frontend'}` ✓
- 新 `verifyHostPlatform()` 服务端校验返回 `{platform:'luker', verified:true, version:'Luker:2.7.0:Cohee#1207'}` ✓（与前端判定一致）
- 独立页面（about:blank）返回 `standalone` ✓
- 单测判定矩阵 13 项全过（test/detect-host.test.js）：含 lukerContext 惰性 getter 抛错回退路径。

## 2. Luker UI 异常根因与修复验证（真机前后对比）

**根因**（旧 CSS 注入 Luker 页面实测 diff）：
| 指标 | Luker 原生 | 注入旧 CSS 后 |
|------|-----------|--------------|
| body display | block | **flex（被劫持）** |
| body padding | 0 | **20px 12px** |
| body min-height | 0 | **720px** |
| body 背景 | none | **琥珀渐变** |
| --SmartThemeBodyColor | rgb(220,220,210) 浅色 | **#0d1017 黑曜底** |

→ 插件独立模式的页面骨架规则（`*`、`body`、`:root`、`::-webkit-scrollbar`）全局泄漏，覆盖宿主主题变量与 body 布局，即用户看到的"Luker UI 变得很奇怪"。

**修复**：`style.css` 全局规则全部作用域化——变量定义在 `.app-container, .st-converter-drawer-app` 双容器；reset 收窄为容器内 `*`；body 骨架改 `body:has(> .app-container)`（仅独立模式）；滚动条规则限定容器内。

**验证**：
- 新 CSS 注入 Luker 页面：宿主 body/变量/按钮样式 **零变化** ✓
- 独立 Web 模式（vite preview 真机渲染）：flex 居中、渐变背景、840px 容器、变量、抽屉圆角全部正常 ✓（截图 standalone-ui-check.png）

## 3. 回归

- `npm test`：20 套件，**118 passed / 2 skipped**（基线 105 + 新增 13）全绿。
- `npm run build`：701ms 构建成功，无新警告（zip-io node:fs 外部化提示为既有已知项）。

## 4. 遗留与移交

- ST 实例当前未运行（config 端口 8002），ST 真机双实测留待 ui-unify 子任务的 host-flow.spec 一并执行（端点形状已知：`{version}` 或含 agent 的形状，协议已兼容两种）。
- style.css 作用域化后新增组件样式必须继续挂在 `.app-container` / `.st-converter-drawer-app` 容器前缀下（写入 spec 的约定）。
- 临时验证脚本（pw-*.cjs）保留在 research/ 供复用；Playwright 通过全局安装（C:/nvm4w/nodejs/node_modules/playwright）调用，未入项目依赖。
