# Luker 原生能力对接（配额 / 备份管理器 / 扩展管理）

> 父任务：`09-25-workbench-native-onesop`（T3）。
> 盘点证据：`research/native-surfaces.md`（GitHub API 读 `funnycups/Luker` 源码 + Dev Luker 8003 实机）。
> **范围经用户 2026-09-25 逐项确认**：四项对接面全部纳入（多选问答）。

## Goal

把插件从「自己造轮子」转为**委托宿主原生能力**：存储配额走 Luker 原生 Storage Inspector、
扩展管理走原生扩展管理器、备份入口贴合原生备份管理器；宿主不具备该能力时**静默降级**，
主路径（纯前端转换）保持全功能（L0-11 / L1-MR-1）。

## Background

### 已证事实（`research/native-surfaces.md`，标「待证」者不得当结论用）

| 对接面 | 宿主原生面 | 暴露方式 | 本插件现状 |
| --- | --- | --- | --- |
| ① 存储配额 | `public/scripts/storage-inspector.js`，导出 `openStorageInspector(dataSource)` / `mountStorageInspector(dataSource, container)` / `createStorageInspector(opts)` | **无 `window` 挂载、`getContext()` 未暴露**；但 `GET /scripts/storage-inspector.js` **HTTP 200**（宿主根绝对路径可取） | `usage-dashboard.js` 调 `/api/users/storage/inspect` 自绘配额条；T2 按裁决 13 已移除自绘条，改为 `#btn-storage-inspector` 按钮**外观**（行为归本任务） |
| ② 备份管理器 | `templates/userBackupManager.html` + 锚点 `.userBackupManager .backupActionRow`（**仅 Luker 有**）；账号弹层锚点 `.userBackupButton`（**ST 与 Luker 都有**） | DOM 锚点，经 `callGenericPopup` 动态渲染 | `mountLukerBackupManagerButton()` / `mountNativeBackupButton()` 已实现；**两实例真机上均未观测到注入触发**（注入机制本身正常 —— `#st-zip-converter-menu-item` 存在） |
| ③ 扩展管理 | `getContext().openThirdPartyExtensionMenu`（Luker `st-context.js:114`）、`getExtensionManifest`、`getExtensionApi` / `registerExtensionApi`、`extension_settings`；服务端 `src/endpoints/extensions.js` | **`getContext()` 已暴露**（官方路径） | `host-bridge.js` 自绘流程：直连 `/api/extensions/{discover,install,delete}`（扩展清单 / 跨实例迁移安装 / `third-party/third-party` 嵌套异常探测） |
| ④ selection 语义 | `/api/users/backup`：ST **不支持** selection（全量导出 + 插件内过滤）；Luker **支持**（透传勾选） | HTTP 端点 | `host-bridge.js` 的 `hostSupportsSelection` 分支 |

### 环境事实（本轮新测）

- Dev Luker `8003`：`config.yaml` 显式 `port: 8003`（合规 L0-16）；`enableUserAccounts: true` + `whitelistMode: true` 使**匿名 curl 全 403**，但 **Playwright 浏览器直通无门禁**（探针：`research/pw-dev-login-probe.cjs`）。
- 插件已 `git clone` 到 `Instance/Dev/Luker/data/default-user/extensions/st-zip-converter`（走 Git，合规）。

## Requirements

### R1 存储配额 → 原生 Storage Inspector（①）

- **R1.1** `#btn-storage-inspector`（T2 已做好外观）接入 Luker 原生 Inspector：经**宿主根绝对路径**动态 `import('/scripts/storage-inspector.js')` 取 `openStorageInspector`。
- **R1.2** 特性检测：模块取不到 / 导入失败 / 导出缺失 → 该按钮整块保持 `hidden`（T2 现状），不得出现死按钮。
- **R1.3** 降级路径保留：原生不可用时**允许**沿用 `/api/users/storage/inspect` 只读读数，但**不得**恢复 T2 已按裁决 13 移除的自绘双行配额条。
- **R1.4** 必须先证 `openStorageInspector(dataSource)` 的 `dataSource` 必需形状（是否必须传 Luker 的 `RestProvider` 实例）——**待证项，未证不得据此实现**。

### R2 备份管理器对接（②）

- **R2.1** **真机确证注入可见性**（承接 T2 遗留）：在 Dev 8003 上走通「打开账号弹层 / 备份管理器弹层 → 锚点出现 → 注入按钮可见」的完整路径，并记录宿主面板的**实际进入路径**（T2 探针点过 4 个候选入口均未触发）。
- **R2.2** 确证后修正 `mountNativeBackupButton` / `mountLukerBackupManagerButton` 的锚点假设与文档注释（现注释写「账号弹层 + 管理面板每用户行」，须以实机为准）。
- **R2.3** 保持幂等 + 自愈语义不变（`dataset.stZipInjected` + `watchHostDom`）。

