# 技术设计 —— 六实例数据同源 + 插件功能全自动化验证

> 需求见 `prd.md`；证据见 `research/instance-inventory.md`、
> `research/host-import-export-contracts.md`、`research/prior-art-search.md`。
> 本文件只写**怎么做**，不重复需求。

---

## 0. 不变量（任何阶段都不得违反）

| 编号 | 不变量 | 违反后果 |
| --- | --- | --- |
| I-1 | **真源只读**：Real Luker 在本任务中只被「导出」，不被任何写入 | 唯一的同源基准被污染 |
| I-2 | **不删目标独有**：同步过程中不得删除目标实例独有的文件/目录 | 不可逆；违反 U-3 |
| I-3 | **只走宿主原生通道**：Luker→原生整包恢复；ST→原生导入 UI；PT→M21 导入；TT→其 `data-migration` | 违反 L0-1 精神；写入语义不可控 |
| I-4 | **E2E 绝不可连 Real 端口**：`8002`/`8004` 出现即抛错退出，无默认值、无回退 | L1-MF-10 红线：误连真实数据 |
| I-5 | **测试产物不入 `Instance/**`** | L1-MR-14 / skill 反模式表 |
| I-6 | **收尾恢复环境**：关闭**本次启动**的实例；取证时已在运行的 `8003`/`8004` **保持原样** | 误关用户既有环境；端口残留影响后续会话与 `P-11` 判别 |

---

## 1. 总体数据流

```
① 备份（原生导出，必须先于任何写入）——**范围仅 Real Luker**（U-9）
   [Real Luker :8004] ─POST /api/users/backup {handle}─► S0  backup-real-luker-<date>.zip   (~3.8G)
   （另对每个将被写入的目标做一次**只读清单快照** M-dev-luker / M-dev-st / M-real-st / M-pt）

② 产包（Node 侧，无浏览器；用本仓 convert()）
   S0 ──convert(target=…)──┬─► P-luker.zip  (排除 backups/)  (~1.3G)
                           ├─► P-st.zip     (排除 backups/)
                           └─► P-tt.zip     (排除 backups/)

③ 同步（每宿主只走其原生通道）
   P-luker ──POST /api/users/restore-backup  mode=merge──► Dev Luker :8003
                                                      └──► Real Luker :8004
   P-st    ──浏览器逐类目导入（原生 UI）──────────────────► Dev ST :8001
                                                      └──► Real ST :8002
   P-tt    ──PT M21 导入（merge 策略）──────────────────► PT web :8899
           ──TT data-migration 扩展（人工）──────────────► TT      （人工，U-5）

④ 验证（仅 Dev 白名单端口）
   e2e/run.cjs ──► 加载冒烟 + 功能矩阵（8001 / 8003 / 8899）
```

**为什么「② 产包」用 `convert()` 而不是找现成工具**：`research/prior-art-search.md` 的 GitHub
通道零命中；且用本仓的 `convert()` 意味着**同源同步本身就在行使被验证的功能**——这正是
「就是这个插件打包的内容」的字面实现。`convert()` 是纯逻辑 + `io` 注入接缝
（`src/core/transform.js:234`），可在 Node 侧直接跑，无需浏览器。

---

## 2. D1 同步通道选型（逐宿主的依据）

| 目标 | 通道 | 硬证据 |
| --- | --- | --- |
| Dev/Real **Luker** | `POST /api/users/restore-backup`，`mode=merge` | `Real/Luker/src/endpoints/users-private.js:1237`，`:1264` 默认 `merge`；`overwrite` 模式另有 snapshot 回滚（`:683`、`:718`、`:886`）。**`merge` 即 U-3 的「覆盖同名、不删独有」** |
| Dev/Real **ST** | 浏览器端逐类目导入（宿主原生 UI） | ST **无整包恢复端点** —— `src/ui/host-bridge.js:66`「ST 1.19.0：两者**均为 404** —— ST 不提供整包恢复能力」；可用类目端点为 `characters.js:1560` / `chats.js:771` / `chats.js:751` / `worldinfo.js:99` |
| **PT** web | M21 导入，冲突策略 `merge` | `apps/web/src/features/import-export/README.md`：冲突策略含 `merge`；**记录 id 由自然键派生并复用本地 id** ⇒ 重复导入即更新；导入前自动建恢复点 |
| **TT** | 产包 + 人工经其 `data-migration` 导入 | `Instance/Real/TauriTavern/docs/CurrentState/iOSPolicy.md:140` 的 `extensions.system_allowlist` 含 `"data-migration"`；TT 是 Tauri 应用、**无浏览器端口** |

