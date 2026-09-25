# T3 盘点：Luker 原生可对接面（2026-09-25 现场取证）

> 取证方式：GitHub API 读 `funnycups/Luker` 官方源码 + Dev Luker（8003，Luker 2.7.0 @ `8cd177ed2`）实机探测。
> **本文件只记事实**；「对接哪些 / 怎么降级」的建议清单与用户裁决另记 `prd.md`。

## 0. 实例与环境事实（本轮新测）

| 项 | 事实 |
| --- | --- |
| Dev Luker | `Instance/Dev/Luker`，`config.yaml` **显式 `port: 8003`**（合规 L0-16），`ssl.enabled: true` |
| 启动 | `node server.js`（`NODE_ENV=production`），起效约 26s（含 webpack 编译前端库） |
| 登录门禁 | `enableUserAccounts: true` + `whitelistMode: true`；`/` → **302 `/login`**，匿名 `/api/**` **403**，`/csrf-token` 200 |
| **浏览器直通** | Playwright 持久化上下文 `goto('/')` **无门禁**（未落 `/login`），登录后 `/api/users/me` **200** —— 故 UI E2E 走浏览器路径可行，curl 匿名不可行 |
| 插件装载 | 已 `git clone` 到 `data/default-user/extensions/st-zip-converter` @ `30c00be`；实测 `#st_zip_converter_settings` / `.st-converter-drawer-app` / `#st-zip-converter-menu-item` **全部就位** |
| 注入节点计数 | `[data-st-zip-injected="1"]` = **0**，与 Real 8004 一致；但 `#st-zip-converter-menu-item` 存在 → **注入机制本身正常**，仅依赖 `.userBackupButton` 的那两处因宿主面板未打开而未触发 |

> 环境探针：`.trellis/tasks/09-25-luker-native-integration/research/pw-dev-login-probe.cjs`

## 1. 本插件当前已用的宿主端点（`grep -rhoE "/api/..." src/ index.js`）

```
/api/extensions/delete      /api/users/backup
/api/extensions/discover    /api/users/me
/api/extensions/install     /api/users/restore
/api/users/storage/inspect
```

## 2. 存储配额（候选对接面 ①）

| 项 | 事实 |
| --- | --- |
| 数据端点 | `/api/users/storage/inspect` —— 插件**已在用**（`src/ui/usage-dashboard.js`） |
| 原生 UI 模块 | `public/scripts/storage-inspector.js`（16.4 KB） |
| 导出 | `openStorageInspector(dataSource)`（:380）、`mountStorageInspector(dataSource, container)`（:401）、`createStorageInspector(opts)`（:415）、`RestProvider`（:62）、`ThrowingMutator`（:82） |
| **挂载方式** | **无 `window.*` 挂载**；`st-context.js` **未**把 inspector 放进 `getContext()` |
| 官方调用方 | 全仓仅 `public/scripts/user.js` 一处 `import` 调用 → 宿主自己内部使用 |
| **可取路径** | 实测 `GET https://127.0.0.1:8003/scripts/storage-inspector.js` → **HTTP 200**。即**宿主根绝对路径 `'/scripts/storage-inspector.js'` 可用**，与插件自身安装位置无关（ST 在 `public/scripts/extensions/third-party/**`、Luker 在 `data/<user>/extensions/**` 均可） |
| T2 遗留接缝 | T2 已做好 `#btn-storage-inspector` 按钮**外观**（`workbench-template.js:51`，抽屉态专属，宿主不可用时整块 `hidden`），**行为归 T3** |

**待证**（未取证，不得当结论用）：
- `openStorageInspector(dataSource)` 的 `dataSource` 必需形状（是否必须传 Luker 的 `RestProvider` 实例）；
- 该模块 import 后是否会因宿主侧模块图依赖（`./util/...`）而失败。

## 3. 备份管理器（候选对接面 ②）

| 项 | 事实 |
| --- | --- |
| 原生模板 | `public/scripts/templates/userBackupManager.html`（**仅 Luker 有**；ST 检索 `userBackupManager` 无命中） |
| 锚点 | `.userBackupManager .backupActionRow`（含原生 ZIP 下载按钮）；ST 检索 `backupActionRow` **无命中** |
| 渲染方式 | 由 `openBackupManager` 经 `callGenericPopup` 动态渲染 |
| 插件现状 | `mountLukerBackupManagerButton()` 已在锚点前注入入口（`host-bridge.js:1468` 附近） |
| 账号弹层锚点 | `.userBackupButton` —— **ST 与 Luker 都有**（`templates/userProfile.html` + `admin.html`） |

## 4. 扩展管理器（候选对接面 ③）

端点 `/api/extensions/{discover,install,delete}` 插件**已在用**（`host-bridge.js` 扩展安装器）。
本轮未展开盘点原生 UI 侧是否有可复用的管理器弹层。

## 5. `/api/users/backup` 的 selection 语义（候选对接面 ④）

| 宿主 | 语义（父 PRD `09-25-workbench-native-onesop` 已记，本轮未复核） |
| --- | --- |
| ST | **不支持** selection → 全量导出 + 插件内过滤 |
| Luker | **支持** → 透传勾选 |

代码侧对应 `host-bridge.js` 的 `hostSupportsSelection`（`index.js` 依据它决定是否走转换过滤）。

## 6. 另一条可能更稳的路：`getContext()` 已暴露的存储能力

`st-context.js` 除 T2 已用的弹窗面外，还暴露：

| 键 | 位置 | 含义 |
| --- | --- | --- |
| `accountStorage` | Luker `st-context.js:2413`（源 `util/AccountStorage.js:145` `export const accountStorage = new AccountStorage()`） | 账号级存储对象 |
| `storage` | Luker `st-context.js:197`（`ITERATION_LIBRARY_API_NS.storage`） | 某 API 命名空间下的 storage |

**待证**：两者的可用方法面未取证。若 `accountStorage` 能直接给出配额读数，可能比调 `/api/users/storage/inspect` 更贴合「原生能力」语义。

## 7. 对本任务的直接含义

1. 存储配额的原生 UI **不能**从 `getContext()` 拿到（与弹窗面不同），只能：
   ① 走**根绝对路径动态 `import('/scripts/storage-inspector.js')`**；或
   ② 退化为「调 `/api/users/storage/inspect` 自绘」——但这正是 T2 按用户裁决 13 移除的形态。
2. `getContext()` 可在**独立态**安全缺失，故所有对接必须保持 T2 已确立的
   「特性检测 + 静默降级」形态（`confirmDialog()` 是既有样板）。
3. 注入类对接（`.userBackupButton` 系）在**真机两种实例上都未观测到触发**，
   承接 T2 遗留项，需在宿主面板打开路径上确证。
