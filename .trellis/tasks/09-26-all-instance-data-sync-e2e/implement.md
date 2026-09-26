# 执行计划 —— 六实例数据同源 + 插件功能全自动化验证

> 复选框**随执行实时勾选**（L0-2），禁止任务结束后凭记忆批量补勾。
> 每个阶段末有**回滚点**；任一断言失败即停并回滚，不得「先跑完再看」。

---

> ## ⚠️ 执行顺序改道（2026-09-26，用户裁决）
>
> 阶段 2 被产品缺陷 E 阻塞（A–D 已修并保留；E 成因待查）。
> 用户裁决：**转做不依赖产包的部分**。故实际执行顺序为
> **阶段 1 → 阶段 2（部分，挂起）→ 阶段 4 → 阶段 5.2（加载冒烟）→ 阶段 2.3（OQ-1 探路）→ 阶段 3（挂起）**。
> 阶段 3（同步）与 2.1/2.4（产包）在 E 解决前不执行，残留已登记。
>
> ### ✅ E 已定性并解锁阶段 2 的产包（2026-09-26 第二轮，本文件 2.4 已勾选）
>
> **E 不是死锁，是内存峰值超 Node 默认堆上限的 OOM。**
> 实测默认堆上限 **4288 MB**；转换的峰值需求超过它 ⇒ `FATAL ERROR: Ineffective mark-compacts near heap limit`。
> 关键对照（**worker 数不是主因**）：伪造 `hardwareConcurrency` 为 20/4/2 三档，
> 低 worker **反而更早 OOM**，且三者前 15 s 读数**逐字相同**（投递节奏由源读取决定）。
> 改用 8 GB 堆：**213.5 s 完整跑通 / 619.3 MB / 7748 条 / 零条目丢失**，最终 `heapUsed` 仅 142 MB
> ⇒ **非泄漏**（泄漏不会在结束前回落）。
> 完整证据（含三个诊断脚本）见 `research/build-packs-blocker.md` 的「缺陷 E 根因」。
>
> ⇒ **2.1 / 2.4 已可执行且已完成**；三个产包已落 Downloads（见 2.4 读数表）。
> **仍待用户裁决**：① 阶段 3（同步）是否推进（U-12 约定「读数回报后再定」）；
> ② 缺陷 E 的**产品侧修复**是否本轮做（属改产品代码，需批准）。
>
> **本轮质量门复验**：`npm run e2e` = **断言 53 / 通过 53 / 失败 0（exit 0）**；
> `npm test` = 45 passed / 1 skipped（46 文件）、429 passed / 2 skipped（**零回退**）；
> 五条静态守卫全 `exit=0`；`npm run build` ✓ 774 ms。**`src/**` 未改动**。
> 收尾只停了本次启动的 `:8001`；`:8003` 在 e2e 期间由外部启动（非本次），
> e2e 结束后自行不再监听，**未对其执行任何停止操作**。

## 阶段 0 · 评审门（`task.py start` 之前）

- [x] **0.1** 向用户请批三项**扩大/偏离**（本文件末尾「请批清单」），获准后才 `start` ——
      **2026-09-26 已裁决**：A-1 批准、A-2 否决（只备份 Real Luker）、A-3 批准、U-12 先跑阶段 1-2。

```bash
python ./.trellis/scripts/task.py start
```

- [x] **0.2** 回填 `implement.jsonl` / `check.jsonl`（各 8 / 6 条真实条目，已去 `_example`）。

**回滚点**：未获批则本阶段即终止，任务停留在 `planning`。

---

## 阶段 1 · 备份先行（R1 → AC-1 / AC-1b）

> 前置：用户已授权启动实例（U-6）。**本阶段结束前不得对任何实例做写入**。
> **备份范围仅 Real Luker**（U-9）——其余目标只做只读清单快照，无回滚能力（见 `design.md` §6）。

- [x] **1.1** 写 `e2e/lib/instances.cjs` 登记表（id → `{dir, port, url, profile, startCmd, stopCmd}`），
      目录**相对解析**、端口写死登记值（8001/8002/8003/8004/8899）。
      **实测**：`INSTANCES_ROOT` 解析为 `D:\Repo\Tavern-repo\Instance`，五个实例目录与四个
      `userDir` 全部 `[OK]`；`pt-web` 的 `userDir` 按设计为 `n/a`（纯前端 Profile 存储）。
      **踩坑**：首版 JSDoc 里写了 `` `.pw-profile*/` ``，其中的 `*/` **提前闭合了块注释**，
      导致后续反引号把整个文件拖进模板串 —— `node --check` 报在 104 行，真凶在第 30 行。
      二分定位后改正（注释内不得出现 `*/`）。
