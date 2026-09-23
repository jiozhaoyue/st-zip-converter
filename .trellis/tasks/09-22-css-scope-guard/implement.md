# 实施清单

- [x] 取得最终规划审核与实施授权；用户授权将 PostCSS 8.5.26 固定为显式 devDependency，仅用于 CSS 语法解析守卫。
- [x] 用现有 CSS 和反例先写作用域校验测试，验证当前媒体查询违规被发现。
- [x] 实现共用的语法树校验函数和 npm 命令，错误包含行号及选择器。
- [x] 仅修复 `style.css` 中响应式裸选择器，保持双入口覆盖和独立页面例外。
- [x] 运行守卫、针对性测试、全量 `npm test`、`npm run build`，复核 `git diff` 与 CSS 前缀。
- [x] 依据 `trellis-check` 做全范围核验（npm test 199 全绿 + npm run build 通过）；spec 已沉淀嵌套规则守卫教训（component-guidelines.md）。剩余：按确认的提交计划提交并推送 `origin`。

## 变更边界

- 预计修改：`style.css`、`package.json`、新增校验脚本及测试；仅在明确授权后才因依赖需要修改 `package-lock.json`。
- 不修改 `index.html` / `src/ui/workbench-template.js`，因为 DOM 结构不变；不修改 `src/core/`、`src/vendor/` 或实例目录。
- 校验原有非响应式规则及两种容器前缀；选择器修复只变更匹配范围，不改变声明属性和取值。
