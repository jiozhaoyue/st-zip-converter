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

- [x] **3.1** 写 `scripts/instance-sync/diff-report.cjs`（三张表：源覆盖率 / 目标独有存活 / 内容量）。
      **判定核心已抽出并单测**：`scripts/instance-sync/lib/t1-coverage.cjs` +
      `test/instance-sync-t1-coverage.test.js`（15 项，含**负例**）。三条判定口径的演进见文末「本轮修复记录 F–I」。
- [x] **3.2** **空转对照**：不写入，只算差异，确认三张表能正确报出「目标缺什么」
      —— **先证明判定会报差异，再相信它报 100%**。
      证据两条：① 迭代期实测到过**非 100%** 的读数（`research/diff-dev-luker-1790408246343.json`
      15:37 的 `84.805%` 口径 bug、`diff-dev-st-1790409956992.json` 的 `94.75%` 命名口径）；
      ② 本轮把判定抽成纯函数后补齐**负例用例**（`test/instance-sync-t1-coverage.test.js`：
      「落盘名不在目标 ⇒ 必须判缺失」「链接根之外的缺失仍判缺失」等）。
- [x] **3.3** `restore-luker.cjs` 同步 **Dev Luker :8003** —— **2026-09-26 已完成**。
      ⚠️ **实际未走 probe**：`/restore-backup/probe` 对不含 `_engine_meta.json` 的包会**挂住**
      （`readEngineMetaFromZip` 未处理 yauzl 的 `end` 事件），故用 `--skip-probe` 直走
      `mode=merge` + 全 10 类目 selection。服务端回执：
      `restoredCount=7178 / failedCount=0 / rejectedCount=0 / skippedCount=2`。
      **两个障碍与解法**（详见 `research/luker-restore-blocker.md`）：
      ① 文件字段名必须是 **`avatar`**（Luker 全局 multer 是 `.single('avatar')`），用 `file` 会得到
      无信息的 HTTP 500；② 包内 `.git` 对象文件在目标侧带 `ReadOnly`（165 个只读项）导致
      `EPERM` 中断 ⇒ 产包改用 **`gitMode: 'minimal'`**（剔除 `objects/**`，保留 config/HEAD/index/refs）。
- [x] **3.4** 对 Dev Luker 跑 `diff-report.cjs` → **AC-2 达成**：
      **T1 覆盖率 100.000%（7177/7177）**、**T2b 6679→6679 被删 0（零删除）**、退出码 0；
      T3 目标角色卡 **431**（包 430）/ 聊天 **1236**（包 1029）⇒ **超集**，符合 U-3。
      单列项（不计入判定，均有依据）：T1b 合成元数据 1 条、T1d **链接目录内缺失 3 条**
      （`extensions/ST-BgLoader` 是 junction，外部工作区漂移，见修复记录 I）、
      T2c 宿主自管缓存 `backups/` 54 条（宿主 restore 前轮换）。
- [x] **3.5** `import-st.cjs` 同步 **Dev ST :8001**（按 2.3 的路径 + `--raw-write` 覆盖无端点的类目）。
      **实测读数**：`characters 26/0` + `characters/sprites 28/0` + `chats 1029/0` + `worlds 21/0` +
      `User Avatars 9/0` + `settings 合并` + `extensions 5204/0` + `user 191/0` + 预设/主题类 11 类合计 278/0
      ⇒ **总 6801 成功 / 0 失败**；不可达仅 4 条（`_convert/**` 3 条合成元数据 + `secrets.json`）。
- [x] **3.6** 对 Dev ST 跑 `diff-report.cjs` → **AC-2 达成**：
      **T1 100.000%（7177/7177，其中 380 条按 ST 落盘名命中）**、**T2b 198→198 被删 0**、退出码 0。
      T3 目标角色卡 54（= 26 张卡 + 28 张精灵图）/ 聊天 1029。
- [x] **3.7** 同步 **Real Luker :8004**（同 3.3）→ **T1 100.000%（7177/7177）**、
      **T2b 7985→7985 被删 0**；T3 角色卡 430 / 聊天 1029 —— 与包**逐项相等**。
- [x] **3.8** 同步 **Real ST :8002**（同 3.5）→ **T1 100.000%**、**T2b 195→195 被删 0**；
      T3 角色卡 54 / 聊天 1029。