- [x] **1.2** 写 `scripts/instance-sync/start-instance.cjs`，支持 `--id`，启动后**轮询端口就绪**
      （有界等待，L1-MR-7），就绪超时即失败；端口已在监听则**幂等跳过**，不重复拉起。
- [x] **1.3** 启动 **Real Luker :8004**：

```bash
node scripts/instance-sync/start-instance.cjs --id real-luker
```

      校验：`curl -sk https://127.0.0.1:8004/ -o /dev/null -w '%{http_code}'` 得 200/302。
      **禁止**任何脚本绑定或请求 8000（L0-16）。
      **实测结果**：:8004 **已在监听**（HTTP 200，pid 29452），启动器幂等跳过。
      **并更正一处取证错误**：首版用 `grep -c "LISTENING.*:$p "` 判端口，正则顺序写反导致
      **永远匹配 0**，误得「四端口全部未监听」。更正后：**8003（Dev Luker, pid 76784）与
      8004（Real Luker, pid 29452）本来就在运行**，只有 8001/8002/8899 未监听。
      端口归属经探针决定性确认（`:8003` 上 `third-party/st-authority-sdk` 返回 200、
      `:8004` 返回 404）⇒ 与登记表一致，**未发生误连**。详见 `research/instance-inventory.md` §6。
      ⚠️ 后续收尾**只关本次启动的实例**，8003/8004 保持原样（AC-11）。
- [x] **1.4** **备份通路试跑**（**不下载全量**）：对 Real Luker 发一次 `POST /api/users/backup`，
      读到**响应头 + 首块**即中止，确认 `200`、`content-type: application/zip`（或等价）、
      响应体确为 zip 头（`PK\x03\x04`）。读数落 `research/backup-channel-probe.md`。
      **不在其他实例上试跑**（备份范围仅 Real Luker，不为试跑触碰别处）。
      **实测**：`200` + `content-type: application/zip` + 首 4 字节 `50 4b 03 04`；
      **关键副作用发现：`transfer-encoding: chunked`、无 `content-length`** ⇒ 必须真流式，
      且否掉了「Playwright download 事件」与「整包进内存」两条路。
- [x] **1.5** 写 `scripts/instance-sync/export-backups.cjs`，按 1.4 验证的通路实现；
      **3.8 G 必须走流式**（会话内 `fetch` → `fs.createWriteStream`，不经过浏览器内存，K-1）；
      产出包与同名 `.json` 记录（`{instance, sourceDir, file, bytes, entryCount, sha256, exportedAt}`）落 Downloads。
      实现取舍：浏览器只用于**取会话**（cookie + `/csrf-token`），字节改由 **Node 侧 `https.request` 流式**直写磁盘。
- [x] **1.6** 全量导出 S0。导出期间对源目录**只读**（I-1）；记录耗时与峰值内存。
      **实测**：1602.7 MB（压缩后）/ **3840.6 MB 未压缩** / 8683 条目 / **247.1 s**。
      记录到 `Downloads/backup-real-luker-20260926-010422.json`。
      **实测现象**：进入 `backups/` 后速率从 ≈7 MB/s 塌到 ≈0.9 MB/s（对已 deflate 的 111 个历史包再压一次，
      是 K-1 的实测形态）。详见 `research/backup-export-readings.md`。
- [x] **1.7** 校验备份：`sha256` 可重算、`entryCount > 0`、未压缩量级 ≈3.8 G。
      **实测**：`inspect-pack.cjs` 读出未压缩总计 **3840.6 MB**，与源目录量级一致；
      一级构成逐项对得上（`chats/` 1029 条 / `characters/` 430 条 / `backups/` 111 条 2479.5 MB …）
      ⇒ **AC-1 达成**（记录 `research/backup-export-readings.md`）。
