# 执行清单：UI 精简与原生化

> 复选框**随执行实时勾选**（L0-2）。每阶段结束跑一次验证命令，失败则先修复再前进。
> 改动面：模板 + 样式 + 绑定 + `index.html` + 新增守卫；**不动 `src/core/**`**。

## 阶段 0 · 基线固化

- [x] 0.1 改造前基线（8004 插件态，`pw-e1-ui-open.cjs`）：面板高 **1237px**、DOM **276** 节点、按钮 **36**（可见 13）、输入控件 **19**（8 复选框 + 4 单选 + 7 下拉文本）
- [x] 0.2 id 清单落 `research/ids-before.txt`（`index.js` 静态引用 45 个）；`index.html` 旧结构含 85 个 id
- [x] 0.3 绿线基线：`npm test` **36 文件 / 301 passed / 2 skipped**；两守卫通过

## 阶段 1 · 单一模板源（R8）

- [x] 1.1 `getWorkbenchHtml(opts)` 支持三态（`isStandalone` / `isDrawer` / `isModal`），`chrome = !isDrawer` 统一分支
- [x] 1.2 `index.html` 收敛为骨架：仅 `#app.app-container` 空容器 + 样式与脚本入口（**441 行 → 22 行**）
- [x] 1.3 `bootstrap()` 独立态：`#app` 为空时注入 `getWorkbenchHtml({ isStandalone: true })`
- [x] 1.4 `scripts/single-template-source.js` 守卫 + `npm run check:template-source` + `test/single-template-source.test.js`（7 用例）
- [x] 1.5 验证：独立态 **41/41 业务节点存在、0 控制台错误**（骨架化前独立态缺 `#stash-list` / `#task-controls` / `#btn-host-fetch`）

## 阶段 2 · 信息架构重排与折叠（R1）

- [x] 2.1 模板按操作流重排：状态/源包/产物 → G 内容范围 → F 输出三联 → H/I/J/K 折叠 → E 动作 → D 执行反馈 → 日志
- [x] 2.2 H/I/J/K 改用宿主原生 `.inline-drawer`（复用 `setupDrawerToggles`；`index.js:85` 已调，无需新增接线）
- [x] 2.3 新增双前缀样式：`.wb-fold-summary` / `.output-row` / `.output-field` / `.ext-mode-row` / `.ext-mode-opt` / `.wb-checks` / `.wb-actions` / `.wb-storage-btn` / `.stash-row-menu`
- [x] 2.4 `updateFoldSummaries()` 接线（初始化 + `refreshPlan` 早退前 + 扩展模式 change）
- [x] 2.5 验证：折叠开合正常；摘要随状态更新；`check:css-scope` 通过

## 阶段 3 · 移除项与文案清理（R2 / R4）

- [x] 3.1 移除 `#placeholder-chips` 及 `index.js:411-452` 插入绑定
- [x] 3.2 移除 3 个 `.btn-tpl-preset` 及绑定
- [x] 3.3 移除 `#link-char-chats-check`，联动改恒开（`category-filter.js` → `const isLinked = true`）
- [x] 3.4 扩展模式卡 → 两个紧凑选项（`.ext-mode-opt`，去描述段与「(推荐)」）
- [x] 3.5 清理解释性静态文案：页头副标题、拖放区 sub-text、待导出区 zone-hint、类目标题括注、构建配置括注、清单说明小字、教学性 title、报告 summary 括注（`（安全保留）` 等）
- [x] 3.6 验证：三处 id 无残留业务引用；守卫通过

## 阶段 4 · 智能分包数值输入（R3）

- [x] 4.1 `#split-select` → `<input type="number" id="split-input" min="1" step="1" inputmode="numeric">`
- [x] 4.2 新增 `parseSplitInputMb()`（整数校验 + 浮点归一 + 非法视为不分卷），接入宿主拉取 / 外部转换两处取值点
- [x] 4.3 单测 —— **已补**：归一化逻辑抽为 `src/core/splitter.js` 的 `normalizeSplitMb()` 纯函数（`MIN_SPLIT_MB = 1`），`index.js` 只做 DOM 取值；新增 5 条用例覆盖整数/浮点/0/负数/空值/空白/非数字/Infinity，并断言返回值恒为整数（R3.2）