### 2.1 为什么不用「文件级同步（robocopy 覆盖同名不删独有）」

那条路**语义上最容易对上 U-3**，但：

1. 它直接违反 L0-1 的字面规定（禁止向实例目录复制/写入/覆盖文件）；
2. 它**绕过宿主的目录语义**——Luker 会在恢复时按 `selection` 类目映射与别名规则处理条目
   （`docs/research/luker-extension-mechanics-and-git-prune.md` 的 `L_EXTENSION_ALIASES`），
   裸拷贝得到的目录状态与宿主恢复后的状态**不等价**，等于制造一个「看起来一样、宿主不认」的假同源；
3. PT 根本没有磁盘目录可拷。

故选原生通道。**这是一处对 L0-1 的显式偏离，已在 `prd.md` C-1 登记，须在 1.4 评审门获批。**

### 2.2 Luker 目标为什么还要先产包（而不是直接恢复 S0）

因为要**排除 `backups/`**（U-4），而 Luker 的原生 `selection` 是**类目级**的粗粒度
（`research/host-import-export-contracts.md` §1.2：`settings` 类目含 `backups/`），
裁不到「去掉 `backups/`、其余全要」。而 `convert()` 的 `includeBackups` **默认就是 `false`**
（`transform.js:234`）——正好是要的语义，且随手完成布局归一。

---

## 3. 组件分解与落点

### 3.1 落点决策（**可在 1.4 评审门否决**）

| 资产 | 落点 | 理由 |
| --- | --- | --- |
| E2E 运行器与用例 | 仓根 `e2e/` | 可重跑、进版本库、跨机器可用；这是 R3「可重跑基础设施」的唯一合格落点（任务目录被 `.gitignore` 排除，见 L0-17） |
| 同步驱动脚本 | 仓根 `scripts/instance-sync/` | 同上；且与既有 `scripts/*.js` 守卫同层，风格一致 |
| 同步/验证的**读数与数据** | 任务目录 `research/`、`deliverables/` | 体积与隐私（含真实数据路径）不宜入库 |
| 规范条文 | `.trellis/spec/` | L0-17：规范必须落 spec，且**自包含** |
| 数据包产物 | `C:\Users\caocaobi\Downloads\` | 用户指定；同时是 TT 的人工交付物 |

> **不进 `package.json` 的 `dependencies`**：本任务不引入任何运行时依赖。
> 仅新增一个 `scripts.e2e` 台账项指向已有的 Node 脚本（不是依赖变更）。

### 3.2 目录结构

```
e2e/
  lib/
    resolve-playwright.cjs   # 解析 playwright：先 require，再 npm root -g（沿用既有模式）
    guard.cjs                # 端口守卫（I-4 的唯一实现点）
    instances.cjs            # 实例登记表：id → {dir, port, url, profile, startCmd}
    harness.cjs              # 持久化上下文 + 报错/请求采集 + 本插件归因过滤
  specs/
    guard.spec.cjs           # 负例：喂 8002/8004 必抛错（先证明判定会抓）
    smoke.spec.cjs           # 加载冒烟（参数化实例）
    matrix.spec.cjs          # 功能矩阵（仅 Dev Luker / Dev ST）
  run.cjs                    # 运行器：串行跑 spec、汇总、失败非零退出
