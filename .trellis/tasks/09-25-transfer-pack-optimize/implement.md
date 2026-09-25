# 执行清单：上下传链路与打包优化收敛（T4）

> 复选框**随执行实时勾选**（L0-2）。改动集中在模板 + `index.js` 三处 + 注释。
> 实机口径：**只对 Dev Luker 8003**（R5.5）。

## 阶段 0 · 基线

- [ ] 0.1 基线：`npm test`（起点 40 文件 / 345 passed / 2 skipped）+ 三守卫全绿
- [ ] 0.2 Dev 8003 可达（实例常驻；插件已按 Git 装载于 `d65ef96` 之后的提交）
- [ ] 0.3 采集改造前 J 区基线：勾选项清单 + 折叠摘要文字（实机或模板静态）

## 阶段 1 · 死开关移除（R1.1）

- [ ] 1.1 **先查 `scripts/single-template-source.js` 的 `REQUIRED_TEMPLATE_IDS` 是否含
      `incremental-mode-check`**——若含则同步移除（否则 `check:template-source` 必失败）
- [ ] 1.2 `workbench-template.js`：移除 `#incremental-mode-check` 的 label 块
- [ ] 1.3 `index.js`：移除元素查找（:190）、change 监听（:1314-1315）、折叠摘要分支（:252）
- [ ] 1.4 `fold-summary-incremental` 摘要逻辑简化为单 flag 的状态读数（差量补丁有无基准）
- [ ] 1.5 复核：`grep -rn "incremental-mode-check"` 全仓零命中

## 阶段 2 · 未接线实现标注（R1.2）

- [ ] 2.1 `incrementalMergeArchives()` JSDoc 顶部加「⚠ 未接线：无任何调用方」+ 接线前置条件

## 阶段 3 · 概念消歧改名（R1.3）

- [ ] 3.1 `host-bridge.js:717` 恢复写入日志：「增量合并 / 全量覆盖」→「合并写入 / 覆盖写入」
- [ ] 3.2 **不动**协议值 `mode: 'merge'|'replace'` 与 `incremental` 表单字段（宿主契约）
- [ ] 3.3 复核：全仓 `grep -n "增量合并"` 结果不再指向两个概念

## 阶段 4 · 压缩率档位语义化（R2）

- [ ] 4.1 `#compression-select` 的 option 文本改为 `存储/快速/标准/最大`，**value 与默认不变**
- [ ] 4.2 复核状态恢复路径（`index.js:1469` 读 `savedState.compressionLevel`）按 value 走，零行为变化

## 阶段 5 · 默认值显式化（R3）

- [ ] 5.1 `splitter.js` 的 `DEFAULT_THRESHOLD_MB` 补注释：API 默认参数、UI 不可达、UI 默认=不分卷
- [ ] 5.2 确认**未改任何默认值**

## 阶段 6 · 默认值与适用场景表（R4）

- [ ] 6.1 产出 `research/transfer-defaults.md`：拉取→转换→导出→恢复 全链路用户可选项的
      现值默认 / 取值域 / 适用场景 / 改动代价 / 本任务是否改动

## 阶段 7 · 验证与交付

- [ ] 7.1 `npm test` 全绿（不低于 40 文件 / 345 passed）
- [ ] 7.2 三守卫通过（`check:css-scope` / `check:dom-injection` / `check:template-source`）
- [ ] 7.3 Dev 8003 实机渲染无回归（J 区少一个复选框；压缩率档位显示语义名；插件零控制台报错）
- [ ] 7.4 `git push` 到 origin（L0-7 完成即推送）
- [ ] 7.5 收尾核对：`Instance/Real/**` 零写入；Dev 写入仅限 git 装载且 `git status` 干净

## 核验方式（预期）

- 沿用 **G-5**：`trellis-check` 子代理在本环境已复现多次「0 工具调用即退出」，转主代理自核，
  对照 `prd.md` 的 AC 逐条现场取证（文件:行号 + 命令输出 + 实机读数）。
- **未通过核验的项不得记作通过。**

## 验证命令

```bash
npm test
npm run check:css-scope && npm run check:dom-injection && npm run check:template-source
grep -rn "incremental-mode-check" . --include=*.js --include=*.html | grep -v node_modules   # 应为空
LUKER_URL=https://127.0.0.1:8003 node .trellis/tasks/archive/2026-09/09-25-ui-slim-native/research/pw-final-verify.cjs
```

## 回滚点

- 阶段 0 前：`f267628`（分支 tip）
- 阶段 6 前：阶段 1–5 完成后提交一次（表格若产不出结论也不阻塞已交付项）
