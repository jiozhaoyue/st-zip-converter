# 宿主恢复端点事实（2026-09-25 认证态实测）

> 本文件是任务 `09-25-batch-restore-luker-endpoint` 的前置取证（OQ-1 / OQ-2），
> 结论用于 R1 端点解析与「死按钮」降级规则。原始读数见 `host-endpoint-facts.json`。

## 0. 结论速览（**推翻两条既有记载**）

| 事实 | 本次实测（2026-09-25） | 既有记载 | 判定 |
| --- | --- | --- | --- |
| Luker `/api/users/me` | **200**（认证态，`{"handle":"default-user",…}`） | spec `tavern-datapack-formats.md:195`「同样 404」 | **旧记载错**（匿名上下文所得） |
| Luker `/api/users/restore` | **404** | spec `:195` 404 | 一致 |
| Luker `/api/users/restore-backup` | **存在**（空体 → 400 `Missing required fields`） | spec `:196` 记为 `No backup file uploaded` | 存在性一致，**错误文案已漂移** |
| ST `/api/users/restore` | **404** | 插件默认按此端点恢复 | **插件在 ST 上一直是死路** |
| ST `/api/users/restore-backup` | **404** | 09-01 源码结论「ST 无整包导入」 | 一致 → **ST 压根没有整包恢复端点** |

## 1. 探测方法（可复核）

- **黑盒为主**：认证态下用**空体 POST** 判存在性——路由存在 → `400`（拒绝请求，**不写任何数据**）；
  路由不存在 → `404`；无 CSRF → `403`。
- **对照实验（Dev ST 8001）**证明方法有效：
  - `POST /api/users/backup`（已知存在）→ **400** `{"error":"Missing required fields"}`
  - `POST /api/users/zzz-nope`（构造不存在）→ **404**
  - 同上但**不带 CSRF** → **403**
- **源码仅作交叉印证**（非契约，L1-MR-5）：列路由注册点以确认「不是漏探某个别名」。
- 全部为只读/空体探测；未提交任何真实数据包，未触发任何写入。

## 2. Dev Luker 8003（Luker 2.7.0 @ `e1dbd1904`）

会话上下文：Playwright 持久档案 `.pw-profile-dev`（**认证态**，页面落地即 `/`，无 `/login` 跳转）。

| 探测 | 结果 | 原始读数 |
| --- | --- | --- |
| `GET /csrf-token` | 200 | `{"token":"01d8653d…"}` |
| `GET /api/users/me` | **200** | `{"handle":"default-user","name":"User","avatar":"data:image/png;base64,…"}` |
| `POST /api/users/restore`（空体） | **404** | Flask 风格 `Not found` HTML 页 |
| `POST /api/users/restore-backup`（空体） | **400** | `{"error":"Missing required fields"}` |
| `getContext()` | 可用 | 235 个键；`getRequestHeaders` 为函数且返回含 `X-CSRF-Token` |

**句柄字段枚举（关键）**：`getContext()` 中 `name1` = 用户**人设名**（本机为中文名，非 `default-user`）、
`name2` = `Luker System`；**没有** `handle` / `user_handle` / `account` 等字段。
→ 账户句柄的唯一可靠来源就是 `/api/users/me` 的 `handle` 字段。
**禁止**把 `name1` 当句柄（会把包恢复进错误目录）。

源码交叉印证（`src/endpoints/users-private.js`）：`/restore-backup`（:1237）、
`/restore-backup/probe`（:1197）、`/import/data-zip`（:1465）、`/lan-migration/import`（:1361）
均在此文件注册，`/restore` 无注册点。

## 3. Dev SillyTavern 8001（ST 1.19.0 @ `06bde939f`）

实例由本任务启动（`node server.js`，`127.0.0.1:8001`，config `port: 8001`；`enableUserAccounts: false`）。

| 探测 | 结果 |
| --- | --- |
| `GET /csrf-token` | 200 |
| `GET /api/users/me` | 200（`{"handle":"default-user",…}`） |
| `POST /api/users/restore`（空体） | **404**（`Not Found` 页） |
| `POST /api/users/restore-backup`（空体） | **404** |
| 对照 `POST /api/users/backup`（空体） | 400 → 方法有效 |