## 阶段 5 · 动作按钮解耦（R7）

- [x] 5.1 新增 `computeActionAvailability(state)` / `collectActionState()` / `applyActionAvailability()`（唯一写点）
- [x] 5.2 **14 处散落写点全部收敛为 0**（`grep` 复核）；引入 `workbenchBusy` 表达在途态（批量转换 / 宿主拉取 / 单包转换 三对起止）
- [x] 5.3 抽出 `makeHostButton()` 与两处宿主挂载函数共用 —— **已做**：工厂落在 `host-bridge.js`，`mountNativeBackupButton`（含其局部 `makeButton`，已删）与 `mountLukerBackupManagerButton`（原为内联 `innerHTML` 构造）收敛为同一工厂。契约由 `test/host-button-factory.test.js`（6 用例，最小 DOM 桩）锁定：原生类 / `stZipInjected` 幂等标记 / 图标在前文案在后（textContent 非 innerHTML）/ click 先 `preventDefault`+`stopPropagation`。
  - **范围边界（有意不做）**：`registerMenuButton` 注入的是宿主**扩展菜单项**（`list-group-item` + `extensionsMenuExtensionButton`），非 `menu_button` 形态；工作台固定动作按钮是**声明式模板标记**（R8 单一模板源）。两者硬套工厂会分别破坏宿主菜单外观、与 R8 冲突，故不纳入。
- [x] 5.4 验证：三枚可同时可见（宿主态 + 有源包 + 有产物）

## 阶段 6 · 暂存区（R5）

- [x] 6.1 行内缩为「载入 + ⋯」，更多菜单含 下载 / 写回宿主 / 删除（`openRowMenu` 自绘，零宿主依赖）
- [x] 6.2 `confirmDialog()` 适配器 —— **已做，且撤回上一轮的 T3 移交判断**。
  - **裁决依据（L0-3 检索取证）**：上一轮记「`callGenericPopup` 不挂全局（仅 `popup.js` export），须动态 import 宿主模块」——**经复核不成立**。ST 与 Luker 的 `public/scripts/st-context.js` 均把 `Popup` / `POPUP_TYPE` / `POPUP_RESULT` 挂在 `getContext()` 上（ST `st-context.js:225`、Luker `st-context.js:2663`），`docs.sillytavern.app` 官方文档亦记载 `const { Popup } = SillyTavern.getContext(); Popup.show.confirm(title, message)`。**无需动态 import，且是文档化路径**（L1-MR-5）。真机亦证实（见 8.8）。
  - **实现**：`host-bridge.js` 新增 `confirmDialog(message)`（宿主差异只进桥接层，L0-9），走 `getContext().Popup.show.confirm(header, text)`，`POPUP_RESULT.AFFIRMATIVE` 比对；特性检测不符或调用抛错时静默降级 `window.confirm`（L0-11）。为不猜宿主常量，`POPUP_RESULT` 缺失时直接降级。
  - **接入面扩到全部 4 处破坏性确认**（不止暂存区）：暂存区批量删除、暂存区行内删除、待导出区「清空」、待导出区「取消在途恢复」。经 DI 注入 `confirmFn`（与既有 `onLoadFile` / `isHostAvailable` 同一接缝），组件仍可脱离宿主单测。
- [x] 6.3 测试核对：`test/stash-list.test.js` 只覆盖纯函数，无需改动

## 阶段 7 · 报告统计空状态（R6）

- [x] 7.1 `#report-panel` 默认 `hidden`，`renderReport` 时 `hidden = false`
- [x] 7.2 三份清单折叠条合并为单一「报告详情」（`fold-summary-report` 显示 `丢弃 N · 排除 N · 警告 N`）

## 阶段 8 · 验证与交付

