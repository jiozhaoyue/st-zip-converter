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
- [ ] 4.3 单测 —— **未做**：`parseSplitInputMb` 位于 `main()` 闭包内，需先抽出为可测纯函数再补用例

## 阶段 5 · 动作按钮解耦（R7）

- [x] 5.1 新增 `computeActionAvailability(state)` / `collectActionState()` / `applyActionAvailability()`（唯一写点）
- [x] 5.2 **14 处散落写点全部收敛为 0**（`grep` 复核）；引入 `workbenchBusy` 表达在途态（批量转换 / 宿主拉取 / 单包转换 三对起止）
- [ ] 5.3 抽出 `makeHostButton()` 与宿主注入按钮共用 —— **未做**：与 T3 的宿主适配器一并处理更合适（避免并存两套注入工厂）
- [x] 5.4 验证：三枚可同时可见（宿主态 + 有源包 + 有产物）

## 阶段 6 · 暂存区（R5）

- [x] 6.1 行内缩为「载入 + ⋯」，更多菜单含 下载 / 写回宿主 / 删除（`openRowMenu` 自绘，零宿主依赖）
- [ ] 6.2 `confirmDialog()` 适配器（`callGenericPopup` 优先）—— **未做**：`callGenericPopup` 不挂全局（仅 `popup.js` export），须动态 import 宿主模块；与 T3 的动态 import 机制合并，避免重复造两套
- [x] 6.3 测试核对：`test/stash-list.test.js` 只覆盖纯函数，无需改动

## 阶段 7 · 报告统计空状态（R6）

- [x] 7.1 `#report-panel` 默认 `hidden`，`renderReport` 时 `hidden = false`
- [x] 7.2 三份清单折叠条合并为单一「报告详情」（`fold-summary-report` 显示 `丢弃 N · 排除 N · 警告 N`）

## 阶段 8 · 验证与交付

- [x] 8.1 `npm test`：**37 文件 / 308 passed / 2 skipped**（较基线 +7，为新增守卫测试）
- [x] 8.2 三守卫通过（`check:css-scope` / `check:dom-injection` / `check:template-source`）
- [x] 8.3 独立态实机验证（`npm run dev` + Playwright）：41/41 节点、0 控制台错误
- [ ] 8.4 插件态 8004 改造后基线复测 + 前后对照表
- [ ] 8.5 高度/DOM/按钮数下降量化确认
- [ ] 8.6 `git push` 到 origin（L0-7 完成即推送）
- [ ] 8.7 8004 实机 Git 更新后复验

## 验证命令

```bash
npm test
npm run check:css-scope && npm run check:dom-injection && npm run check:template-source
npm run dev                      # 独立态实机
grep -c "placeholder-chips\|btn-tpl-preset\|link-char-chats-check" index.html src/ui/workbench-template.js
```

## 回滚点

- 阶段 1 前：`059257e`（骨架化若失败，`git checkout index.html` 即回退）
- 阶段 2 前：阶段 1 完成后提交一次，作为结构重排的回滚点
