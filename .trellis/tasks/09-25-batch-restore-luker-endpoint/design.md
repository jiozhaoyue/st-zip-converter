# 批量恢复编排与 Luker 恢复端点平台化 — 技术设计

> 上游：`prd.md`（Requirements / AC）。本文件只写技术设计，不重复需求。
> 全部宿主事实以 2026-09-25 现场取证为准，证据锚点见 `prd.md` §Background。

## 0. 边界与分层

| 改动落点 | 允许改什么 | 不许改什么 |
| --- | --- | --- |
| `src/ui/host-bridge.js` | 端点解析、凭证获取、postRestore 回退 | 不改 `restoreToHost` 的**对外签名与返回契约** |
| `src/core/restore-batch.js`（**新增**） | 批次状态机（纯逻辑） | 不得出现 DOM / 宿主 / `fetch` |
| `src/ui/export-queue.js` | 批量入口按钮的接线、逐项状态渲染 | 不改 `queue.download/stash/remove` 语义 |
| `index.js` | 批次编排控制、开批模态、刷新按钮 | 不动 `openRestoreModal` 的单条路径 |
| `src/core/**` 其他、`src/vendor/**` | — | **不动**（L1-MR-11：vendor 勿升级改动） |

- **L0-9**：平台差异只许出现在 `host-bridge.js`；`index.js` / `export-queue.js` 内**不得**出现
  `platform === 'luker'` 之类的判断（候选表由桥接层持有，编排层只问「能不能恢复」）。
- **L0-11 / L1-MR-1**：编排状态机**不依赖 Authority**；后端可用与否不影响批量恢复可用性。

## 1. 宿主端点解析（桥接层）

### 1.1 现状与目标

现状：`host-bridge.js:728` 硬编码 `POST /api/users/restore`，`platform` 形参仅用于日志（`:719`）。

目标形态：

```js
// host-bridge.js 内（不导出候选表，避免编排层散落平台判断）
const RESTORE_ENDPOINT_CANDIDATES = {
  luker: ['/api/users/restore-backup', '/api/users/restore'],
  st:    ['/api/users/restore',        '/api/users/restore-backup'],
};
let restoreEndpointHit = null; // 会话内缓存命中端点；不持久化、不写 IndexedDB
```

`postRestoreWithFallback({ formData, token, platform, signal, timeoutMs })`：

| 响应 | 动作 | 依据 |
| --- | --- | --- |
| `404` / `405` | 试下一候选 | 路由不存在 → 请求**未达处理器**，无副作用 |
| `2xx` | 成功，写 `restoreEndpointHit` | — |
| 其他（`5xx` / `413` / 超时 / 网络中断 / 取消） | **不换端点**，交回既有三态结果处理 | 请求可能**已被处理**，换端点重试 = 对同一用户目录重复写入（R1.4 硬约束） |
| 全候选 `404/405` | **判定「本宿主无恢复能力」**（见 §1.2），会话内记标记 | 诚实失败，不伪成功 |

### 1.2 能力缺失分支（R1.6 死按钮规则）

实测已确认 **ST 1.19.0 无整包恢复端点**（`research/host-endpoint-facts.md`），故必须实现该分支：

```
resolveRestoreCapability(platform) → 'available' | 'unsupported'
```

- 触发：候选全部返回 `404/405`。此时**不是**「恢复失败」，而是「宿主没这个能力」。
- 会话内记忆：模块级标记（`restoreCapability`），**不持久化**，刷新页面重置。
- UI 后果：恢复入口（`#btn-restore-luker` / 待导出区批量按钮）→ **禁用** + 原因 `title`
  「当前宿主未提供整包恢复接口（已探测 …），请用宿主原生方式导入」；
  不再重复探测（`restoreInFlight` 之外另加能力短路）。
- 文案**不得**用「恢复失败」，更不得报成功——这是「不出现死按钮」原则的直接落地
  （同 `09-25-*` 系列已确立的裁决 13：不渲染无效控件）。
- 独立态（standalone，`isHost=false`）：不涉及。

### 1.3 零回归契约（硬）

`restoreToHost(zipBlob, { mode, platform, signal, timeoutMs })` 的**签名、返回形状
（`{ success, unconfirmed?, reason? }`）与抛错语义一律不变**——`test/restore-chain.test.js`
的 10 条（有界等待 / 并发互斥 / 取消入口 / 伪成功）必须原样通过。

### 1.4 概念边界（承接父任务 AC「文档区分五个概念」）

| 概念 | 本任务是否涉及 | 落点 |
| --- | --- | --- |
| 多选入工作区 | 不改 | `file-drop.js` + `index.js:1278` `onFilesReady` |
| 分卷 ZIP（自包含合法包） | 消费其产物 | `src/core/splitter.js`；条目 `origin: 'split-part'` |
| **逐卷恢复（本任务）** | **实现** | `restore-batch.js` + `export-queue.js` 批量入口 |
| 原子合并恢复 | **不存在，不实现** | 宿主无公开契约（`tavern-datapack-formats.md:194-204`） |
| Authority 后台暂存 | 不涉及 | `src/storage/authority-store.js`（可选增强层） |