scripts/instance-sync/
  export-backups.cjs         # ① 原生导出 → Downloads + 尺寸/条目数/sha256 记录
  build-packs.cjs            # ② convert() 产包（Node 侧）
  restore-luker.cjs          # ③ Luker 目标：restore-backup mode=merge
  import-st.cjs              # ③ ST 目标：浏览器逐类目导入
  import-pt.cjs              # ③ PT 目标：M21 导入（merge）
  diff-report.cjs            # ④ 差异核对：源覆盖率 / 目标独有零删除
  start-instance.cjs / stop-instance.cjs   # 实例生命周期
```

### 3.3 端口守卫契约（I-4 的唯一实现点）

```js
// e2e/lib/guard.cjs
const DEV_PORTS = new Set(['8001', '8003', '8899']);   // Dev ST / Dev Luker / PT web
const REAL_PORTS = new Set(['8002', '8004']);          // Real ST / Real Luker —— 出现即拒绝

function assertDevTarget(rawUrl) {
  if (!rawUrl || !String(rawUrl).trim()) {
    throw new Error('目标 URL 未提供：拒绝静默兜底（tavern-browser-automation / L1-MF-10）');
  }
  const u = new URL(rawUrl);
  if (REAL_PORTS.has(u.port)) {
    throw new Error(`拒绝启动：端口 ${u.port} 是 Real 实例端口，疑似误连真实数据（L1-MF-10 红线）`);
  }
  if (!DEV_PORTS.has(u.port)) {
    throw new Error(`拒绝启动：端口 ${u.port} 不在 Dev 白名单 ${[...DEV_PORTS].join('/')}`);
  }
  return u;
}
module.exports = { assertDevTarget, DEV_PORTS, REAL_PORTS };
```

三条配套约束（照抄 skill）：**启动时断言、失败即非零退出**；**环境变量无默认值**
（禁止 `?? 'http://127.0.0.1:8001'` 这类兜底）；**禁止因端口被占而自动改写目标**。

### 3.4 功能矩阵的断言面（对应 R3.3 九条路径）

| # | 路径 | 断言要点 | 可达性 |
| --- | --- | --- | --- |
| M-1 | 宿主检测 | 返回的平台码与实例匹配；`hostLayoutCode()` 归一正确（`luker→l`） | UI 可见 |
| M-2 | 工作台注入 | 注入点存在且幂等（重复渲染不产生重复节点，`dataset.stZipInjected`） | UI 可见 |
| M-3 | 计划预览 | 给定源包产出计划项，类目/计数与 `dryRun` 读数一致 | UI 可见 |
| M-4 | 转换 | 四目标分支（`st`/`l`/`tt`/`pt`）各产出一份产物；PT-native 输入按设计抛错 | UI 可见 |
| M-5 | 导出队列 | 产物**不自动下载**；条目入待导出区 | UI 可见 |
| M-6 | 待导出区落库 | 下载/存工作区时才入 IndexedDB，`origin` 字段正确 | UI 可见 |
| M-7 | 断点续传 | pause → resume 后 `resumedCount > 0`；**terminate 后引用被重置**（P-6/L1-MR-8） | UI 可见 |
| M-8 | 批量恢复 | 宿主恢复能力探测（`restoreCapability` 三态）与实际端点一致 | UI 可见 |
| M-9 | 分割 | 分割产物分片完整、可重组 | UI 可见 |

**不允许**用「一次性 MCP 会话」代替上述任一条（skill 反模式表）。

---

## 4. 备份通道设计（R1）

### 4.1 两条导出路径，取稳者（OQ-2）

| 路径 | 做法 | 适用 |
| --- | --- | --- |
| **(a) 原生 UI + Playwright download** | 登录后点宿主「导出/备份」按钮，`page.waitForEvent('download')` → `download.saveAs(path)` | 首选：最贴近原生 |
| **(b) 会话内 `fetch` 流式** | 从页面取 cookie + CSRF，Node `fetch` 流式 → `fs.createWriteStream` | 大包首选：不经过浏览器内存 |

**选型规则**：先对 **Real ST（30 M）**用 (a) 验证通路，再对 **Real Luker（3.8 G）**用 (b)；
两条都实测，把读数（耗时、是否 OOM、文件大小是否与源目录量级相符）写进 `research/`。

`/api/users/backup` 契约与门禁见 `research/host-import-export-contracts.md` §1.1、§3.1；
注意 `handle` 须等于当前登录用户，且 ST 侧受 `backups.allowFullDataBackup` 门禁（默认 true）。

### 4.2 会话档案隔离

- Dev 目标 → `.pw-profile-dev`（**已存在**，含 8003 登录态）
- Real 目标 → `.pw-profile`（**已存在**）
- 两者**不得混用**；分析型操作一律走 Dev 档案。
- `.gitignore` 的 `.pw-profile*/` 已覆盖两者，无需改动。

### 4.3 备份记录（AC-1 的证据形态）

每个备份产出同目录一个 `.json` 记录：`{ instance, sourceDir, file, bytes, entryCount, sha256, exportedAt }`。
`entryCount` 与 `sha256` 由 `zip-io.js` 读包统计（复用 `convert(..., { dryRun: true })` 的读包路径）。

---

## 5. 同步设计（R2）

### 5.1 Luker 目标

```
POST /api/users/restore-backup        (multipart: file=P-luker.zip, handle, mode=merge, selection={…全 true…})
```
- `selection` **必须至少有一个类目为 true**，否则 400（`users-private.js:1266`）。
- 建议先打 `/restore-backup/probe`（`:1197`）预检，拿到 `targetableEntries` 再真恢复。
- **必须用 `merge`**；`overwrite` 会清目标同名数据（与 U-3 冲突）。
- 大包要开流式进度（`wantsRestoreProgressStream`），否则 3.8 G 级请求可能超时。

### 5.2 ST 目标

ST 无整包恢复 ⇒ 浏览器端逐类目导入。**OQ-1 未决**：ST 1.19.0 的「导入用户数据」确切 UI 路径与
端点序列尚无实测记录。阶段 2 的**第一件事**是实地探明并写进 `research/`，然后才写用例。
若 ST 原生导入只支持逐类目手动选择而无法自动化，则**如实降级**为「产出 ST 布局包 + 手工程序说明」，
并在 PRD 残留登记——**不得**因为要凑「全自动」而改用裸文件拷贝（违反 I-3）。

### 5.3 PT 目标

源用 `P-tt.zip`（TT 布局树），交 PT 的 M21 导入：
- 先跑 **dry-run 预览**，核对「新增/冲突/不可用模块」计数；
- 再以 **`merge`** 策略执行（对应 U-3）；
- PT 会在导入前自动建**恢复点**，这是本目标的回滚手段；
- PT 的记录 id 由自然键派生 ⇒ **重复导入是更新不是新增**，可直接用作「同源」的重复验证。

### 5.4 TT 目标（人工）

交付物 = `P-tt.zip` + `TT-导入说明.md`（同放 Downloads）。说明须含：TT 内如何打开 `data-migration`、
data root 当前指向何处（`docs/CurrentState/DataDirectorySelection.md` 的引导配置）、导入后如何核对。

### 5.5 差异核对（AC-2 / AC-3）——「覆盖同名不删独有」的可复核证据

`diff-report.cjs` 对每个目标产出三张表：

| 表 | 断言 |
| --- | --- |
| **源覆盖率** | 源（排除 `backups/`）的每个条目在目标存在 → 必须 100% |
| **目标独有存活** | 同步前登记的目标独有条目，同步后**仍在** → 零删除 |
| **内容量** | 角色卡 430 / 聊天 1029 等在目标侧可核对到（ST 侧按 ST 类目形态折算） |

**先跑一次「空转对照」**：不写入、只算差异，确认三张表在同步前能正确报出「目标缺什么」——
**先证明判定会报差异，再相信它报 100%**（沿用本仓 `09-25` 任务「负例自检」的做法）。

---

## 6. 回滚设计（L0-6 要求）——**能力不对称，须如实声明**

> **U-9 的后果**：备份只做了 Real Luker。下表第二列「回滚手段」对 Dev Luker / Dev ST / Real ST
> **只有取证能力，没有回滚能力**。这不是设计缺陷，是用户知情下的风险接受（`prd.md` R1 的 U-9 框）。

| 目标 | 回滚手段 | 验证方式 |
| --- | --- | --- |
| **Real Luker** | ✅ **真回滚**：用 S0 走 `restore-backup` + **`mode=overwrite`**（该模式自带 snapshot 回滚，`users-private.js:683-718`） | 回滚后跑 `diff-report` 对照 S0 |
| Dev Luker | ⚠️ **仅取证**：对比 `pre-sync-manifest-dev-luker.json`，精确报出被覆盖的路径；**内容不可恢复** | 报出改动清单，人工判断可否接受 |
| Dev ST / Real ST | ⚠️ **仅取证**：同上（两处仅 29 张角色卡 / 0 条聊天，损失面小） | 同上 |
| PT | ✅ M21 **导入前自动恢复点** | 用 PT 面板的恢复点还原 |
| TT | 未被写入（人工步骤，本轮不执行） | — |

**「不删独有」是本设计对这三处最主要的保护**：Luker 侧 `mode=merge` 与 PT 侧 `merge` 策略
都只覆盖同名条目，因此**损失面上限 = 与源同名的文件**，目标独有的内容不会被删。
R1.4 的清单快照让「被覆盖了什么」变成可复核读数，而不是不可知。

**回滚/停止的触发条件**：任一 AC-2 断言失败（源覆盖率 <100%，或**出现目标独有文件被删**），
**立即停止后续目标**，并对已完成目标按上表处置，不得「先全部跑完再看」。

---

## 7. 风险与对策

| # | 风险 | 概率 | 对策 |
| --- | --- | --- | --- |
| K-1 | 3.8 G 级备份导出超时/OOM | 中 | 走 (b) 流式；先在 30 M 的 Real ST 上验证通路（§4.1） |
| K-2 | ST 逐类目导入无法自动化（OQ-1） | **中高** | 如实降级为「产包 + 手工说明」+ 残留登记，**不拿裸拷贝凑数** |
| K-3 | Luker `restore-backup` 对 1.3 G 包耗时过长或超时 | 中 | 开流式进度；先 `probe` 预检；必要时按类目分批恢复（每次仍 `merge`） |
| K-4 | 同步覆盖面理解偏差导致误删目标独有 | 低 | `merge` 语义 + `diff-report` 的「目标独有存活」表 + 空转对照 |
| K-5 | 实例启动后端口冲突/被占用 | 低 | 四实例端口已在各自 `config.yaml` 登记（8001-8004），PT 8899 `strictPort`；**禁止 8000**（L0-16） |
| K-6 | E2E 把真实数据内容写进日志/trace 并入库 | 中 | 产物落 `test-results/`（gitignore）；提交前按 L1-MR-14 脱敏；`.pw-profile*` 不入库 |
| K-7 | 全局 Playwright 升级导致脚本静默失效 | 低 | 运行器**版本断言**：非 `1.62.1` 时打印告警并按 skill 禁止升级 |

---

## 8. 与既有规范的兼容性

| 规范 | 本设计如何满足 |
| --- | --- |
| L0-11 / L1-MR-1（纯前端优先、后端可降级） | 本任务不改产品主路径，只加测试与运维脚本；`convert()` 的纯逻辑性未被破坏 |
| L1-MR-11（不引入构建步骤） | 新增能力全部是 Node 脚本与 E2E 目录，`vite build` 产物不变 |
| L1-MR-13（`npm test` 全绿） | E2E **不进** `npm test`（vitest）的用例集；新增单测只覆盖 `guard.cjs` 等纯逻辑 |
| L0-17（交付物落点） | 规范落 `.trellis/spec/`；任务目录只作工作副本；范围门用 `git status --short` |
| P-17（不写本机路径） | `e2e/lib/instances.cjs` 与同步脚本一律**相对解析**（沿用 `.pw-verify-changes.cjs` 的 `path.resolve(__dirname, …)` 模式），可经环境变量覆盖 |
