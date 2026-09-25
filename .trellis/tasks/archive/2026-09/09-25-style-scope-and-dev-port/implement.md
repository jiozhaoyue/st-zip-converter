# 实施清单（执行阶段 · 复选框随执行实时勾选，禁止事后批量补勾）

> 上游：`prd.md`、`design.md`（§号引用其小节）。`task.py start` 之后才允许改产品代码。

## 0. 前置

- [ ] 0.1 探测登记端口是否可用：`netstat -ano | findstr :3040`（占则顺延 3050，并在 L0-16 登记所选值）。
- [ ] 0.2 用户确认 OQ-3 取舍（安装器模态走「自绘 + 继承变量」还是「宿主原生 Popup」）。
- [ ] 0.3 用户审阅本规划 → `task.py start`。

> 实例口径：只对 **Dev 8003** 做复现实验；**Real 8004 默认不碰**；
> env-sync 仓**只读**（不改其配置）。

## 1. R1 端口让位（提交 A，独立可回滚）

- [ ] 1.1 `vite.config.js` 加 `server.port = <登记端口>` + `strictPort: true`；
      `preview.port = 4173` + `strictPort: true`（4173 已登记）。
- [ ] 1.2 验证：`npm run dev` 输出落在登记端口；`curl http://localhost:5173/` 的 `<title>`
      **不再是** `st-zip-converter`；`curl http://localhost:<登记端口>/` 是本站。
- [ ] 1.3 env-sync dev 窗口复验：窗口内 DOM/标题为 env-sync 自身（由用户或本人用 Tauri 起一次）。
- [ ] 1.4 登记：`CLAUDE.md`/`README`（本仓）写明端口；把所选端口补进 L0-16 段位表（`tavern-harness` 真源，
      属跨仓规则变更 → 若本轮不便动真源，先在本仓记录并标注「待同步真源」）。
- [ ] 1.5 提交 A（`chore(dev): dev server 固定登记端口，让出 Vite 默认 5173`）→ 推送 origin（L0-7）。

**回滚点 A**：`git revert <提交 A>`（env-sync 的冲突会回来，但不影响产品代码）。

## 2. R2/R3 作用域纠正 + 守卫补洞（必须同批）

- [ ] 2.1 先跑一次现有 `npm run check:css-scope` 并**收集现有违规清单**（应包含 `style.css:68/1798/1961`）。
- [ ] 2.2 改写三条规则（design §2.1）：`body:has(> .app-container)` → `#app.app-container`；
      `body:has(> .st-converter-modal-overlay) .app-container` → `.app-container:has(> .st-converter-modal-overlay)`
      或 JS 加 `.is-modal-open` 类（二选一，写明理由）。
- [ ] 2.3 补守卫（design §3.2）：`scripts/css-scope.js` 增「主体不得为 `body`/`html`/`:root`/`*`」检查。
- [ ] 2.4 加**负例**测试：`body:has(> .app-container) { … }` 必须被判失败；
      三处历史样本纳入回归用例（改前失败、改后通过）。
- [ ] 2.5 `grep -nE "^\s*(body|html|:root|\*)" style.css` 零命中（`body` 仅允许出现在注释里）。
- [ ] 2.6 独立态外观回归核对：`npm run dev` 下（独立态）检查背景/字体/行高与改前一致
      （计算样式对比，非肉眼）。

## 3. R4 配色去渐变与硬编码（提交 B 内）

- [ ] 3.1 删/换 8 处 `gradient`（design §4.1）。
- [ ] 3.2 `style.css` 中非 `var(...)` 回退位置的颜色字面量清零；`grep -c gradient style.css` = 0。
- [ ] 3.3 安装器模态（`host-bridge.js` 的 `style.cssText`）改用宿主变量 + 中性回退（按 OQ-3 裁决执行）。
- [ ] 3.4 文案/视觉复核：插件 UI 呈现为酒馆主题色（截图或计算样式读数留证）。

## 4. R6 复现实验（Dev only）

- [ ] 4.1 在 8003 上启用/打开一个可能挂 `.app-container` 到 body 的扩展（候选：`card-app`、
      `character-editor-assistant`），用 `research/pw-scope-hit-probe.cjs` 轮询判定是否翻转。
- [ ] 4.2 **复现成功** → 记录触发路径 + 修复前后 `body` 计算样式对比（同一实验各跑一次），落 `research/`。
- [ ] 4.3 **未复现** → 如实标注「未复现」，并在报告中写明「宿主原生弹窗渐变来源未定位，
      不在本任务断言范围」；**不得**写成已修。

## 5. 收口（Trellis Phase 3）

- [ ] 5.1 逐条回填 `prd.md` AC（现场取证，未取证者保持未勾选并登记残留）。
- [ ] 5.2 spec 更新：`frontend/component-guidelines.md` 或 `quality-guidelines.md` 补
      「作用域检查必须看**主体**，不能只看是否含前缀」+ 负例样本（自包含、带 file:line）。
- [ ] 5.3 `git status --short` 核对范围（L0-17：不得用 `git diff --stat`）。
- [ ] 5.4 提交 + 推送；journal；`task.py finish` → `task.py archive`。

## 子代理纪律（若派发）

- 仅用本平台自带子代理；模型取**能力最低档**（本仓约定 `DeepSeek-V4-Flash[free]`），**禁用 Kimi K3**；
  **并发 ≤3**（免费端点 6 并发实测 502）。
- 派发提示词首行 `Active task: .trellis/tasks/09-25-style-scope-and-dev-port`；任务自包含。
- 本环境已知：`trellis-check` 子代理可能出现「0 工具调用即退出」→ 一次即转主代理自核
  （项目记忆 `trellis-check-subagent-fails-here`）。