- [x] **1.8** 写 `scripts/instance-sync/snapshot-manifest.cjs`，对**四个将被写入的目标**
      （Dev Luker / Dev ST / Real ST / PT web）各做一次**只读**清单快照。
      **实测**：`dev-st` 196 文件 / 15.4 MB；`dev-luker` 3238 / 1037.6 MB；
      `real-st` 195 / 15.4 MB；`real-luker` 7986 / 3731.3 MB（各 <3 s）。
      `pt-web` 按设计跳过（纯前端 Profile，无磁盘目录）。
- [x] **1.9** 快照必须**在阶段 3 的任何写入之前**完成 —— 已完成（阶段 3 尚未开始）。
      四份快照与「目标独有清单」的条目数汇总见 `research/pre-sync-manifest-*.json`。

**回滚点**：本阶段只读（唯一写动作是往 Downloads 落产物）。失败即修脚本重跑，
**不得跳过备份进入阶段 3**。

---

## 阶段 2 · 产包 + ST 导入路径探明（R2 前置）

> **经用户批准（2026-09-26）修复了产品缺陷以解开阻塞** —— 这是对 `prd.md` Out of Scope
> 「缺陷只登记、当轮不修」的一次**显式偏离**，由用户当面裁决「修产品代码（推荐）」。
> 完整诊断见 `research/build-packs-blocker.md`。

- [x] **2.0** 空转算账（`--dry-only`）**已完成**，三个目标的读数都正常：
      `[l]` copied=7748 / dropped=934；`[st]` copied=7748 / dropped=935；`[tt]` copied=7747 / dropped=936。
      丢弃项**全部对得上**：823 条 `.git` 内部冗余（产品安全清洗，`gitMode=KEEP` 仍保留 essentials）
      + 111 条 `backups/`（**正是 U-4**）+ 1 条源 `manifest.json`（按目标重合成）。
      读数落 `research/pack-build-readings.json`。

- [x] **2.0a（新增·经批准）修复 `src/core/zip-io.js` 两处缺陷**：
      - **`openStream`（原 :121）**：`readable.cancel(err)` 改为「已锁则不 cancel」并吞掉 cancel 自身失败。
        原写法在消费方已 `pipeTo` 锁定时抛 `ERR_INVALID_STATE`，**升级为未处理拒绝杀死 Node 进程**
        且**掩盖真正的主错误**。
      - **`createWriter`（原 :145）**：`bufferedWrite` 由硬编码 `true` 改为**默认 `false`、可显式覆盖**。
        实测该标志在真源包规模下使落点**恒为 0 字节、`close()` 永不返回**（RSS 1.0–1.5 GB）；
        改 `false` 后 **82.4 s 完成 614 MB、RSS ~330 MB**。
      **证据**：同源包/同 8572 条/同落点的对照实验（`research/build-packs-blocker.md` §根因）。
      **回退基线**：`npm test` **45 passed / 1 skipped（46 文件）、429 passed / 2 skipped** —— 与基线逐项一致，**零回退**。
      **未为它新增单测，且这是有意的**：实测证明该缺陷**无法被快速单测守护** ——
      单条目 4 MiB 时 `bufferedWrite` 真假**都**边写边落盘；4000 条 × 4 KB 两种模式也都 0.8 s 正常；
      唯一触发维度是**总字节**（1.3 GB 级），注定进不了 `npm test`。
      故把可执行守护放进 **`node scripts/instance-sync/selftest-node-zip-io.cjs --large <zip>`**
      （判据：落点字节在有界时间内持续增长，连续 90 s 零增长即判失败）。
      **不留「看着像守护、其实无论怎样都通过」的测试**（首版写过一版，经实测确认无判别力后已删除）。

- [x] **2.1** 写 `scripts/instance-sync/build-packs.cjs`，对 S0 调 `convert()`（Node 侧）产出
      `P-luker.zip` / `P-st.zip` / `P-tt.zip`，三份均 `includeBackups: false`；
      并加 `.partial` 保护（先写 `.partial`，成功后再改名 —— 首轮实跑留下的 8.6 MB 坏包即因缺此保护，
      **该残件已按用户裁决删除**）。