源码交叉印证：`src/endpoints/users-private.js` 仅注册 `logout / me / change-avatar /
change-password / backup / reset-settings / change-name / reset-step1 / reset-step2`
——**没有任何整包恢复路由**；全仓 restore 类路由只有 `presets.js:83 /restore` 与
`settings.js:350 /restore-snapshot`（单项恢复）。前端 `public/scripts/user.js` 只调
`/api/users/backup`（导出），**无导入调用点**。

→ **ST 1.19.0 不提供整包恢复能力**；插件在 ST 上的「写回宿主」注定 404。

## 4. 对实现的影响（已回写 `prd.md` / `design.md`）

1. **`getHandle()` 不改**（R1.1 降级为「保留现状 + 补注释」）——认证态 `/api/users/me` 可用，
   而 `getContext()` 里没有句柄字段，引入它只会带来人设名误用风险。
2. **CSRF 官方优先路径可加**（R1.2）：`getRequestHeaders()` 存在且含 `X-CSRF-Token`。
3. **端点候选序**按本表定案：`luker → ['/api/users/restore-backup', '/api/users/restore']`、
   `st → ['/api/users/restore', '/api/users/restore-backup']`；**仅 404/405 回退**（R1.3/R1.4）。
4. **新增 R1.6（死按钮规则）**：ST 上全部候选 404 ⇒ 该宿主**无恢复能力**，
   首次探测到之后必须在会话内记住，并**禁用**恢复入口 + 给出「请用宿主原生方式导入」的说明，
   **不得**留下点了必然失败的按钮，也不得报「已恢复」。
5. **spec 待更正三处**：`:195`（`/api/users/me` 404 的适用范围）、`:196`（400 文案已漂移）、
   `:201`（「Luker 下隐藏恢复按钮」与现状相反）。
6. ST 侧无恢复能力 ⇒ 本任务对 ST 的行为是**诚实降级**，不是「修好」——
   若要真支持 ST 整包导入，需要宿主侧能力（另案，不在本任务）。

## 5. 恢复 payload 对照实验（含一处**自纠**）

探针：`pw-restore-variants.cjs`（Dev 8003 认证态），合成小包仅含
`worlds/zz-probe-a.json` + `manifest.json`。三路对照，**同一包**：

| 打法 | 端点 | status | restoredCount | skippedCount | 首个 skip 原因 |
| --- | --- | --- | --- | --- | --- |
| A 插件模块 `restoreToHost` | `/api/users/restore-backup` | — | **1** | 1 | `path_not_in_selected_categories`（manifest.json） |
| B 直连、**不带** `selection` | `/api/users/restore-backup` | 200 | **1** | 1 | 同上 |
| C 直连、**带** 全类目 `selection` | `/api/users/restore-backup` | 200 | **1** | 1 | 同上 |

结论：

1. **插件路径在 Luker 上确实写入成功**（restoredCount=1），R1 端点到内容的链路打通。
2. **`selection` 不是本宿主的必需字段**：缺省亦按全量处理。插件仍显式传全类目——
   属**把语义显式化**（与 Luker 自身 `public/scripts/user.js`、同类扩展 Atria 的 payload 一致），
   不是修 bug；代码注释已按此措辞。
3. `skippedCount=1` 恒为包内 `manifest.json`（非类目文件，正常跳过），不是失败。

### 自纠：一次被我自己的探针包误导的结论

- **错误**：首版探针包把 lorebook 放在 `lorebooks/zz-probe-a.json`，宿主把**全部条目**
  skip（`path_not_in_selected_categories`），返回 200 且 `restoredCount=0`。
  我据此在提交 `24fbbc5` 的说明里写成「Luker 上的静默空恢复 / 不传 selection 导致」。
- **真因**：宿主里 lorebook 的目录是 **`worlds/`**（`src/core/inspect.js:67`
  `hubPath.startsWith('worlds/') → CATEGORIES.LOREBOOKS`），`lorebooks` 只是**类目名**。
  即：**是我的探针包路径写错**，与插件 payload 无关。
- **处置**：代码注释、本节、以及任务收口记录均已更正；`nothingRestored` 这一「200 不等于有写入」
  的守卫**保留**（它由上面这次 200+0 的真实观测驱动，且能防住同类假成功）。