## 2. 凭证获取（句柄 / CSRF）

### 2.1 风险分级（决定实现顺序）

- **CSRF**：取错只是请求被拒（403），无数据风险 → 可安全地「官方优先」：
  `getRequestHeaders()['X-CSRF-Token']` → 回退 `/csrf-token`。
- **句柄**：取错 = **写错用户目录**（`host-bridge.js:723` 的 `formData.append('handle', handle)`
  直接决定写入目标），属不可逆风险 → **必须取证驱动**：
  1. 认证态实测 `/api/users/me`（OQ-1）；
  2. 若 200 → **保留现状**，仅补注释说明「该端点是句柄的权威来源」，不引入 `getContext()` 依赖；
  3. 若 404/403 → 现场枚举候选来源（`getContext()` 的字段名须逐个读数确认；
     ⚠ `name1` 是**用户人设名**，禁止当句柄用），确认后再接线；
  4. 全部不可用 → 抛错（宁可不恢复，也不写错目录）。

### 2.2 实现形态（**已按取证定案**）

取证结论（`research/host-endpoint-facts.md`）：认证态 `/api/users/me` 在 Luker 与 ST **均 200**，
且 `getContext()` 中**没有**账户句柄字段。故：

```js
// getHandle()：**不改行为**，仅补注释
/**
 * 获取当前登录用户句柄（账户目录名，如 default-user）。
 * ⚠ 该端点是句柄的唯一权威来源（2026-09-25 两宿主认证态实测均 200）；
 *   `getContext().name1` 是**用户人设名**（本机实测为中文名），误当句柄会把包恢复进错误目录。
 */
export async function getHandle({ signal } = {}) { /* 现状不变 */ }

// getCsrfToken()：加官方优先路径（纯增强，失败即回退）
export async function getCsrfToken({ signal } = {}) {
  const fromContext = readContextCsrf();        // getContext().getRequestHeaders()['X-CSRF-Token']
  if (fromContext) return fromContext;
  /* ...现有 /csrf-token 路径原样保留... */
}
```

`readContextCsrf()` 用防御式访问（`globalThis.SillyTavern?.getContext?.()`，抛错即 `null`），
Node/Vitest 无宿主时直接返回 `null` → 走原路径，保证 `restore-chain.test.js` 现有桩不受影响。

## 3. 批量恢复编排

### 3.1 为什么状态机放 `src/core/`

`src/core/task-manager.js` 已有先例：**纯状态机 + 副作用经回调注入**（adapter 接缝，L0-11）。
批量恢复同形：状态机只接受 `{ items, restoreOne, onItemDone }` 并产出逐项结果，
从而在 Node/Vitest 下**可单测**，无需 jsdom（本仓无 jsdom，见 `09-24` 验收记录）。

### 3.2 状态机

```
                 ┌──────── retryFailed(itemIds) ────────┐
                 ▼                                      │
idle → queued → running(item i) → item-done | item-failed
                     │                 │            │
                     │                 └────────────┴──→ 下一项
                     │
              abort ┴──→ aborted（保留已完成项记录）
   全部结束 → done（全成功） | partial-failed（有失败项）
```

- `restoreOne(item)` 抛错 → 记 `item-failed(reason)` 并**继续下一项**（R2.7）。
- `retryFailed()` 只把失败项重新入队；**已成功项不重跑**（R2.2）。
- `abort()` 复用既有取消语义（`cancelRestoreInFlight()`），当前项记 `aborted`。

### 3.3 数据流与接缝

```
待导出区 selected(Set)
  → 「写回宿主」（N 项，export-queue.js:339-345 现有按钮改造）
  → index.js startBatchRestore(items)：开批前模态【选一次模式 merge/overwrite】(R2.3)
  → createRestoreBatch({ items, restoreOne })          // core 状态机
       restoreOne = (item) => restoreToHost(item.blob, { mode, platform, timeoutMs })
  → 每项结果 → export-queue 渲染逐项状态（新增可选参数 restoreBatch）
  → 收尾：done | partial-failed | aborted
  → 渲染「刷新页面生效」按钮（index.js，用户点击才 location.reload()）
```

- **互斥**：批次运行期间 `restoreInFlight` 为真 → 所有写回入口（单条目行按钮、批量按钮）
  自动禁用（既有 `applyActionAvailability` / `render` 的 `restoreInFlight` 分支复用，零新增机制）。
- **顺序**：按 `queue.items` 列表顺序，不重排（R2.8）。
- **OQ-3 默认取禁用**：批次进行中单条目入口禁用（与既有互斥一致）。

### 3.4 渲染接缝（零回归）

