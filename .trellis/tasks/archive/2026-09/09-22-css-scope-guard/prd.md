# CSS 宿主作用域铁律自动守卫

## Goal

把 L1-MR-3 的人工自查固化为自动化校验（npm script + Vitest），防止插件样式污染宿主全站 UI。

## Background

- `style.css` 同时服务独立页面与宿主插件，插件注入样式与宿主共用文档。
- 顶层规则已基本限定在 `.app-container` 或 `.st-converter-drawer-app`；两个响应式 `@media` 块仍含裸 `body`、`.app-header` 等选择器，当前 grep 自查无法覆盖嵌套规则。
- `body:has(> .app-container)` 是独立页面的既有骨架规则，不应误判；`@keyframes` 中的百分比帧不是宿主元素选择器。

## Requirements

- 校验完整解析 `style.css` 的普通规则，包括 `@media`、`@supports` 等嵌套规则及逗号分隔的每一条选择器；插件生效的规则只能以 `.app-container` 或 `.st-converter-drawer-app` 为作用域根。
- 独立页面专用的 `body:has(> .app-container)` 允许保留；不得把普通 `body`、`:root`、`*` 或宿主原生类名列入白名单。`@keyframes` 内的帧规则不作为元素选择器检查。
- 修复当前响应式规则中的裸选择器，使现有样式通过新守卫，且独立页面与插件页面仍保留原有响应式布局。
- 提供可单独运行的 npm 校验命令，并将同一校验逻辑纳入 Vitest；检查失败须提供文件位置和违规选择器。
- 不引入插件运行时依赖，不修改 vendor 副本，不访问或写入酒馆实例目录。

## Acceptance Criteria

- [x] 当前 `style.css` 通过独立 npm 命令和 `npm test` 中的作用域测试。
- [x] 测试证实顶层、媒体查询、支持查询及逗号列表里的裸选择器均被拒绝，并显示对应位置；两个合法前缀及独立页面专用骨架规则通过。
- [x] 测试证实 `@keyframes` 百分比帧不会被误判，裸 `body`、`:root`、`*`、`.menu_button` 不能绕过校验。
- [x] 响应式规则修复后，独立页面和宿主插件的对应选择器仍分别有匹配规则；`npm test` 和 `npm run build` 全绿（2026-09-24 复核：226 passed / 2 skipped；`npm run build` 成功）。
- [x] `git diff` 可清晰审查仅作用域及守卫相关的变更；不改变页面结构或转换逻辑。

## Out of Scope

- 不重做样式设计、主题变量体系或工作台 DOM 结构。
- 不在 Dev/Real 酒馆实例中部署或执行端到端测试。
