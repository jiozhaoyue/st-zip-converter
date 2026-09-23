# 实施清单（安全注入面止血）

> 依据 `prd.md` 的 R1–R7 与验收标准。全部改动走块级 diff（L0-4）。

## 1 共享转义层

- [x] `src/ui/escape.js`：导出 `escapeHtml()`（覆盖 `& < > " '`）与 `isSafeHttpUrl()`
- [x] `src/ui/escape.js`：`trustedStaticMarkup()` —— 恒等函数，用于**显式标注可信静态 HTML 片段**（可 `grep -rn "trustedStaticMarkup(" src/ index.js` 审计全部豁免点）
- [x] `test/escape.test.js`：5 字符逐项断言 + XSS 载荷中和 + 非字符串入参 + `isSafeHttpUrl` 拒可执行协议 + `trustedStaticMarkup` 恒等

## 2 扩展清单 XSS 止血（最高优先）

- [x] `src/ui/host-bridge.js` `renderExtensionInstallerModal`：整个条目改 `createElement` + `textContent`（`displayName` / `folder` / `branch`）
- [x] 同上：`ext.url` 渲染期经 `isSafeHttpUrl()` 校验，非 http(s) 只显示「无远程 URL」（不输出原值）
- [x] `src/ui/host-bridge.js` 新增 `setStatusContent()`：安装状态与 `err.message` 改 `textContent` + 图标独立节点（替换 3 处 `innerHTML`）

## 3 文件 / 文本类注入点

> 结构化列表模板用 `escapeHtml`（与审计 B3 一致）；整块模板改 `createElement` 属后续任务。

- [x] `src/ui/stash-list.js`：条目名 / ID / 徽标文本转义；静态「当前源」徽标用 `trustedStaticMarkup`
- [x] `src/ui/export-queue.js`：条目名 / ID / origin 文本转义；`layoutBadge` / `storedBadge` 预计算后标注可信；3 处 `mkBtn` 的静态 HTML 参数标注可信
- [x] `src/ui/file-drop.js`：`file.name` / 数量 / `setFilename(name)` 转义
- [x] `src/ui/archive-manager.js`：筛选条与元信息转义
- [x] `src/ui/usage-dashboard.js`：配额数值转义
- [x] `index.js`：基准包名与恢复弹窗文件名转义；`getWorkbenchHtml` 标注可信
- [x] `src/ui/host-bridge.js`：扩展面板异常横幅 + `getWorkbenchHtml` 标注可信；`makeButton` 改 DOM 节点

## 4 日志控制台转义升级

- [x] `src/ui/log-console.js`：删除私有 3 字符实现，改引共享 `escapeHtml`（升至 5 字符）；已转义详情片段与自存 HTML 标注可信

## 5 CI 守卫

- [x] `scripts/dom-injection-guard.js`：扫描 `src/ui/**` + 根 `index.js` 的 `innerHTML`/`outerHTML`/`insertAdjacentHTML`；支持语句级 `dom-injection-guard:allow` 与整文件 `allow-file` 豁免；支持传入目标路径（供测试）
- [x] `package.json` 增 `check:dom-injection` 脚本
- [x] `test/dom-injection-guard.test.js`：11 项——含**负向测试**（合成样本断言退出码 1）与仓库自身零违规门禁

## 6 验证与收口

- [x] `npm test`：**226 passed / 2 skipped**（基线 199 passed 未退化，新增 27 项）
- [x] `npm run check:dom-injection` 退出码 0
- [x] `npm run check:css-scope` 仍通过
- [x] 提交并推送 origin

## 过程中的教训（已记录）

- `insert_edit_into_file` 在本仓发生**误删**：丢失 `host-bridge.js` 的 `watchHostDom` 整块与
  `archive-manager.js` / `export-queue.js` 的 import 片段。已整体回退产品代码后用
  `replace_string_in_file` / `multi_replace_string_in_file` 重施（L0-4 块级 diff 才是可审改动）。
  **结论：本仓修改现有文件只用块级替换，禁用 `insert_edit_into_file`。**

## 当前不做

- 不做链路②③的内存/传输优化；不改宿主 UI 落点合规性；不引入 CSP。