- [x] **2.2** **先 `dryRun: true` 空转**，核对计划读数 —— ✅ 已完成（见 2.0）。
- [x] **2.3** **探明 ST 导入路径（OQ-1）** —— 结论落 `research/st-import-path.md`。
      **答案推翻了设计的一条假设**：ST 1.19.0 **没有整包导入、也没有整合的导入 UI** ——
      `users-private.js` 只有 `/backup`（无任何 import/restore 路由），
      `public/scripts/user.js` 只实现 `backupUserData`。
      可用的只有**逐类目端点**（characters / chats / worldinfo / settings.save / backgrounds.upload），
      且有四条硬约束（顺序强制、settings 整份替换与 U-3 冲突、预设主题无通道、
      约 1500 次调用）。⇒ **AC-2 的「源覆盖率 100%」在 ST 目标上不可达**，
      `design.md` §5.2 已按此更正。**这是阶段 3 的第二个独立阻塞。**
- [x] **2.4** 校验三份产包：`target` 布局正确（ST 摊平 / TT `data/` 根）、
      `backups/` 零条目、角色卡与聊天计数与源一致。**2026-09-26 已完成**（缺陷 E 定性后解锁）：
      新增 `scripts/instance-sync/verify-packs.cjs`（断言 A1 包存在且 >100 MB / A2 `backups/` 零条目 /
      A3 `characters/`=430、`chats/`=1029 / A4 布局前缀）。**实测读数**：

      | 包 | 体积 | 条目 | 未压缩 | A2 | A3 | A4 |
      | --- | --- | --- | --- | --- | --- | --- |
      | `pack-luker-20260926-010422.zip` | 619.3 MB | 7750 | 1299.7 MB | `backups/`=0 ✅ | 430 / 1029 ✅ | 无 `data/` 前缀 ✅ |
      | `pack-st-…zip` | 619.3 MB | 7751 | 1299.7 MB | 0 ✅ | 430 / 1029 ✅ | 无 `data/` 前缀 ✅ |
      | `pack-tt-…zip` | 619.6 MB | 7779 | 1299.7 MB | 0 ✅ | 430 / 1029 ✅ | 7779/7779 落于 `data/` ✅ |

      **正负例双向验证**（先证明判定能抓到违规）：拿**源包**当输入跑负例 ——
      `--kind luker` 时 A2 正确抓出 `backups/` 111 条并**退出码 1**；
      `--kind tt` 时 A4 正确抓出 `0/8683 落于 data/` 并退出码 1。
      **过程中修掉校验器自身两处缺陷**：① 把布尔 `isTT` 当字符串前缀传给 `startsWith`（永不匹配，
      误报 TT 布局全错）；② A4 断言本身写错 —— TT 目标的条目**并非全部**带 `data/default-user/`，
      `data/extensions/third-party/` 与 `data/_tauritavern/` 同样合规（`transform.js:103-111`），
      正确判据是「全部落在 `data/` 数据根之下」。
      **同时暴露并修掉一个工具缺陷**：`build-packs.cjs` 默认堆（实测上限 **4288 MB**）直接 OOM，
      已加**堆自举**（检测上限不足即以 `--max-old-space-size=8192` 重新拉起自身，环境变量防重入）。

**回滚点**：产包在 Downloads，未触碰任何实例；失败即重跑。

---

## 阶段 3 · 同步（R2 → AC-2 / AC-3 / AC-4）

> 顺序：**先 Dev，后 Real**；每完成一处就跑一次核对，**不通过就不进入下一处**。

- [ ] **3.1** 写 `scripts/instance-sync/diff-report.cjs`（三张表：源覆盖率 / 目标独有存活 / 内容量）。
- [ ] **3.2** **空转对照**：不写入，只算差异，确认三张表能正确报出「目标缺什么」
      —— **先证明判定会报差异，再相信它报 100%**。读数落 `research/diff-selfcheck.md`。
- [ ] **3.3** `restore-luker.cjs` 同步 **Dev Luker :8003**：先 `/restore-backup/probe` 预检，
      再 `mode=merge` + 全类目 `selection`，开流式进度。
- [ ] **3.4** 对 Dev Luker 跑 `diff-report.cjs` → **AC-2 断言必须过**（覆盖率 100% / 独有零删除）。
- [ ] **3.5** `import-st.cjs` 同步 **Dev ST :8001**（按 2.3 的路径）。
- [ ] **3.6** 对 Dev ST 跑 `diff-report.cjs` → AC-2 过。
- [ ] **3.7** 同步 **Real Luker :8004**（同 3.3）→ `diff-report` → AC-2 过。
- [ ] **3.8** 同步 **Real ST :8002**（同 3.5）→ `diff-report` → AC-2 过。
- [ ] **3.9** `import-pt.cjs` 同步 **PT web :8899**：先 dry-run 预览核对计数，再 `merge` 执行；
      对 PT 跑 `diff-report` → AC-2 过。
