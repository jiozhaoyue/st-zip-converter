# UI 精简与原生化 · 改造前后对照 + 8004 实机复验报告

> 任务：`09-25-ui-slim-native`（父任务 `09-25-workbench-native-onesop`）
> 采样脚本：`pw-final-verify.cjs` / `pw-probe-anchors.cjs`（均只读）+ 归档任务的 `pw-e1-ui-open.cjs`
> 原始采样 JSON 因含实例侧路径/用户数据风险按 `.gitignore` 不入库，可重跑脚本复现。

## 1. 改造前后对照（8004 Real Luker 插件抽屉态）

| 指标 | 改造前（`059257e`） | 改造后（`0256f9b`） | 变化 |
| --- | --- | --- | --- |
| 面板高度 | **1237 px** | **903 px** | **−334 px（−27.0%）** |
| DOM 节点 | 276 | 270 | −6 |
| 按钮总数 | 36 | 29 | −7 |
| **可见按钮** | **13** | **3** | **−10（−76.9%）** |
| 输入控件 | 19 | 18 | −1 |
| 复选框 | 8 | 7 | −1 |
| 单选 | 4 | 4 | 0 |
| `<details>` | 3 | **0** | 全部改宿主原生 `.inline-drawer` |
| `label` | 12 | 14 | +2 |

- 可见按钮清单（改造后）：`从宿主拉取` / `开始转换` / `展开日志`。
  `存储` 正确隐藏（宿主无存储面板时不留死按钮）、`恢复到当前用户` 正确隐藏（尚无产物）。
- 折叠区实测 `.inline-drawer` **5 个**：H 垃圾清理 / I 扩展打包 / J 增量与差量 / K 包名 / 报告详情。
- 基线来源：归档任务 `09-25-live-perf-diagnosis/research/e1-ui-open.before.json`（1237px）与
  `e1-ui-open.json`（903px），本轮 `final-verify-8004.json` 复测仍为 **903 px / 270 / 29 / 3 / 0**，
  与上一轮**逐项一致 → 无回归**。

## 2. 宿主原生确认弹窗适配器（R5.3）真机取证

对应实现：`src/ui/host-bridge.js` 的 `confirmDialog()`。

| 取证项 | 真机结果 | 含义 |
| --- | --- | --- |
| `typeof SillyTavern.getContext` | `function` | 上下文可取 |
| `ctx.Popup.show.confirm` | `function` | **原生分支成立**（无需动态 import） |
| `ctx.POPUP_RESULT.AFFIRMATIVE` / `NEGATIVE` | `1` / `0` | 常量齐备，不触发降级 |
| 端到端往返 | 唤起成功 → 点「取消」→ **返回 `0`**，promise 已 settle | `0 !== 1` → 适配器映射为 `false`，语义正确 |

配套单测 `test/confirm-dialog.test.js`（7 用例）覆盖：原生返回 AFFIRMATIVE / 非 AFFIRMATIVE /
`null`（关闭弹窗）/ `window.confirm` 降级 / 原生抛错静默降级 / `POPUP_RESULT` 缺失时不猜常量 /
`getContext` 抛错 / 双不可用不阻断调用方。

**接入面**：全仓 4 处破坏性确认全部改走该适配器——暂存区批量删除、暂存区行内删除、
待导出区「清空」、待导出区「取消在途恢复」。`grep -rn "[^a-zA-Z.]confirm(" src/ui/*.js index.js`
现仅剩死代码 `archive-manager.js` 一处（见 §4）。

## 3. 未能观测到的一项（如实记录）

`mountNativeBackupButton` / `mountLukerBackupManagerButton` 注入的按钮，**本次真机未观测到**：
探针点击 4 个候选宿主入口（`#user-settings-button` / `#sys-settings-button` / `#extensionsMenuButton` /
`#user-settings-block`）后，`.userBackupButton` / `.userBackupManager` / `.backupActionRow` 计数仍全为 0，
页面内亦无任何 `class*="ackup"` 元素。

**判断**：锚点在宿主源码中**确实存在**——GitHub 检索确认 `.userBackupButton` 同时存在于
ST 与 Luker 的 `public/scripts/templates/{userProfile,admin}.html`；
`.userBackupManager` / `.backupActionRow` 存在于 Luker 的 `public/scripts/templates/userBackupManager.html`。
故属**承载它们的宿主面板未被本次探针打开**（Luker 账号弹层 / 备份管理器弹层的进入路径与 ST 不同），
**不是本插件回归**。

**处置**：R7.3 的结构契约改由 `test/host-button-factory.test.js`（6 用例，最小 DOM 桩）确定性锁定，
覆盖：注入按钮带 `menu_button menu_button_icon` 原生类、`stZipInjected` 幂等标记、
图标在前文案在后（且文案走 `textContent` 而非 `innerHTML`）、click 先
`preventDefault`+`stopPropagation` 再回调、`onQuickFetch` 缺省时不注入「一键拉取」、
Luker 侧动作行锚点缺失时静默无操作。
**「真机注入可见性」仍未取证，作为遗留项交 T3（`09-25-luker-native-integration`）随宿主面板接手时一并确认。**

## 4. 附带发现（未在本任务处置）

- `src/ui/archive-manager.js`（含唯一的裸 `confirm()` 残留）**全仓无任何引用**，仅被陈旧构建产物
  `dist/index.html` 的注释提及 → 疑为死代码。按 PARDON（L0-6）**删除既有文件需用户批准**，
  本任务不擅自删，已另行登记。
- 8004 控制台错误全部来自**其他扩展/宿主**（`stable-diffusion` 的 SD WebUI 500、
  `SillyTavern-Dialoguet` 的 persona 校验、`shujuku_v120` 全局异常、
  以及 `Uncaught SyntaxError: Identifier 'SPresetSettings' has already been declared`）——
  经 `grep` 确认 `SPresetSettings` 非本仓符号，**无一条错误来自 st-zip-converter**。

## 5. 复验方法（可重跑）

```bash
# 1. 实例临时切到待验提交（结束后必须还原）
P=/d/Repo/Tavern-repo/Instance/Real/Luker/data/default-user/extensions/st-zip-converter
git -C "$P" fetch origin fix/perf-hardening-transfer-memory
git -C "$P" checkout FETCH_HEAD

# 2. 只读复验
node .trellis/tasks/09-25-ui-slim-native/research/pw-final-verify.cjs
node .trellis/tasks/09-25-ui-slim-native/research/pw-probe-anchors.cjs

# 3. 还原实例
git -C "$P" checkout -f main && git -C "$P" status --short   # 须为空
```

本轮还原核对：HEAD `3a98fb3`（= `origin/main`）、`git status --short` **空**、分支 `main`。