- [x] 8.1 `npm test`：**39 文件 / 333 passed / 2 skipped**（分支起点 37/308；+26 用例为新增守卫与契约测试）
- [x] 8.2 三守卫通过（`check:css-scope` / `check:dom-injection` / `check:template-source`）
- [x] 8.3 独立态实机验证（`npm run dev` + Playwright）：41/41 节点、0 控制台错误
- [x] 8.4 插件态 8004 改造后基线复测 + 前后对照表 —— 见 `research/final-report.md` §1
- [x] 8.5 高度/DOM/按钮数下降量化确认：**1237 → 903 px（−27.0%）**、可见按钮 **13 → 3（−77%）**、`<details>` **3 → 0**
- [x] 8.6 `git push` 到 origin（L0-7）—— `0256f9b`，本地与 `origin/fix/perf-hardening-transfer-memory` 一致
- [x] 8.7 8004 实机 Git 更新后复验 —— 见 8.8
- [x] 8.8 **收尾复验（8004 实机，只读）**：`research/pw-final-verify.cjs` + `research/pw-probe-anchors.cjs`
  - 抽屉态读数与上一轮**逐项一致**（903px / 270 节点 / 29 按钮 / 3 可见 / 0 `<details>` / 5 个 `.inline-drawer`）→ 无回归
  - 宿主原生确认能力**真机取证成立**：`getContext()` 可取、`Popup.show.confirm` 为 function、`AFFIRMATIVE = 1`
  - 端到端往返**成功**：真实唤起原生确认弹窗 → 点「取消」→ 返回 `0`（`NEGATIVE`）→ 适配器映射为 `false`
  - 控制台：无一条错误来自本插件（其余为 stable-diffusion / Dialoguet / shujuku 等第三方扩展与宿主资源 404/500）
  - **未观测到注入按钮**：真机全程 `.userBackupButton` / `.userBackupManager` / `.backupActionRow` 均为 0（探针点击了 4 个候选宿主入口）。锚点在 ST 与 Luker 源码中确实存在（GitHub 检索：`userProfile.html` / `admin.html` / `userBackupManager.html`），属**承载它们的宿主面板未被本次探针打开**，非本插件回归。R7.3 的结构契约改由 `test/host-button-factory.test.js` 确定性锁定。

## 阶段 9 · 收尾补做（本轮新增，回应 4.3 / 5.3 / 6.2 三处未做项）

- [x] 9.1 `normalizeSplitMb()` 纯函数抽出 + 5 条单测（`src/core/splitter.js`、`test/splitter.test.js`）
- [x] 9.2 `confirmDialog()` 适配器 + 7 条单测（`src/ui/host-bridge.js`、`test/confirm-dialog.test.js`）
- [x] 9.3 `makeHostButton()` 工厂 + 6 条契约单测（`src/ui/host-bridge.js`、`test/host-button-factory.test.js`）
- [x] 9.4 三入口渲染一致性机器断言（`test/single-template-source.test.js`）：三态各产出全部 41 个必需节点、折叠区为原生 `inline-drawer` 且非 `<details>`、三态唯一合法分支差异（模态关闭按钮 / 抽屉页头与存储入口）
- [x] 9.5 4 处破坏性确认全部改走宿主原生弹窗（`stash-list.js` ×2、`export-queue.js` ×2）
- [x] 9.6 实例还原核对：`Instance/.../st-zip-converter` 回到 `main @ 3a98fb3`，`git status` 干净

## 验证命令

```bash
npm test
npm run check:css-scope && npm run check:dom-injection && npm run check:template-source
npm run dev                      # 独立态实机
grep -c "placeholder-chips\|btn-tpl-preset\|link-char-chats-check" index.html src/ui/workbench-template.js
grep -rn "[^a-zA-Z.]confirm(" src/ui/*.js index.js   # 应为空：已无裸 confirm（适配器内部除外）
node .trellis/tasks/09-25-ui-slim-native/research/pw-final-verify.cjs   # 8004 只读复验
```

## 回滚点

- 阶段 1 前：`059257e`（骨架化若失败，`git checkout index.html` 即回退）
- 阶段 2 前：阶段 1 完成后提交一次，作为结构重排的回滚点
- 阶段 9 前：`c3ca97c`（三项收尾补做若失败，`git revert 0256f9b` 即回退）