- [ ] **3.10** **AC-3 内容断言**：四处 + PT 上核对角色卡 430 / 聊天 1029（ST 侧按 ST 类目折算）。
- [ ] **3.11** **AC-4 交付物**：确认 `P-st.zip` / `P-tt.zip` / `P-luker.zip` 在 Downloads；
      写 `TT-导入说明.md`（含 data root 决议方式与核对步骤）同放 Downloads。

**回滚点**：任一处 AC-2 失败 → 立即**停止后续目标**，按 `design.md` §6 处置已完成目标。
⚠️ **回滚能力不对称**（U-9）：只有 **Real Luker** 有真回滚（S0 + `mode=overwrite`）；
Dev Luker / Dev ST / Real ST **只有取证**（对比 `pre-sync-manifest-*.json` 报出改动路径，内容不可恢复）；
PT 用 M21 导入前自动恢复点。**因此阶段 3 每写一处都必须先跑一次 AC-2 核对再前进。**

---

## 阶段 4 · E2E 基础设施（R3 → AC-5 / AC-8）

- [x] **4.1** 写 `e2e/lib/resolve-playwright.cjs`（先 `require('playwright')`，失败再 `npm root -g`）
      —— **不新装包**，实测解析到全局 `playwright@1.62.1`；附版本漂移告警（不抛错，避免他机无谓失效）。
- [x] **4.2** 写 `e2e/lib/guard.cjs`（契约见 `design.md` §3.3）。
- [x] **4.3** 写 `e2e/specs/guard.spec.cjs` **负例用例**。**实测 17/17 全过**，含：
      Real `:8002`/`:8004` 被拒**且错误信息点名 Real**（先于「不在白名单」）、
      空/undefined/空白被拒（无静默兜底）、未写端口被拒、`8000` 被拒（L0-16）、
      非白名单 `5173` 被拒、不可解析被拒、三个 Dev 端口放行；
      **以及一条集成断言**：`openInstance()` 对 Real 端口**在启动浏览器之前**就抛错
      —— 证明守卫真的接在自动化路径上，而不是「写了个函数没人用」。
- [x] **4.4** 写 `e2e/lib/harness.cjs`：持久化上下文、控制台/页面错误/失败请求采集，
      并把读数分成**两栏**：整页背景（30 个第三方扩展的噪音，**不参与判定**）与
      **本插件归因**（URL/位置/堆栈含插件 slug 的才算，**判定只看这栏**）。
- [x] **4.5** 写 `e2e/run.cjs`：串行跑 spec、汇总、**任一失败即非零退出**；支持 `--only` / `--url`
      （`--url` 覆盖也先过守卫）与多实例 spec（`requiresInstances`）。
- [x] **4.6** `package.json` 增加 `"e2e": "node e2e/run.cjs"`（**仅台账项，非依赖变更**）。
- [x] **4.7** 跑守卫与负例：

```bash
node e2e/run.cjs --only guard
```

      **实测：断言 17 项 / 通过 17 / 失败 0，退出码 0**（AC-8 达成）。

**回滚点**：纯新增文件，删除即可；不进产品构建产物（`vite build` 不受影响）。

---

## 阶段 5 · 加载冒烟 + 功能矩阵（R3 → AC-6 / AC-7）

- [x] **5.1** 确保目标在跑。**实测**：`:8003`（Dev Luker）与 `:8004`（Real Luker）**取证时本就在运行**；
      本次**只启动了 `:8001`（Dev ST）**。`:8899`（PT web）未启动 —— 且**PT 上并未安装本插件**
      （PT 无磁盘扩展目录，需经其自身扩展管理器从远程 URL 安装），故本轮**不纳入冒烟**，
      已登记为残留。
      **同时更正一处我自己的错误**：实例登记表首版把 ST 两个实例写成 `https://`，
      实测 ST `ssl.enabled: false` 是**明文 HTTP**（Luker 才是 https）——
      是启动器的就绪探针以 `TCP 已开但 HTTP EPROTO` 抓出来的，已更正并留证于 `instances.cjs` 注释。