`export-queue.js` 的 `render()` 增加**可选**参数 `restoreBatch`（默认 `undefined`）：
- 传 `undefined` → 行为与今天**完全一致**（单条目路径不受影响）；
- 传入 → 在「已选 N 项」批操作条下方渲染逐项状态（`完成 x/N`、失败项与原因、重试按钮）。

## 4. 对话框落点（受 `host-capabilities.md` §Host Native Dialog Adapter 约束）

- **不新增自绘浮层**（L1-MR-4）。批次模式选择**沿用既有恢复模态**（`#restore-modal-overlay`，
  `index.js:1183` `openRestoreModal`）——它已在插件工作台内、样式合规、用户已熟悉；
  本任务只改其**文案与批次语境**（「即将对 N 项产物执行恢复」+ 模式单选沿用）。
  为何不改成宿主原生 Popup：模式是 **3 态选择**（合并/覆盖/取消），
  `Popup.show.confirm` 只有二元答案，硬套会退化成两连问。
- **凡需要「确认」类交互**（如「开始批量恢复本批 N 项？」）**必须**走既有适配器接缝：
  组件层声明 `confirmFn`（`export-queue.js:235` 已有该 DI 参数，缺省降级 `window.confirm`），
  `index.js` 注入 `host-bridge` 的 `confirmDialog`——**禁止**在组件层裸用 `confirm()`
  （`host-capabilities.md` §7 Wrong 示例），也不得硬编码 `POPUP_RESULT.AFFIRMATIVE = 1`。
- 迁移恢复模态到宿主原生 Popup：**不在本任务**（既有资产、非本任务引入），如需另案。

## 5. 诚实性文案

- 进行中：「已完成 x/N（部分数据已生效）」——**必须**含「部分数据已生效」语义。
- 收尾：`done` → 「全部 N 项恢复完成」；`partial-failed` → 「已完成 x/N，y 项失败（可重试）」。
- **禁止词**：`合并完成` / `已合并` / `全部合并`（在批量恢复语境）——验收时 `grep` 复核，
  必要时改词（现状 `index.js:764` 的日志是单条「合并写入」语义，指**宿主端 merge 模式**，
  与「原子合并」无关，允许保留，但不得出现在批量收尾文案里）。

## 6. 兼容与回滚

- **兼容**：单条目路径不变；`restoreToHost` 契约不变；无 Authority 不受影响；
  ST 侧首选候选仍是 `/api/users/restore`（行为不变，仅多一层回退能力）。
- **回滚点（分两次提交，各自可独立回滚）**：
  1. **提交 A：R1 端点解析 + 凭证**（`host-bridge.js`）——回滚即恢复硬编码端点；
  2. **提交 B：R2 批量编排 + R3 spec 更正**——回滚的**最小可用形态**是
     「N 项逐个走既有单条路径（模态逐个确认）」，**不是**退回「只恢复第一项」的静默部分执行
     （那是 B2 缺陷本身，禁止回滚回去）。
- **无数据迁移**：不写 DB、不改 schema、不动 IndexedDB 版本。

## 7. 验证矩阵

| 层 | 手段 | 覆盖 |
| --- | --- | --- |
| 单测（新） | `test/restore-batch.test.js` | 逐项推进、失败不中断、`retryFailed` 不重跑成功项、abort 保留记录、收尾态判定 |
| 单测（扩） | `test/restore-chain.test.js` | `404 → 回退命中第二候选`、`500 不重试第二候选`、会话缓存命中、凭证优先/回退 |
| 静态守卫 | `npm run check:css-scope` / `check:dom-injection` / `check:template-source` / `check:control-consumer` | 四条退出码 0 |
| Dev 实测 | Dev Luker 8003（在跑） | 认证态端点复测（R4.2）+ 2–3 个**合成小包**批量恢复（R4.3） |
| 全量 | `npm test` | 基线 42 文件 / 386 passed / 2 skipped 不得回退 |

**禁止**：Real 8004、真实聊天数据包、写 `Instance/**`、改 `src/vendor/**`。

## 8. 风险登记

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 句柄字段误用（如误采 `name1`） | **写错用户目录，不可逆** | R1.1 取证驱动；不确定则不改，只保留 `/api/users/me` |
| 非 404 失败时换端点重试 | 同一目录重复写入 | R1.4 硬约束 + 单测断言「500 不再试第二候选」 |
| 批量中途部分成功 | 数据半生效 | 如实文案 + 逐项记录 + 收尾刷新引导 |
| 单条目路径回归 | 既有功能损坏 | 不动 `openRestoreModal`；`restoreBatch` 参数缺省即旧行为 |
| ST 端点是否真存在（OQ-2） | 对 ST 用户报「假成功」 | 只报取证结论、不猜、不改 ST 行为；必要时降级为原生导入引导 |
| Dev ST 8001 未运行 | OQ-2 无法实机收口 | 记为未决 OQ，不阻塞其余 AC；如实标注 |