- [ ] **3.9** `import-pt.cjs` 同步 **PT web :8899** —— **未执行：web 模式没有该后端**。
      取证结论（`research/pt-import-channel.md`）：控件齐全（`#ptdm-tt-import-file` + `#ptdm-tt-strategy`，
      默认 `merge`），但执行段依赖 `fetch('/api/backups/tauritavern/import')`，
      而该路径在 web dev 下 **POST 返回 404**（GET 是 SPA 兜底 HTML）⇒ 无后端可用。
      打通需另起 PT `remote-server`（端口 3030）⇒ **方向性决策，待用户裁定**。
- [x] **3.10** **AC-3 内容断言**：
      ① **Luker 目标**按路径逐项核对 —— Real Luker 角色卡 **430 = 包内 430**、聊天 **1029 = 1029**；
      Dev Luker 为超集（431 / 1236）。
      ② **ST 目标**按宿主形态核对 —— 角色卡 26/26 全部按**落盘名**命中
      （`diag-st-char-map.cjs` 判定 ✅，包内 401 条版本化条目 → 26 个落盘名），聊天 **1029 = 1029**。
      ③ 真源口径：源目录 `characters/` 403 个 sha 文件 → 归并出 26 个角色（平均 15.4 份历史版本，
      最大一组 250 份；**逐份内容指纹不同**，已实证是版本历史而非重复）。