- [x] **5.2** 写 `e2e/specs/smoke.spec.cjs`：插件资源可取、注入点齐全、
      **本插件零报错、零失败请求**；多实例（`requiresInstances: ['dev-luker','dev-st']`）逐个跑。
      **实测：全量 E2E `npm run e2e` = 断言 53 项 / 通过 53 / 失败 0，退出码 0**（AC-5 / AC-6 达成）。
      **过程中修正了两处我自己的错误断言**（回源码核实后确认是断言写错、非插件缺陷）：
      ① 抽屉态**本来就没有** `.app-header`（`workbench-template.js:30` `const chrome = !isDrawer`）
      ⇒ 改为断言抽屉态真实存在的 `#status-row`/`#dropzone`/`#stash-list`/`#export-queue-panel`/
      `#usage-dashboard`，并**顺带断言页头确实不存在**把该约定钉住；
      ② 未打开账号弹层时 `data-st-zip-injected` 为 0 是**设计行为**（`host-bridge.js:1770` 明写
      「初始页面查询 `.userBackupButton` → 0 个，本函数自然什么都不做」）⇒ 改为断言**不变量**：
      **注入按钮数 == 宿主原生锚点数（1:1、绝无孤儿）**。
      另修正一处**测量时机**问题：宿主菜单先渲染成空壳（`#extensionsMenu` 子节点 `0 → 16`），
      插件的菜单项要到 **t≈7 s** 才出现 ⇒ 改为**有界等待**（15 s，L1-MR-7），
      不再用瞬时值判定（首版因此同一个实例时红时绿）。
- [ ] **5.3** 写 `e2e/specs/matrix.spec.cjs`：覆盖 M-1…M-9 九条路径（`design.md` §3.4）。
      ⛔ 未开始 —— 其中 **M-4（转换）依赖产品缺陷 E 的修复**，故整条矩阵与 E 一并挂起。
- [ ] **5.4** 全量跑 `node e2e/run.cjs`：**当前（guard + smoke）已退出码 0**；
      完整矩阵待 5.3。trace/截图落 `test-results/`（**严禁**写 `Instance/**`，I-5）。
- [x] **5.5** 脱敏核对：`test-results/` 已被 `.gitignore` 覆盖；本轮入库内容已核对
      **无 token、无聊天内容、无本机绝对路径**（工具脚本一律相对解析）。

**回滚点**：E2E 只读实例，不回滚数据；失败即修用例或如实登记为残留。

---

## 阶段 6 · 质量门（AC-9）

- [x] **6.1** `npm test` —— **实测 46 文件 / 429 passed / 2 skipped，exit 0，零回退**（基线逐项一致）。
      **如实登记一条既有抖动**：全量跑 5 次里抖了 2 次，均为 `test/real-samples.test.js` 的
      `Test timed out in 5000ms`（该用例读 `out/` 下 560 MB 的真实产物，默认 5 s 超时满载时不够）；
      单跑 3/3 全过。**与本次改动无关** —— 该文件只用 `openReader`，本次只改 `openStream`/`createWriter`。
      见残留 R-10。
      为 `guard.cjs` 等纯逻辑补 vitest 单测的**计划未执行**：这些模块的判定已由
      `npm run e2e --only guard` 的 17 项断言**覆盖并逐条留读数**，再写一份 vitest 版属重复；
      E2E 本身仍**不进** vitest 用例集（且已用 `.e2e.cjs` 后缀规避 vitest 的 `*.spec.*` 收集 —— 实测踩过）。
- [x] **6.2** 五条静态守卫退出码全 0：**实测 css-scope / dom-injection / template-source /
      control-consumer / dom-scope 全部 `exit=0`**。
- [x] **6.3** `npm run build` 通过（**实测 `✓ built in 1.26s`**），
      新增能力全是 Node 脚本与 `e2e/` 目录，`vite build` 产物不变（L1-MR-11 未被破坏）。
- [x] **6.4（附加）** `npm run e2e` 退出码 0（**断言 53 项 / 通过 53**）—— 见阶段 4/5。

**回滚点**：质量门不过即修，不带着失败提交。

---

## 阶段 7 · 规范落库（AC-10）

