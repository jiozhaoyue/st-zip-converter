# 技术设计：上下传链路与打包优化收敛（T4）

## 1. 边界

**改动面**：`src/ui/workbench-template.js`（J 区少一个复选框、F 区档位值名）、
`index.js`（移除死开关的元素查找 / 监听 / 摘要分支；恢复写入日志改名）、
`src/core/splitter.js`（仅注释）、`src/ui/host-bridge.js`（仅 JSDoc 标注）。
**不动**：`src/core/**` 算法、`src/storage/**`、`src/vendor/**`、任何默认值。
**不新增**：功能、依赖、UI 控件。

## 2. 死开关移除（R1.1）

**现状三角**（全部需同步清除，否则守卫或运行期会报缺失节点）：

| 位置 | 内容 |
| --- | --- |
| `workbench-template.js:207-210` | `<label><input id="incremental-mode-check"><span>增量合并</span></label>` |
| `index.js:190` | `const incrementalModeCheck = document.getElementById('incremental-mode-check');` |
| `index.js:1314-1315` | `if (incrementalModeCheck) { incrementalModeCheck.addEventListener('change', () => refreshPlan()); }` |
| `index.js:252` | 折叠摘要：`if (...?.checked) parts.push('增量合并');` |

移除后 J 区只剩「差量补丁」一个复选框 + 基准 ZIP 区（`#host-base-zip-section`，
由 `host-incremental-export` 的 change 控制显隐，逻辑不受影响）。

**守卫联动**：`#incremental-mode-check` 是否在 `scripts/single-template-source.js` 的
`REQUIRED_TEMPLATE_IDS` 里？→ 若在，必须同步移除，否则 `check:template-source` 会报
「模板缺少必需节点」。**实施第一步就是查这个**。

**折叠摘要**：`fold-summary-incremental` 现由两 flag 拼串；移除后只剩差量补丁一项，
摘要逻辑简化为「差量补丁（含基准）/ 未启用」之类的状态读数（不得写成解释句）。

## 3. 未接线实现的标注（R1.2）

`host-bridge.js:1271 incrementalMergeArchives` 保留，JSDoc 顶部加：

```js
/**
 * ⚠ 未接线：当前**无任何调用方**。此函数是 J 区曾有过的「增量合并」开关本该接的实现，
 * 该开关经取证确认**从不生效**（值无人读取），已于 T4 `09-25-transfer-pack-optimize` 移除。
 * 若将来要上线「把入包合并进基准包」的能力，从这里接线——但需先与用户确定语义
 * （合并哪些类目、冲突如何取舍），不要直接复活开关。
 */
```

**为何不删**：它是有意设计过的实现（含进度回调），删除会丢掉设计意图；
而按本仓既有做法（`archive-manager.js` / `split-deliver-modal.js`），
**死代码一律先标注并登记，不擅自删**。

## 4. 恢复写入改名（R1.3）

| 位置 | 现值 | 改为 |
| --- | --- | --- |
| `host-bridge.js:717` 日志 | `(模式: 增量合并 / 全量覆盖)` | `(模式: 合并写入 / 覆盖写入)` |
| `host-bridge.js:723-724` | `mode` / `incremental` 表单字段 | **不动**（`merge`/`replace` 是宿主契约值） |

**只改面向用户的中文名**，不动协议值——`mode: 'merge' | 'replace'` 是
`/api/users/restore` 的入参契约，改动即破坏兼容。

## 5. 压缩率档位语义化（R2）

```html
<select id="compression-select" class="text_pole">
  <option value="0">存储</option>
  <option value="1">快速</option>
  <option value="5" selected>标准</option>
  <option value="9">最大</option>
</select>
```

- **只改 option 的显示文本，`value` 与默认选中项一字不动**——下游
  `parseInt(compressionSelect.value, 10)` 与状态恢复（`index.js:1469` 读 `savedState.compressionLevel`）
  全部按 `value` 走，故零行为变化。
- 顺序按压缩强度升序（0→9），默认项仍是 5（`selected` 标记位置随之调整，但 `value="5"` 不变）。
- 语义名依据 zip.js 的 `compressionLevel` 语义：0 = 不压缩（store）/ 1 = 最快 /
  5 = 平衡 / 9 = 最强。**档位数量与取值域不变**（R2.2）。

## 6. 默认值显式化（R3）

`src/core/splitter.js:15` 注释补：

```js
/**
 * `splitArchiveEntries()` 的 **API 默认参数**（仅当调用方不传 `thresholdMB` 时生效）。
 * ⚠ 它**不是 UI 默认值**：`index.js` 恒显式传入由 `#split-input` 求出的 `splitMb`，
 * 而该输入框**默认为空 = 不分卷**。故从 UI 路径出发，本常量不可达。
 */
export const DEFAULT_THRESHOLD_MB = 100;
```

**不改任何默认值**（R3.2）——现状默认均在安全侧，改动属产品决策。

## 7. 兼容性与回滚

| 风险 | 缓解 |
| --- | --- |
| 移除复选框后模板缺节点 → 守卫失败 | 先查 `REQUIRED_TEMPLATE_IDS` 并同步；`check:template-source` 即防线 |
| 压缩率 option 文本改动影响状态恢复 | 恢复逻辑读 `value`（`index.js:1469`），文本仅供显示；实施后跑既有测试验证 |
| 用户已习惯勾选「增量合并」 | 该开关本就不产生任何行为，移除不改变任何结果——**这一点必须在提交信息里写清** |

**回滚点**：分支 tip `f267628`。改动集中在模板 + `index.js` 三处 + 注释，回滚即 `git revert`。

## 8. 与其它任务的接缝

- 父任务 `09-25-workbench-native-onesop` 的 T1/T2/T3 均已完成；本任务是最后一片。
- 本任务**不触碰** T3 新加的宿主适配器（`confirmDialog` / 存储 Inspector / `hostSelectionCapability`）。
