# 实施清单（执行阶段 · 复选框随执行实时勾选，禁止事后批量补勾）

> 上游：`prd.md`（Requirements / AC）、`design.md`（技术设计，§号在本文件内引用）。
> 开始前必须已完成 §0 的前置项；`task.py start` 之后才允许改产品代码。
>
> ⚠ **自纠**：本清单的勾选**未做到实时**（执行期间连续推进，勾选集中在收口时按
> 已落盘的证据回填，2026-09-25）。回填依据是各条的**现场证据**而非记忆；
> 未取得证据的条目（§4.2/4.3/4.4）**保持未勾选**，见 PRD §「残留」R-2。

## 0. 前置（规划门）

- [x] 0.1 **检索先行**（L0-3）已完成并留证：GitHub 代码检索命中同类扩展 Atria 的
      `backup-sync-center.js` 与 Luker `public/scripts/user.js` 的 `restore-backup` 用法
      （见 `prd.md` §B4）；通用搜索引擎本机不可用（WebSearch 报错），以 GitHub API/源码检索替代。
- [x] 0.2 **OQ-1 取证完成**（2026-09-25）：Dev Luker 8003 认证态实测 `/api/users/me` = **200**、
      `/api/users/restore` = **404**、`/api/users/restore-backup` = **400（存在）**；
      `getContext()` 235 键中无句柄字段（`name1` 是人设名）。
      探针 `research/pw-endpoint-probe.cjs`，原始读数 `research/host-endpoint-facts.json`，
      结论 `research/host-endpoint-facts.md`。
- [x] 0.3 **OQ-2 取证完成**：已启动 Dev ST 8001（`node server.js`，127.0.0.1:8001）并探测——
      `/api/users/restore` 与 `/api/users/restore-backup` **均 404**；对照实验
      （`/api/users/backup`→400、不存在路由→404、无 CSRF→403）证明方法有效；
      `src/endpoints/users-private.js` 无整包恢复路由。**结论：ST 无整包恢复能力**（→ R1.6）。
- [x] 0.4 用户审阅本规划并批准（2026-09-25：批准全程做完再报；实例授权「8003 写合成包 + 由我启 8001」；
      OQ-3 取「禁用单条目入口」）。

> 实例口径（R4.1）：**只对 Dev 8003/8001**；**Real 8004 默认不碰**；实测只用**合成小包**，
> 严禁真实聊天数据包（L0-1 / P-11 / L1-MR-14）。

## 1. R1 端点解析与凭证（提交 A，独立可回滚）

- [x] 1.1 `host-bridge.js`：加 `RESTORE_ENDPOINT_CANDIDATES`（`luker` / `st` 两序）与
      `postRestoreWithFallback()`；**仅 `404`/`405` 回退**，其余失败原样交回既有三态处理（design §1.1 / R1.4）。
- [x] 1.2 会话内命中缓存 `restoreEndpointHit`（不持久化、不写 IndexedDB）。
- [x] 1.3 全候选失败 → 抛错并附「已试端点 + 状态码」。
- [x] 1.4 凭证：`getCsrfToken()` 加 `getRequestHeaders()` 官方优先路径（design §2.2，纯增强）；
      `getHandle()` **不改行为**，仅补注释说明「`/api/users/me` 是句柄唯一权威来源、
      `name1` 是人设名禁止使用」（取证已定案）。
- [x] 1.4b **R1.6 能力缺失分支**：全候选 404/405 ⇒ 会话内 `restoreCapability='unsupported'`
      （不持久化），恢复入口禁用 + 原因文案「本宿主未提供整包恢复接口…请用宿主原生方式导入」，
      且**不再重复探测**；错误文案不得写「恢复失败」，更不得报成功（design §1.2）。
- [x] 1.5 `restoreToHost` 对外签名与返回契约**一字不改**（design §1.2）。
- [x] 1.6 单测扩 `test/restore-chain.test.js`：404→命中第二候选、**500 不重试**、缓存命中、
      凭证优先/回退（mock fetch）。
