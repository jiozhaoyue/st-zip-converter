# 执行清单：UI 精简与原生化

> 复选框**随执行实时勾选**（L0-2）。每阶段结束跑一次验证命令，失败则先修复再前进。
> 改动面：模板 + 样式 + 绑定 + `index.html` + 新增守卫；**不动 `src/core/**`**。

## 阶段 0 · 基线固化

- [ ] 0.1 记录改造前基线：面板渲染高度、DOM 节点数、按钮数/可见数、输入控件数（脚本 `pw-e1-ui-open.cjs` 可复用），落 `research/before.json`
- [ ] 0.2 记录改造前 id 清单：`grep -o "getElementById('[^']*')" index.js | sort -u`，落 `research/ids-before.txt`
- [ ] 0.3 跑一次全量验证建立绿线基线：`npm test`、`npm run check:css-scope`、`npm run check:dom-injection`

## 阶段 1 · 单一模板源（R8）

- [ ] 1.1 `getWorkbenchHtml(opts)` 扩展三态参数（`isStandalone` / `isDrawer` / `isModal`），共用内部结构
- [ ] 1.2 `index.html` 收敛为骨架：仅 `#app.app-container` 空容器 + 样式与脚本入口
- [ ] 1.3 `bootstrap()` 独立态分支：`#app` 为空时注入 `getWorkbenchHtml({ isStandalone: true })`
- [ ] 1.4 新增 `scripts/single-template-source.js` 守卫 + `package.json` 脚本 `check:template-source`
- [ ] 1.5 验证：`npm run dev` 独立态可渲染；`check:template-source` 通过

## 阶段 2 · 信息架构重排与折叠（R1）

- [ ] 2.1 按 design §3 重排模板分区（操作流顺序：状态/源包/产物 → G → F → H/I/J/K 折叠 → E → D → 日志）
- [ ] 2.2 H/I/J/K 改用 `.inline-drawer` 折叠结构，`mountSettingsDrawer` 已调 `setupDrawerToggles` 无需改
- [ ] 2.3 补 `.wb-fold-summary` 样式（双前缀，继承 `--SmartThemeEmColor`）
- [ ] 2.4 各区摘要读数接线（垃圾清理启用项数、扩展打包当前模式、包名当前值）
- [ ] 2.5 验证：折叠开合正常；摘要随状态更新；`check:css-scope` 通过

## 阶段 3 · 移除项与文案清理（R2 / R4）

- [ ] 3.1 移除 `#placeholder-chips` 及其 JS 绑定（`index.js:420`）
- [ ] 3.2 移除 3 个 `.btn-tpl-preset` 及其绑定
- [ ] 3.3 移除 `#link-char-chats-check`，联动行为改为恒开（保留联动逻辑本体）
- [ ] 3.4 扩展模式卡 → 两个紧凑选项（去 `ext-mode-desc` 段与「(推荐)」）
- [ ] 3.5 清理 design §8 表格列出的全部解释性静态文案（页头/拖放区/待导出标题/类目标题/构建配置括号/清单说明/教学性 title）
- [ ] 3.6 验证：`grep` 复核三处 id 无残留业务引用；`check:dom-injection` 通过

## 阶段 4 · 智能分包数值输入（R3）

- [ ] 4.1 `#split-select` → `<input type="number" id="split-input" min="1" step="1">`
- [ ] 4.2 新增 `parseSplitInput()`（整数校验 + 浮点归一 + 非法视为不分卷），接入转换/拉取两侧取值点
- [ ] 4.3 单测：`1.5`→1、`-5`/`0`/空→不分卷、`200`→200MB、非法字符串→不分卷

## 阶段 5 · 动作按钮解耦（R7）

- [ ] 5.1 新增 `computeActionAvailability(state)` + `applyActionAvailability()`（唯一写点）
- [ ] 5.2 把散落的 `btnConvert.disabled` / `btnHostFetch.disabled` / `btnHostFetch.style.display` / `btnRestoreLuker.disabled` 写点全部改为调用 `applyActionAvailability()`
- [ ] 5.3 抽出 `makeHostButton()`，工作台按钮与 `mountNativeBackupButton` / `mountLukerBackupManagerButton` 共用
- [ ] 5.4 验证：三枚按钮可同时可见（宿主态 + 有源包 + 有产物）；`grep` 复核写点已收敛

## 阶段 6 · 暂存区（R5）

- [ ] 6.1 行内动作缩为「载入 + ⋯」，更多菜单含 下载 / 写回宿主 / 删除
- [ ] 6.2 `confirmDialog()` 适配器：优先 `callGenericPopup`，降级 `window.confirm`
- [ ] 6.3 更新 `test/` 中暂存区相关用例（若有断言旧按钮结构）

## 阶段 7 · 报告统计空状态（R6）

- [ ] 7.1 无源包且无产物时 `#report-panel` 不渲染（`hidden` 或移除）
- [ ] 7.2 状态变化时正确切换（有源包/转换后出现）

## 阶段 8 · 验证与交付

- [ ] 8.1 `npm test` 全绿（基线 226 passed / 2 skipped + 新增用例）
- [ ] 8.2 `npm run check:css-scope` + `check:dom-injection` + `check:template-source` 三守卫通过
- [ ] 8.3 实机 8004 验证三入口：独立态（`npm run dev`）、插件抽屉、模态渲染一致
- [ ] 8.4 改造后基线复测（同 0.1 脚本），产出前后对照表落 `research/after.json` 与 `research/ui-slim-report.md`
- [ ] 8.5 高度/DOM/按钮数下降得到量化确认；若某项未下降，说明原因
- [ ] 8.6 `git push` 到 origin（L0-7 完成即推送）
- [ ] 8.7 8004 实机 Git 更新后复验（插件为 Git 安装）

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
