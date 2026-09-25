# 执行清单：上下传链路与打包优化收敛（T4）

> 复选框**随执行实时勾选**（L0-2）。改动集中在模板 + `index.js` 三处 + 注释。
> 实机口径：**只对 Dev Luker 8003**（R5.5）。

## 阶段 0 · 基线

- [x] 0.1 基线：`npm test` 起点 **40 文件 / 345 passed / 2 skipped** + 三守卫全绿
- [x] 0.2 Dev 8003 可达（实例常驻）
- [x] 0.3 改造前 J 区基线：两个复选框（`增量合并` / `差量补丁`）；抽屉读数 270 节点 / 29 按钮

## 阶段 1 · 死开关移除（R1.1）—— **已完成**

- [x] 1.1 **先查守卫清单**：`incremental-mode-check` **确实在** `REQUIRED_TEMPLATE_IDS` 中 → 已同步移除（否则 `check:template-source` 必失败）。节点数 41 → **40**
- [x] 1.2 `workbench-template.js`：移除该 label 块
- [x] 1.3 `index.js`：移除元素查找（:190）、change 监听（:1314-1315）、折叠摘要分支（:252）
- [x] 1.4 `fold-summary-incremental` 简化为单 flag 的状态读数：「差量补丁 · 基准已就绪 / 缺基准」
      - **顺带修复**：`host-incremental-export` 的 change 监听原本**未调** `updateFoldSummaries()`，摘要会停留旧值；已在同处补上
- [x] 1.5 复核：`grep -rn "incremental-mode-check"` 在源码/守卫/文档（排除 `.history/`、`dist/` 构建产物与已加横幅的历史存档）零命中

## 阶段 2 · 未接线实现标注（R1.2）

- [x] 2.1 `incrementalMergeArchives()` JSDoc 顶部加「⚠ 未接线：无任何调用方」+ 接线前置条件（须先与用户定语义，不要直接复活开关）

## 阶段 3 · 概念消歧改名（R1.3）

- [x] 3.1 恢复写入中文名全链路改为「合并写入 / 覆盖写入」：模板单选（:309/313）、成功日志（host-bridge:764）、
      进度文案（index.js:1189）、模块头注释、`restoreToHostInner` 处注释
- [x] 3.2 **协议值未动**：`mode: 'merge'|'overwrite'` 与 `incremental` 表单字段一字未改（已复核）
- [x] 3.3 复核：用户可见处（模板 + 运行时字符串）已无「增量合并 / 全量覆盖」；
      剩余仅为「已移除」的说明注释、未接线实现的自身文档、测试注释与 `split-deliver-modal` 的另一语境表述

## 阶段 4 · 压缩率档位语义化（R2）

- [x] 4.1 option 文本改为 `存储/快速/标准/最大`，**value 仍为 0/1/5/9、默认仍为 5**
- [x] 4.2 复核状态恢复路径按 value 走（`index.js:1469`），零行为变化；实机验证见 7.3

## 阶段 5 · 默认值显式化（R3）

- [x] 5.1 `DEFAULT_THRESHOLD_MB` 补注释：API 默认参数、UI 不可达、UI 默认 = 不分卷
- [x] 5.2 确认**未改任何默认值**（`#split-input` 仍为空 = 不分卷；压缩率默认仍 5；恢复模式默认仍 merge）

## 阶段 6 · 默认值与适用场景表（R4）

- [x] 6.1 产出 `research/transfer-defaults.md`：拉取→转换→导出→恢复 全链路用户可选项的
      现值默认 / 取值域 / 适用场景 / T4 是否改动，逐项取自代码

## 阶段 7 · 验证与交付

- [x] 7.1 `npm test`：**40 文件 / 346 passed / 2 skipped**（起点 345 → +1 反向断言）
- [x] 7.2 三守卫通过（模板节点数已正确变为 **40**）
- [x] 7.3 Dev 8003 实机验证（`research/pw-verify-t4-transfers.cjs`）：
      死开关**不存在**、J 区仅剩 `host-incremental-export`、压缩率 `0存储/1快速/5标准(选中)/9最大`、
      分卷空=不分卷（min=1）、恢复模态 `merge 合并写入(选中)/overwrite 覆盖写入`、
      渲染 **267 节点**（基线 270，−3 正是移除的 label+input+span）/ 29 按钮 / 5 inline-drawer / 0 `<details>`、
      **插件零控制台报错**
- [x] 7.4 `git push` 到 origin（L0-7 完成即推送）
- [x] 7.5 收尾核对：`Instance/Real/**` 零写入；Dev 实例写入仅限 git 装载且 `git status` 干净

## 附带完成（超出原计划但必要）

- [x] A.1 **spec 文件拆分**：`component-guidelines.md` 已达 **36761 字节**，超过 Trellis
      `context_injection.max_file_bytes`（32768）→ 会被**静默截断**（P-2 那类「截断比不同步更糟」）。
      拆出 `host-capabilities.md`（两节宿主能力规范 + 新增「UI 控件合宪性」），
      现为 28055 / 12809 字节，均低于上限；已在 `frontend/index.md` 登记并写明自查方法
- [x] A.2 **修复 T3 遗留的 spec 缺陷**：`component-guidelines.md` 中一条「响应体解析失败 → …」
      测试点被 T3 插入时割裂、孤立在宿主能力章节末尾 → 已归位到「测试点」列表
- [x] A.3 新增 spec 条目 **「UI 控件的合宪性：任何控件必须有消费点」**：死控件的三步取证法
      （查值读取点 → 排除泛读 → 排除持久化）、处置约定、概念撞名禁令、文档不要写死节点数

## 核验方式（实际执行）

- **未派发 `trellis-check` 子代理**：本仓已复现多次该子代理「输出一句开场白即退出、`tool_uses: 0`」，
  每次白烧约 40k tokens。沿用既定降级策略 **G-5（转主代理串行自核）**。
- **主代理自核口径**：对照 `prd.md` 的 7 条 AC **逐条去代码/实机现场取证**
  （文件:行号 + 命令输出 + 实机读数），不采信任何交接文档的进度断言。
- **核验产出**：`npm test` 40 文件 / 346 passed / 2 skipped；三守卫退出码 0；
  Dev 8003 实机定点探针读数（见 7.3）；Real 实例零写入核对。
- **未通过核验的项**：无——7 条 AC 全部达成，无遗留未勾选项。
- **如实记录的过程事项**：① 移除复选框必须先查 `REQUIRED_TEMPLATE_IDS`（否则守卫必失败），
  实施第一步即查得确实在内；② 发现原计划的「41 个节点」在多处文档被写死，已改为不硬编码；
  ③ 发现并修复 T3 在 spec 中造成的一处列表割裂缺陷；④ spec 文件超注入上限，已拆分。

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