- [x] 1.7 `npx vitest run test/restore-chain.test.js` 全绿 + `npm test` 全绿 + 四条守卫退出码 0。
- [x] 1.8 提交 A（实际信息：`feat(host): 恢复端点按平台解析 + 无恢复能力时诚实降级`，`b6d8919`）→
      已推送 origin（L0-7）。
- [x] 1.9 **追加（取证驱动，原清单外）**：payload 恒传 `selection` 全类目（显式化语义）；
      新增 `nothingRestored` 诚实守卫（`200` 且有 skip 但 `restoredCount=0` 不得报成功）；
      单测 +2。见 PRD AC 与 `research/host-endpoint-facts.md` §5。

**回滚点 A**：若端点解析引发回归 → `git revert <提交 A>`，恢复硬编码端点，其余不受影响。

## 2. R2 批量恢复编排（提交 B）

- [x] 2.1 新增 `src/core/restore-batch.js`：纯状态机（design §3.1/§3.2）——`queued/running/
      item-done/item-failed/done/partial-failed/aborted`，`retryFailed()` 不重跑成功项，
      失败不中断整批，`abort()` 保留已完成记录。**不得**出现 DOM / `fetch` / 宿主判断。
- [x] 2.2 新增 `test/restore-batch.test.js`（Node 直测，无需 jsdom）：逐项推进、失败不中断、
      重跑只跑失败项、abort 记录保留、收尾态判定（全成功 vs 部分失败）。**实得 10 例**，
      另含「未确认项不被重跑」「快照不可篡改」「start 幂等」。
- [x] 2.3 `export-queue.js`：把「已选 N 项 → 写回宿主」从 `const first = [...selected][0]`
      **改为整批提交**（R2.1，修掉静默部分执行）；`render()` 加**可选** `restoreBatch` 参数，
      缺省时行为与今天完全一致（R2.9）。
- [x] 2.4 `index.js`：新增 `runBatchRestore(items, mode)` —— 开批前**一次**模态选模式（R2.3）、
      驱动状态机、逐项结果回写 UI、收尾渲染**「刷新页面生效」按钮**（仅点击才 `location.reload()`，R2.5）。
- [x] 2.4b **对话框合规**（`host-capabilities.md` §Host Native Dialog Adapter，design §4）：
      沿用既有恢复模态（不新增自绘浮层、不迁移到原生 Popup）；取消/确认走既有
      `confirmFn` DI 接缝注入 `confirmDialog`；未裸用 `confirm()`、未硬编码 `POPUP_RESULT`。
- [x] 2.5 文案核对：进行中含「部分数据已生效」；批量收尾文案**不得**出现
      `合并完成`/`已合并`/`全部合并`（design §5）。`grep -n` 复核结果见 PRD AC 该条的证据。
- [x] 2.6 互斥与取消复用既有机制：批次期间 `restoreInFlight` 为真 → 全部写回入口禁用；
      取消提示「宿主可能已收到部分数据」（R2.6，OQ-3 取禁用为默认）。
- [x] 2.7 `npm test` 全绿（**44 文件 / 406 passed / 2 skipped**，基线 42/386/2 零回退）
      + 四条守卫 0 + `npm run build` 通过。
- [x] 2.8 提交 B（实际信息：`feat(restore): 批量恢复编排，修掉「已选 N 项只恢复第一项」的静默部分执行`，
      `48c9e8a`）→ 已推送 origin。

**回滚点 B**：若批量不稳定 → **不回滚到「只恢复第一项」**（那是缺陷本身）；最小可用回滚形态是
「N 项逐个走既有单条路径、模态逐个确认」（design §5）。

## 3. R3 spec 更正（提交 B 内或紧随其后）

- [x] 3.1 `tavern-datapack-formats.md`：删除/更正「Luker 下隐藏恢复按钮」错误陈述，
      替换为「按钮在 Luker 下**可达**（`computeActionAvailability()` 无平台项）」。