- [x] **7.1** 新建 **`.trellis/spec/backend/node-zip-writer-pitfalls.md`**（**自包含**：内联症状速查表、
      四条硬约束与正误代码对照、实测读数、`io` 契约陷阱、大包不进内存的可用做法、
      可执行守护命令，**不写**「详见任务目录」）。
      另新建 **`.trellis/spec/guides/instance-e2e-and-data-sync.md`**（自包含：实例端口/协议纪律、
      Dev-only 守卫契约与四条不可省约束、四宿主导出/导入通道对照、ST 逐类目端面与三条硬约束、
      备份通道的 chunked/速率塌方实测、搬数据的语义纪律）。
- [x] **7.2** 更新 `.trellis/spec/guides/index.md` 与 `.trellis/spec/backend/index.md` 的索引表；
      `frontend/index.md` 补一行说明 **`npm run e2e` 不是发版门槛**（需实例在跑且只许连 Dev）。
      **`npm test` 的测试计数未变**（46 文件 / 429 passed / 2 skipped），无需改动。
      ⚠️ **未向 `component-guidelines.md` 追加任何内容**（该文件距 32768 字节上限仅余 135 字节）。
- [x] **7.3** 三条平台文件与真源块的同步**本次未做** —— 本任务未改统一规则正文；
      若需改动，须走真源仓 `tavern-harness` 的同步器，**不手改**。

**回滚点**：spec 改动可 `git checkout` 还原。

---

## 阶段 8 · 收尾（AC-11 + 提交）

- [x] **8.1** **关闭本次启动的实例**（I-6）。**实测**：本次只启动了 `:8001`（Dev ST），已停并复验端口释放；
      `:8003`（302）/ `:8004`（200）**保持原样在跑**。`stop-instance.cjs` 对无 pidfile 的实例**拒绝停止**
      （已实测：对 `dev-luker` 正确拒绝）—— 保证不会误关用户既有环境。
      **顺带修掉停止器的一个真缺陷**：pidfile 记的是 Windows 下 `shell: true` 的**包装进程** pid，
      真正监听的是它的子进程（实测包装 75308 / 监听 55980）—— 直杀 pidfile 的 pid 会报「已退出」而**端口仍在**。
      已改为「pidfile 只作归属凭证，杀谁由**端口**决定」，并经启停端到端复验。
- [x] **8.2** `git status --short` 做**范围门**（L0-17：**不用** `git diff --stat`）——
      改动集合全部为本次预期文件（`e2e/**`、`scripts/instance-sync/**`、`src/core/zip-io.js`、
      两份新 spec + 三处索引、`.gitignore`、`package.json`、任务目录）。
- [x] **8.3** `prd.md` 的「残留」表已回填（R-1…R-10）与「已达成项」清单。
- [x] **8.4** 提交并**推送 origin**（L0-7）：三次提交 `1f16aa2` / `ae8c8d7` / `16d835c` 均已推送。
- [x] **8.5** 写 journal（Session 30）；`task.py archive` **未执行** ——
      本任务**未完成**（阶段 2/3 挂起），不应归档。

---

## 请批结果（阶段 0.1，2026-09-26 已裁决）

| # | 事项 | 裁决 | 备注 |
| --- | --- | --- | --- |
| **A-1** | R2 向实例目录写入，与 L0-1 字面冲突 | ✅ **批准偏离** | 只走宿主原生通道；写入语义 `merge`；先备份 + 差异核对 |
| **A-2** | 备份范围扩到四个 ST/Luker 实例 | ❌ **否决 —— 只备份 Real Luker**（U-9） | 后果已登记：Dev Luker / Dev ST / Real ST **无回滚手段**，见 `prd.md` R1 的 U-9 框与 `design.md` §6 |
| **A-3** | `e2e/` 与 `scripts/instance-sync/` 入库 | ✅ **批准** | 路径相对解析，不含本机绝对路径与凭据（P-17 / L1-MR-14） |
| **A-4** | ST 导入不可自动化时的降级预案 | ✅ 预先认可 | 降级为「产包 + 手工说明」+ 残留登记，**不拿裸文件拷贝凑数**（I-3） |
| **A-5** | 把 Playwright 写入 `devDependencies` | ⏸ **默认不做** | 复用全局 1.62.1；确有必要时单独走 PARDON |
| **U-12** | 推进节奏 | **先跑阶段 1-2** | 只读实例 + 只在 Downloads 产包；读数回报后再定阶段 3 |