- [x] **3.11** **AC-4 交付物**：`pack-luker-20260926-010422.zip`（510.6 MB）、
      `pack-st-20260926-010422.zip`（510.6 MB）、`pack-tt-20260926-010422.zip`（510.8 MB）
      与 `TT-导入说明.md` 均在 `C:\Users\caocaobi\Downloads\`；`backup-real-luker-20260926-010422.zip`
      （1602.7 MB）与同名 `.json` 读数记录同目录。

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
- [x] **5.3** 写 `e2e/specs/matrix.e2e.cjs`：覆盖 M-1…M-9 九条路径（`design.md` §3.4）。
      **2026-09-26 第五轮已完成**（挂起原因「M-4 依赖缺陷 E」在 E 解除后即失效）。
      文件名是 **`.e2e.cjs`** 而非设计文档写的 `.spec.cjs` —— `.spec.cjs` 会被 vitest
      当单测收集（`e2e/run.cjs` 头注已记该坑）。
      **读数：断言 122 项 / 通过 122 / 失败 0，且连续两轮全绿**（可重跑性坐实）。
      覆盖与判定面、实现中逐一查实的 **6 处断言侧错误**、**1 处疑似产品缺陷（N-1：`native` 未走布局码归一）**、
      **M-7 的可达性真相**（转换任务根本不注册 TaskManager）、
      以及**可重跑性的真敌人**（持久化 workspace 状态），逐条留证于
      `research/e2e-matrix-findings.md`。
      顺带扩了 `e2e/lib/harness.cjs` 一处：夹具暴露 `instanceId` / `instance`，
      供 spec 写实例差异化的断言（此前 spec 拿不到自己跑在哪个实例上）。
- [x] **5.4** 全量跑 `node e2e/run.cjs`：**实测断言 175 项 / 通过 175 / 失败 0，退出码 0**
      （guard 17 + smoke 36 + matrix 122）。trace/截图落 `test-results/`（**严禁**写 `Instance/**`，I-5）。
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

---

## 本轮修复记录（2026-09-26 第三轮：打通阶段 3 的 ST 通道 + 判定口径）

> 编号承接前轮（A–E 见 `research/build-packs-blocker.md` 与 `research/luker-restore-blocker.md`）。
> 每条都带**症状 → 根因 → 修法 → 证据**，避免"修了但不知道修的是什么"。

- **F · ST 角色卡「拆壳 + 命名」四处缺陷**（症状：430 张卡只进去 26 张、且名字错成 `x.png.png`）
  - F-1 **落盘名推导顺序写反**：`人类名 = 键尾.replace(/\.png$/i,'').replace(/-\d+\.\d+$/,'')`
    —— 先剥扩展名时该串以数字结尾、正则不命中 ⇒ 名字留下 `.png`，ST 落成 `孤独摇滚.png.png`。
    **修**：`parseLukerKey()` **先剥版本戳、后剥扩展名**；证据：目标侧实测到 28 个双扩展名文件。
  - F-2 **V3 卡取不到名字**：只认 `card.name`，而 V3 卡名在 `card.data.name`
    ⇒ 38 张卡被打回 sha256 兜底名。**修**：两处都认。
  - F-3 **`data/_uploads/` 的键尾是上传号不是角色名** ⇒ 落成 `<sha>.png` 无名卡片（11 条）。
    **修**：仅当键尾**在 `characters/` 下且不像 id** 时才用它，否则退回卡片自带名。
  - F-4 **把 Luker 的版本历史当成 430 张不同的卡**：`characters/<sha256>` 是**版本化 blob**
    （键尾 `-<毫秒>.<微秒>`），430 条条目只对应 **26 个角色**（平均 15.4 版，最大 250 版）。
    逐条投递 ⇒ 同名前赴后继互相覆盖，最终留下的是**包内顺序最末**那份而非**最新版**。
    **修**：`import-st.cjs` 先按 `avatar` **归并取最新版**再投递（430 → 26 次调用）。
    **证据**：`diag-st-char-map.cjs --versions 孤独摇滚` 打出 250 条的**内容指纹互不相同**（是版本历史，不是重复）。
    实现抽为 `lib/luker-card-adapter.cjs`（导入器与诊断器**共用同一实现**，防两处推导漂移）。
  - F-5 **精灵图被当成角色卡投递**：`characters/Seraphina/*.png` 走 `characters/import` 得
    `{"error":true}`（28 条）。**修**：子目录条目改走**同路径裸落盘**（ST 本来就按这个形态存精灵图）。
  - F-6 **Luker 私有状态文件被当成卡**：`characters/<名>.state.<编辑器>.json` ⇒ HTTP 400。
    **修**：登记为不可达、不投递（判据**故意取窄**：`.state.` 与 `.json` 之间必须有编辑器名）。
  - **修后读数**：Dev ST / Real ST 均 `characters 26 成功 / 0 失败` + `精灵图 28/0`。

- **G · T1 覆盖率口径在 ST 上恒假**（症状：内容都在，却报 94.75%）
  - **根因**：包内角色卡是内容寻址名（`characters/<sha256>`），而 ST 一律落成 `characters/<角色名>.png`
    —— **逐路径比对不可能相等**。
  - **修**：T1 改为**先路径、后宿主落盘名**两步判定（`lib/t1-coverage.cjs` 的 `compareCoverage`），
    并把「按落盘名命中」单独计数（本次 380 条）。判定核心**抽成纯函数并单测**，
    含**负例**（落盘名不在目标 ⇒ 必须判缺失），避免"规则写成恒真"。
  - **修后读数**：Dev ST / Real ST 均 **T1 100.000%（7177/7177）**。

- **H · 「零删除」判定里混入了宿主自管缓存**（症状：Dev ST 报 2 条被删）
  - **根因**：ST 在**导入成功时**会失效该文件对应的缩略图（`characters.js:1591` /
    `avatars.js:52` → `thumbnails.js:83-92` 的 `unlinkSync`），而 `thumbnails/` 是可重建的派生缓存。
    相关性已实证：快照里恰好只有两条 `thumbnails/`，而包内恰好有角色 `default_Seraphina`
    与 `User Avatars/user-default.png` —— 一一对应。
  - **修**：`HOST_MANAGED_CACHE` 把 `backups/`（Luker restore 前轮换）与 `thumbnails/` 单列，
    **登记但不判**（`T2c`），并写单测钉住「缓存目录之外的必须仍算真删除」。

- **I · 同步写入穿透 junction 落到外部仓**（症状：Dev Luker 的 3 条「缺失」其实是别人仓的漂移）
  - **根因**：`Instance/Dev/Luker/data/default-user/extensions/ST-BgLoader` 是指向
    `My-repo/ST-BgLoader` 的 **junction** ⇒ 该子树是**别人的活工作区**，随对方仓随时改动；
    本次 restore 的 1090 条也因此**穿透写进了那个仓的工作区**（该仓现 git 干净）。
  - **修**：新增 `lib/link-guard.cjs` —— 裸落盘类目**默认跳过**链接子树（计数登记）；
    宿主原生 restore **一把写完、无法逐条跳**，故改为**前置门禁**：发现链接即拒绝启动，
    除非显式 `--allow-links`（用户 2026-09-26 裁决「默认跳过链接子树」）。
    判定同样抽出单测（含真实 junction 的建/拒/放行三种情形）。
  - **修后读数**：Dev Luker T1 100%（其中 3 条落在链接子树内，单列为 `T1d`，只报不判）。

- **清理 · 两个 ST 目标上本任务自身的错误产物**（PARDON 项，用户 2026-09-26 批准）
  - Dev ST 66 个 / Real ST 65 个（双扩展名 + 无名字 + 带时间戳错名），
    由 `scripts/instance-sync/cleanup-st-char-artifacts.cjs` 按**三条判据同时成立**才删
    （在 `characters/` 平铺层 ∧ 不在同步前快照内 ∧ 不等于应有落盘名），
    删除前先把 `路径 + 字节 + sha256` 落 `research/cleanup-st-char-artifacts-*.json`。
  - 清理后两个 ST 目标 `characters/` 各剩 **26 张卡 + 1 个精灵图目录**，与源侧 26 个角色一一对应。

---

## 🔴 交接状态（2026-09-26 第四轮 · 用户指令「停止，将状态全写 Trellis 文档交接」）

> 本轮从「阶段 3 未执行」推进到「**四个 ST/Luker 目标全部达成 T1 100% + 零删除**」，
> 途中**发现并修复了 4 类缺陷（F/G/H/I）与 1 起自己造成的事故（J）**，最后 `npm run e2e` 53/53 全绿。
> 下面按「已做完 / 未做完 / 环境现状 / 续做命令」四段交接。

### 一、已完成（可直接复核）

| # | 事项 | 读数 / 证据 |
| --- | --- | --- |
| 1 | **Dev ST / Real ST 全类目同步**（`--raw-write`） | 各 **6801 成功 / 0 失败**；不可达仅 4 条（`_convert/**` 3 + `secrets.json`）；读数 `research/import-st-{dev,real}-st-1790416*.json` |
| 2 | **四个目标差异核对** | Dev ST `7177/7177`（198→198）、Real ST `7177/7177`（195→195）、Dev Luker `7177/7177`（6679→6679）、Real Luker `7177/7177`（7985→7985）：**全部 T1 100% + T2b 零删除** |
| 3 | **T1 判定口径纠正（缺陷 G）** | ST 角色卡改「先路径、后**宿主落盘名**」两步判定（本次按落盘名命中 380 条）；核心抽成 `lib/t1-coverage.cjs` + 15 项单测（含负例） |
| 4 | **ST 角色卡拆壳/命名/版本归并（缺陷 F）** | 430 条版本化条目 → **26 个角色**（实测逐份内容指纹不同）；`characters 26/0` + 精灵图 `28/0`；唯一实现在 `lib/luker-card-adapter.cjs` |
| 5 | **宿主自管缓存单列（缺陷 H）** | `backups/`（Luker 轮换）+ `thumbnails/`（ST 导入成功即失效，`characters.js:1591`/`avatars.js:52`）→ 登记不判（T2c） |
| 6 | **链接子树守卫（缺陷 I）** | `lib/link-guard.cjs`：裸落盘默认跳过、restore 前置拒绝（实测 Dev Luker 拒绝且 `exit=1`）；判定含真实 junction 单测 |
| 7 | **清理本任务自身产物**（用户批准） | Dev ST 66 个 / Real ST 65 个；删除前落 `research/cleanup-st-char-artifacts-*.json`（含 sha256） |
| 8 | **settings 事故修复（缺陷 J，见下）** | 两个 ST 目标 113.7 MB → 22.5 MB；`import-st.cjs` 改为**按目标键集的交集合并** |
| 9 | **质量门** | `npm run e2e` **53/53 全绿**（settings 修复后复跑）；`npm test` **47 passed / 1 skipped（48 文件）、449 passed / 2 skipped、exit 0**；五条静态守卫 `exit=0`；`npm run build` ✓ 1.44s。**交接时最后那次全量跑**（18:34）出现 1 条红：`test/real-samples.test.js` 的 `Test timed out in 5000ms` —— 即**既有抖动 R-10**（读 `out/` 下 560 MB 本地产物、机器满载时 5 s 不够），**与本次改动无关**（该文件只用 `openReader`+`skip`）；同日另一次全量 449/449、exit 0 |
| 10 | **规范落库** | `.trellis/spec/guides/instance-e2e-and-data-sync.md` 新增 §7–§10（三口径 / 拆壳 / 链接守卫 / 清理纪律），索引已更新 |

### 二、缺陷 J · 跨宿主 `settings.json` 合并把 ST 实例搞停（本轮最重要的事故）

- **症状**：`npm run e2e` 的 Dev ST 冒烟从 53/53 掉到 **50/53**（`宿主已挂上插件`/`扩展设置面板存在`/`面板内抽屉存在` 三条红）；
  浏览器控制台显示 `Settings not ready, scheduling another save` ×N，**所有第三方扩展都不加载**。
- **取证**：`settings.json` 由 **44,564 B / 27,373 B 膨到 113,680,214 B / 113,654,958 B**；
  膨胀来自 Luker 专有顶层键 —— `settings` **46 MB**、`openai_settings` **34.5 MB**、`themes`、`instruct`、
  `context`、`sysprompt`、`reasoning`、`quickReplyPresets`、`kobaldai_*`、`novelai_*` 等共 **27 个键**
  （ST 用 `oai_settings`，不认 `openai_settings`）。
- **根因**：`import-st.cjs` 的 settings 分支写的是 **`{...目标, ...包内}`（并集）** —— 把**源宿主的 schema**
  整块搬进目标；ST 前端每轮解析/回存这个对象，卡在 settings 未就绪 ⇒ `activateExtensions()` 永不执行。
- **修法（用户 2026-09-26 裁定「只删陌生键」+「改为交集合并」）**：
  1. `repair-settings-merge.cjs`：删「目标自己的键集里没有」的顶层键（键集取目标自己的合并前备份，
     两个 ST 实例取**并集**以更保守）；写前把当前文件整份留底到 `test-results/settings-repair-backups/`；
     台账 `research/repair-settings-merge-{dev,real}-st-*.json`。**实测 113.7 MB → 22.5 MB，冒烟恢复 53/53。**
  2. `import-st.cjs` settings 分支 → **交集合并**（只在目标已有键内同名覆盖；陌生键不写并计数）。
- **教训（已入 spec §7.3 / 待补 §11）**：**「覆盖同名」不等于「并集」** —— 跨宿主的配置文件必须
  按**目标 schema 的键集**收口；否则一个 46 MB 的陌生键就能让宿主前端整体瘫痪，而**逐条错误读数一个都不报**。

### 三、未完成（续做清单，按建议顺序）

1. **PT 同步（3.9）**：web 模式**没有该后端**（`POST /api/backups/tauritavern/import` → 404，
   GET 是 SPA 兜底），需另起 PT `remote-server`（端口 **3030**，L0-16）—— 属方向性决策，
   取证见 `research/pt-import-channel.md`；读数装置已备好（`pt-automation.cjs` 的 `countPtData()`）。
2. **功能矩阵 M-1…M-9（AC-7 / 5.3）**：`e2e/specs/matrix.spec.cjs` **未写**。
3. **收尾**：`prd.md` 残留表已更新到 R-15（本轮新增 J）；`task.py archive` **未执行**（任务未完成）。
4. **可选**：把 §7–§10 的口径再抽一条「跨宿主配置文件合并纪律」进 spec（现在只在 §7.3 有一行提示）。

### 四、环境现状（**未按 AC-11 关闭**：交接需要实例在跑）

| 端口 | 实例 | 归属 |
| --- | --- | --- |
| 8001 | Dev ST | **本次启动**（pid 31128） |
| 8002 | Real ST | **本次启动**（pid 1388） |
| 8899 | PT web | **本次启动**（pid 48804） |
| 8003 | Dev Luker | 用户既有（pid 53104）—— **未动** |
| 8004 | Real Luker | 用户既有（pid 24384）—— **未动** |

- 两个 ST 目标的 `settings.json` 已修复并留底（`test-results/settings-repair-backups/`，可回滚）。
- 两个 ST 目标 `characters/` = **26 张卡 + 1 个精灵图目录**，与本任务范围一一对应。
- **Dev Luker 起已默认拒绝写入**（junction 守卫），重跑 restore 需显式 `--allow-links`。

### 五、续做命令（照抄即可）

```bash
# 差异核对（四个目标；ST 需带 --extra-root 指向 third-party 扩展目录）
node scripts/instance-sync/diff-report.cjs --pack "$HOME/Downloads/pack-st-20260926-010422.zip" \
  --target dev-st --pre-manifest .trellis/tasks/09-26-all-instance-data-sync-e2e/research/t2-pre-dev-st.json \
  --extra-root "D:/Repo/Tavern-repo/Instance/Dev/SillyTavern/public/scripts/extensions/third-party:extensions"

# ST 全类目同步（幂等；需要实例在跑）
node scripts/instance-sync/import-st.cjs --id dev-st --raw-write

# 角色卡命名的版本归并读数 / 必要名单
node scripts/instance-sync/diag-st-char-map.cjs --pack "$HOME/Downloads/pack-st-20260926-010422.zip" --target dev-st --list 20

# 质量门
npm test && npm run e2e
```