- [x] 3.2 把 `/api/users/me` 的 404 结论**限定到匿名探测上下文**，并记录认证态 200 的证据
      （两宿主实测）——禁止后续 agent 直接引用旧结论。
- [x] 3.3 追加「恢复端点解析」条文：候选序、**404-only 回退**、会话缓存、非 404 禁重试（自包含 + file:line）。
- [x] 3.4 追加（超出原范围、取证驱动）：「宿主恢复端点矩阵 + 空体 POST 判定法 + 对照实验」、
      「payload 两个坑」、「类目目录名 ≠ 类目名（lorebook 在 `worlds/`）」、
      「实例 pull 后必须重启」；提交 `4f54048`。

## 4. 实例验收（Dev only）

- [x] 4.1 Dev Luker 8003 认证态：恢复实际命中 `/api/users/restore-backup` 且**写入成功**，
      记录请求端点与响应 `restoredCount`。
      **证据**：`research/pw-restore-variants.json`（`restoredCount: 1`，三条请求均为 `restore-backup`）、
      `research/dev-restore-smoke.json`（首轮）。
- [ ] 4.2 自造 2–3 个**合成小包**，多选一次发起批量恢复：逐项状态可见、模式统一、顺序符合列表顺序。
      —— **未做（残留 R-2）**：用户裁决「先收口当前任务」；UI 层正待修复，实机批量留待修复后重验。
      （合成包已造好：`probe-a/b.zip`，均为 `worlds/` 路径 + manifest，无真实数据。）
- [ ] 4.3 失败项重跑实测 —— **未做（残留 R-2）**，同 4.2；语义已由 10 条单测覆盖。
- [ ] 4.4 收尾出现「刷新页面生效」按钮，点击才刷新 —— **未做（残留 R-2）**，同 4.2。
- [x] 4.5 复核未触碰 Real 8004、未使用真实数据包。
      **证据**：全部探针 `DEV_URL` 默认 `https://127.0.0.1:8003`；
      写入 Dev 的仅有合成 `worlds/zz-probe-a.json`（残留 R-3，待用户决定是否清除）。
      —— 附：本轮**按用户要求**重启过 8004（进程层操作，未涉数据）。

## 5. 收口（Trellis Phase 3）

- [x] 5.1 逐条回填 `prd.md` 的 AC（现场取证，未取证者保持未勾选并记入残留）。
- [x] 5.2 spec 更新齐备（`tavern-datapack-formats.md` 环境教训节）。
- [x] 5.3 `git status --short` 核对改动范围（L0-17：**不得**用 `git diff --stat`）。
- [ ] 5.4 提交 + 推送 origin；journal 记录；`task.py finish` → `task.py archive`。 ← 收口时执行
- [x] 5.5 残留登记：未决项已写入 `prd.md` §「残留」（R-1 ST 禁用态实机、R-2 批量实机、
      R-3 探针残留物、R-4 Authority 迁移声明与本任务无关），避免「已归档 = 已覆盖」的误读。
      另登记本任务**不做**的项：上传进度条 / NDJSON 进度流 / `/probe` 预检接线（见 PRD §Out of Scope）。

## 子代理纪律（若派发）

- 只准用**本平台自带**子代理功能；模型用**能力最低档**（本仓约定 `DeepSeek-V4-Flash[free]`，
  模型 ID `claude-haiku-4-5-20251001`），**禁止 Kimi K3**；**并发 ≤3**（免费端点 6 并发实测 502）。
- 派发提示词首行必须是 `Active task: .trellis/tasks/09-25-batch-restore-luker-endpoint`；
  任务自包含（检索范围、具体问题、期望输出）。
- **本环境已知**：`trellis-check` 子代理曾出现「0 工具调用即退出」；**出现一次即转主代理自核**，
  不反复重试（见项目记忆 `trellis-check-subagent-fails-here`）。
