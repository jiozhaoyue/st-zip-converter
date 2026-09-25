# 数据包上下传链路与打包优化收敛

> 父任务：`09-25-workbench-native-onesop`（T4，最后一片）。
> 本 PRD 的全部条目来自**现场取证**（文件:行号见各条），不采信父 PRD 的表述——
> 父 PRD 只说「概念相邻易混」，实际取证发现其中一个是**完全不生效的死开关**。

## Goal

消除上下传链路上**同名异义**与**无效果控件**造成的概念冗余，把每项选项的现值默认值与
适用场景显式成表；不新增功能、不改动已正确的默认值。

## Background · 取证事实

### F1 三个撞名概念（核心）

| 现名 | 位置 | **是否生效** | 真实语义 |
| --- | --- | --- | --- |
| 「增量合并」 | J 区复选框 `#incremental-mode-check`（`workbench-template.js:208`） | **否 —— 死开关** | 无 |
| 「差量补丁」 | J 区复选框 `#host-incremental-export`（`:212`） | 是 | 以基准 ZIP 为基准，只导出新增/修改条目（`src/core/delta.js`） |
| 「增量合并」 | 恢复写入的 `mode:'merge'`（`host-bridge.js:716/724`） | 是 | 上传时告知宿主把包**合并**进现有数据（对比全量覆盖） |

**死开关的证据（全仓彻查）**：
- `#incremental-mode-check` 的全部引用只有三处：元素查找（`index.js:190`）、
  折叠摘要文字（`index.js:252`）、一个只调 `refreshPlan()` 的 change 监听（`index.js:1314-1315`）。
  **没有任何代码读取它的 `.checked`**。
- 排除误判：全仓无「泛读复选框」代码（`querySelectorAll('input[type=checkbox]')` 零命中），
  工作区状态持久化也不含该字段（`grep -n incremental src/ui/*.js src/storage/*.js` 无命中）。
- 后果：用户勾选它只会让折叠摘要多出「增量合并」四个字，**行为零变化**。

### F2 未接线的实现

`host-bridge.js:1271` 的 `incrementalMergeArchives(baseArchive, incomingArchive, { onProgress })`
**没有任何调用方**——它正是 F1 那个死开关本该接的实现。属「有实现没接线」。

### F3 压缩率档位是无语义裸数字

`workbench-template.js:124-129` 的 `#compression-select` 选项为裸数字 `5`（默认）/ `0` / `1` / `9`，
用户无法判断该选哪个。下游 `compressionLevel` 直传 zip.js（`index.js:338/1017/1327` 等处）。

### F4 分卷的默认值存在两个「默认」且 UI 不可达其一

- `#split-input` **无默认值**（空 = 不分卷），这是实际生效的 UI 默认；
- `src/core/splitter.js:15` 的 `DEFAULT_THRESHOLD_MB = 100` 只作为
  `splitArchiveEntries()` 的 API 默认参数（`:97`）——而 `index.js` 恒显式传入 `splitMb`，
  故该常量**从 UI 路径不可达**，容易被误读为「UI 默认 100MB」。

### F5 已核查且**无需改动**的项

- I 区扩展打包两选项（轻量清单 / 完整离线包，`workbench-template.js:176-182`）语义清晰、互斥正确；
- `#split-input` 空值即不分卷——**保守且安全**的默认，保留；
- `/api/users/restore` 的 `mode` 与 `incremental` 表单字段成对一致（`host-bridge.js:723-724`），逻辑正确。

## Requirements

### R1 概念消歧（F1 / F2）

- **R1.1** 移除死开关 `#incremental-mode-check` 及其绑定/摘要分支——**零能力损失**
  （它本就不生效），但消除「勾了却没反应」的误导。
- **R1.2** `incrementalMergeArchives()` **不删除**，但必须在其 JSDoc 顶部显式标注
  「⚠ 未接线：当前无调用方」，避免后来者误以为该功能已上线。
- **R1.3** 恢复写入的 `mode:'merge'` 中文名由「增量合并」改为**「合并写入」**
  （对比「覆盖写入」），与 J 区彻底解耦——同一 UI 内不得出现两个同名但异义的概念。
- **R1.4** 消歧后全仓 `grep` 复核：`增量合并` 一词要么指向唯一概念，要么不存在。

### R2 压缩率档位语义化（F3）

- **R2.1** 四个选项由裸数字改为**带语义的值名**：`存储` / `快速` / `标准` / `最大`，
  保留对应值 `0` / `1` / `5` / `9`。
- **R2.2** **保留 4 档**：`0/1/5/9` 是 zip.js 压缩级的标准分布（无压缩 / 最快 / 平衡 / 最强），
  砍档会真实降低能力。
- **R2.3** 语义名是**值名而非解释性文案**，不违反用户裁决 12。

### R3 默认值显式化（F4）

- **R3.1** `DEFAULT_THRESHOLD_MB` 补注释说明它**只是 API 默认参数、从 UI 不可达**，
  并写明 UI 默认是「空 = 不分卷」。
- **R3.2** **不改动任何默认值**——现状默认均为安全侧，改动属产品决策，不在本任务。

### R4 默认值与适用场景成表（父 PRD 明确要求的交付物）

- **R4.1** 产出 `research/transfer-defaults.md`：把 拉取 → 转换 → 导出 → 恢复 链路上
  每个用户可选项的**现值默认 / 取值域 / 适用场景 / 改动的代价**列成一张表。
- **R4.2** 表内对每项标注「本任务是否改动」，使「收敛判定」可追溯。

### R5 贯穿约束

- **R5.1** 不新增功能；不改默认值；不改 `src/core/**` 的算法语义。
- **R5.2** 结构改动只改 `src/ui/workbench-template.js` 一处（单一模板源），
  同步 `REQUIRED_TEMPLATE_IDS` 并跑 `check:template-source`。
- **R5.3** 零解释性文案：不新增描述段（用户裁决 12）。
- **R5.4** `npm test` 全绿 + 三条守卫通过，零回归（起点 40 文件 / 345 passed）。
- **R5.5** 实机验证只对 Dev 实例（8003）。

## Acceptance Criteria

- [ ] 全仓无「读不到值的控件」：`#incremental-mode-check` 已移除，且 `grep` 无残留引用
      （模板 / `index.js` 绑定 / 折叠摘要三处同步清除）。
- [ ] `incrementalMergeArchives()` 的 JSDoc 含「未接线 / 无调用方」显式标注。
- [ ] 「增量合并」一词在 UI 与日志中不再指向两个概念；恢复写入改称「合并写入 / 覆盖写入」。
- [ ] `#compression-select` 四档均有语义值名，值仍为 `0/1/5/9`，默认仍为 `5`。
- [ ] `DEFAULT_THRESHOLD_MB` 有注释说明「API 默认参数、UI 不可达」；UI 默认仍为「不分卷」。
- [ ] `research/transfer-defaults.md` 覆盖链路全部用户可选项，含默认/取值域/适用场景/是否改动。
- [ ] `npm test` 全绿 + 三条守卫通过；Dev 8003 实机渲染无回归（J 区少一个复选框）。

## Out of Scope

- 不接线 `incrementalMergeArchives`（属新增功能，需用户先定语义）。
- 不改分卷/压缩率的默认值。
- 不改恢复上传的断点续传与超时语义（已在 `09-24-perf-hardening-transfer-memory` 定稿）。
- 不改 `src/core/**` 算法。