### R3 扩展管理 → 原生管理器（③，**两级门禁**）

- **R3.1** **先盘点后建议**：盘点 `openThirdPartyExtensionMenu()`、`getExtensionApi` / `registerExtensionApi`、`getExtensionManifest`、`extension_settings` 的可用面与语义，产出「哪些自绘流程可替换为原生 / 哪些必须保留」的建议清单，落 `research/`。
- **R3.2** 建议清单**经用户逐项确认后**才实施替换；未获确认不得改动既有 `discover/install/delete` 流程。
- **R3.3** 无论是否替换，`third-party/third-party` 嵌套异常探测（L1-MR-12 防线）**必须保留**。

### R4 `/api/users/backup` selection 语义收敛（④）

- **R4.1** 把 ST/Luker 的 selection 差异从隐式分支收敛为**显式声明**：在 `host-bridge.js` 以数据表（宿主 → 是否支持 selection）表达，替代当前散落的 `hostSupportsSelection` 布尔推导。
- **R4.2** 差异须在 UI 上有**状态读数**（非解释性文案，受 R4/用户裁决 12 约束）：例如 Luker 透传勾选、ST 全量导出后插件内过滤，用户不必猜为何包大小不同。

### R5 贯穿约束

- **R5.1** 全部对接走「适配器 + 特性检测 + 静默降级」，宿主差异**只许进 `host-bridge.js`**（L0-9）。
- **R5.2** 宿主能力一律经**官方文档路径 `getContext()`** 优先；仅在 `getContext()` 未暴露时才用宿主根绝对路径动态 `import`（①属此例，须在注释写明理由与实测证据）。
- **R5.3** `npm test` 全绿 + 三条守卫通过，零回归（当前基线 39 文件 / 333 passed / 2 skipped）。
- **R5.4** E2E 与实机验证**默认只对 Dev 实例（8001 / 8003）**；本轮 Dev Luker = 8003。
- **R5.5** 不装新依赖（G6）；不引入外部 CDN。

## Acceptance Criteria

- [ ] ① `#btn-storage-inspector` 在 Dev 8003 上点击可唤起 Luker 原生 Inspector（实机证据）；模块不可用时按钮保持隐藏（有测试或实机反例）。
- [ ] ① `openStorageInspector` 的 `dataSource` 形状有取证结论（或明确记录「未能取证，改为 X 方案」）。
- [x] ② 真机记录宿主面板进入路径并确证注入按钮可见；确证结论与 `host-bridge.js` 注释一致。
      **证据（2026-09-25 阶段 1，Dev Luker 8003）**：`research/native-surfaces.md` §3 +
      `research/pw-probe-backup-anchors.cjs`。进入路径 `#account_button`(`user.js:3469`) →
      `openUserProfile()`(:2350) → `renderTemplateAsync('userProfile')` → 原生 `.userBackupButton`(:2372) →
      `openBackupManager()`(:1136) → `renderTemplateAsync('userBackupManager')`。
      逐步计数：初始 0 → 账号弹层 注入 **2** → 备份管理器 注入 **3**；结构逐项符合 `makeHostButton` 契约。
      **T2 遗留项结论**：注入本来就在工作，T2 的「未生效」是**入口 id 点错**所致（其探针点的 4 个 id 在 Luker 上均非正确入口）。
- [ ] ③ `research/` 产出扩展管理可对接面盘点 + 建议清单；**未经用户逐项确认前不得改动既有流程**。
- [ ] ④ selection 差异以显式数据表表达，且有对应单测断言 ST / Luker / 未知宿主三态。
- [ ] 全仓宿主能力调用点均可溯源到「`getContext()` 官方路径」或「已注明理由的根绝对路径 import」；无第三类。
- [ ] `npm test` 全绿 + `check:css-scope` / `check:dom-injection` / `check:template-source` 三条守卫通过。
- [ ] Dev 8003 实机三入口（独立/插件/模态）渲染无回归。
- [ ] 本任务不写 `Instance/Real/**`；Dev 实例若有写入（如 git 装载）须在收尾记录中说明且 `git status` 干净。

## Out of Scope

- 不改转换核心（`src/core/**`）语义（按 ④ 需动的分支放 `host-bridge.js`）。
- 不复原被裁决 13 移除的自绘配额条。
- T4 的上下传链路与打包默认值收敛（`09-25-transfer-pack-optimize`）。
- 不实现 Authority 服务端对接。

## Notes

- 本 PRD 的候选对接面已于 2026-09-25 经用户在交互问答中**多选确认全部纳入**。
- ③ 的用户确认形态是「纳入盘点 + 建议」，**不是**「直接替换」；替换为第二道门禁。
