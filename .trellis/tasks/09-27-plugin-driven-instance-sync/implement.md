# 执行计划 · 插件产包驱动的实例数据同步与备份

> 父任务 `09-27-instance-sync-and-plugin-hardening`；本子任务 `09-27-plugin-driven-instance-sync`。
> 设计见 `design.md`（D0–D8），需求与验收见 `prd.md`（A1–A5 / AC-A1…AC-A10）。
>
> **勾选纪律**（L0-2 / `L0-17`）：复选框**随执行实时勾选**，禁止任务结束后凭记忆批量补勾。
> **步骤序铁律**（`design.md` D3）：`产包 → 备份 → 只读快照 → 灌入 → 核对`。
> **不得**让任何写入跑在备份前面。

## 0 前置条件（开工前逐项确认）

- [x] **0.1** `python ./.trellis/scripts/task.py current` 指向本任务，且状态已 `in_progress`
      （**须先过 1.4 评审门**）
      —— *2026-09-29：`task.py start` 执行 ⇒ `planning → in_progress`；`current` = 本任务。
      括号那句的准确含义是「**§3 实现前**须过 1.4 评审门」，**不是**「开工前」——
      §0-§1 是**只读取证**，正是为 1.4 评审门准备读数*
- [x] **0.2** **槽位顺序前置**：兄弟任务 `09-27-plugin-defect-fixes`（子任务 B）若**已完成**
      或**已决定不做**，则本任务开工；若 B 仍在进行 ⇒ **先等 B**（`design.md` D7.1）
      —— 理由：B 改插件代码（`index.js` / `src/ui/host-bridge.js` / `fixtures/gen.js`），
      而 A 的 `D1.2` 第 3 步有 R-20 硬门禁（实例插件版本必须 == 工作区）。
      **先做 B 只需更新一次实例；先做 A 则 B 落地后要再更新一次。**
      —— *2026-09-29：**B 已完成并归档**（`archive/2026-09/09-27-plugin-defect-fixes`，
      AC-B1~B8 全部达成）⇒ 前置满足，本任务开工。**顺序收益已兑现**：实例只需更新一次*
- [x] **0.3** 基线取证：`npm test` 与 `npm run e2e` 各跑一次，记录**开工基线**
      （参照值：`npm test` 460 passed / 2 skipped / 48 文件；`npm run e2e` 175 项 / exit 0
      —— **以本轮实测为准，照抄旧读数不算取证**）
      —— *2026-09-29 本轮实测（**不照抄参照值**）：`npm test`（`npx vitest run --maxWorkers=2`）
      = **64 文件 / 610 passed / 2 skipped / 0 failed / exit 0**；
      `npm run e2e` = **281 断言 / 281 通过 / 0 失败 / exit 0**。读数落
      `research/step0-preconditions.json`*
- [x] **0.4** 五条静态守卫 `exit=0`；`npm run build` 通过
      —— *2026-09-29 实测：`css-scope` / `dom-injection-guard` / `single-template-source` /
      `dom-scope` / `control-consumer-guard` **全 EXIT=0**；`npm run build` **EXIT=0**（1.44 s）。
      ⚠️ 自测踩点已登记：首次把脚本名写错（`dom-injection` 而非 `dom-injection-guard`、
      `template-source` 而非 `single-template-source`）⇒ 得到 3 个**假的** EXIT=1，勿误判为回归*
- [x] **0.5** 实例在监听：`:8001` / `:8002` / `:8003` / `:8004`（`:8899` 仅 PT 段落需要）
      —— *2026-09-29 实测：`8001` HTTP 200 · `8002` HTTP 200（本轮启动）·
      `8003` HTTPS 302 · `8004` HTTPS 200（本轮启动）；另 `8899` HTTP 200（PT 段需要，已启动）*
- [x] **0.6** 建立 `research/` 目录（本任务全部读数、快照、台账落此处，**不入版本库**）
      —— *已建；首个读数 `research/step0-preconditions.json` 已落*
- [x] **0.7** `.gitignore` 复核：确认本轮不会把 `test-results/` / `.pw-profile*` / `research/` 带入库
      —— *复核：`test-results/`（`.gitignore:24`）、`.trellis/tasks/**/research/*.json`（`:59`）、
      `.pw-profile*`（通配）均在忽略之列*
- [x] **0.8** **写盘前只读链检查**（`P-19` 防护）：对四个目标的数据路径跑一次 `lstat`/`realpath`，
      确认无指向工作区仓的 symlink / junction；有则登记并确认 `lib/link-guard.cjs` 会拦下
      —— *2026-09-29 实测（`findLinkedRoots` 逐目标扫 `data/default-user`）：
      **dev-st 0 / real-st 0 / real-luker 0**；**dev-luker 1 条** ——
      `extensions/ST-BgLoader -> D:\Repo\Tavern-repo\My-repo\ST-BgLoader`，
      **正是 P-19 记录的那条 junction**。⇒ 无需人工前置处置：它正是 `link-guard` 的既定防护对象
      （用户 2026-09-26 裁决「默认跳过链接子树」；本类走「裸落盘类目」分支 = 逐条跳过 + 计数登记）*

## 1 阶段 1 · 只读取证（**零写入**，三个 OQ 在此收口）

### 1.1 OQ-2：插件能否**一步直出**目标布局（`design.md` D2）

- [ ] **1.1.1** 用插件（Real Luker `:8004`，或先用 Dev Luker `:8003` 走通再换真源）
      分别以 `--layout st` / `--layout tt` / `--layout l` 产三次包
      —— **本步允许先用 Node 侧既有 `export-backups.cjs` 做对照基线**，插件侧产包在 §3 落地后复跑
- [ ] **1.1.2** 与上一轮 `build-packs.cjs` 产出的同名布局包做**条目级比对**
      （复用 `lib/t1-coverage.cjs`）：条目路径集合、条目数、每条 `crc32`
- [ ] **1.1.3** **判定并落读数** `research/one-step-layout-<layout>.json`：
      - **成立**（条目级一致或差异可解释）⇒ 生产链简化为「插件三布局包一步产出」，
        `build-packs.cjs` 退为**交叉核对装置**（**不删**）
      - **不成立** ⇒ **给出实测理由**（差异清单 + 归因），沿用 `build-packs.cjs`
      - **无论成立与否，结论都要落 spec**（避免下次再试一遍）

### 1.2 OQ-1 / OQ-3：插件产包与宿主原生备份的**口径比对**

- [ ] **1.2.1** 对**同一源**，分别取「插件产物」与「宿主原生备份（`POST /api/users/backup`）」两者
- [ ] **1.2.2** 条目级比对：数量 / 路径集合 / `crc32`；**不可达条目显式列出**
- [ ] **1.2.3** 专项核查 `secrets.json` / `settings.json` 的处置（是否被插件打包路径覆盖、
      是否被排除）—— **差异显式登记**，不静默
- [ ] **1.2.4** 读数落 `research/plugin-vs-native-backup.json`

### 1.3 R-20 前置核对（**硬门禁的实现前身**）

- [x] **1.3.1** 逐实例读插件版本：`git -C <插件目录> rev-parse --short HEAD`
      与工作区 `git rev-parse --short HEAD` 比对
      —— *2026-09-29 实测：工作区 `f75c68e`（== `origin/main`，已推送）；**四实例全部落后** ——
      Dev ST / Dev Luker `137d4f3`（落后 **37** 提交）、Real ST / Real Luker `1640118`（落后 **94** 提交）。
      ⚠️ **`prd.md` 的「Dev 两实例插件代码等于工作区」已失效**：`137d4f3..HEAD` 含真插件代码提交
      `b26e8af`（真增量续传：`index.js` +160 / `transform.js` +171 / `worker-client.js` +149 / `zip-io.js` +78）
      ⇒ §0.3 的 E2E 基线 281/281 **量的是 `137d4f3` 而非工作区代码**（正是 R-20 要拦的形态）。
      减轻因素：`src/ui/host-bridge.js`（`fetchHostBackup` 所在）在该区间**零改动*** 
- [x] **1.3.2** 按 U-5 更新 **Real 两实例**（`:8002` / `:8004`）的插件：**仅限 `git pull`**
      —— 动的是**插件代码目录**，不是用户数据；两目录须**干净**且 `origin` 指向本仓（非上游）
      —— *2026-09-29 **用户裁决扩大为「四个实例全更新」**（原字面只写 Real 两处）：因 1.3.1 实测
      Dev 也落后（缺 `b26e8af`），而 R-20 要求「实例插件版本 == 工作区」，§8.4 的 E2E 复核亦然。
      执行：四目录 `git pull --ff-only` ⇒ **全部 `f75c68e` / 脏 0**（通道符合 U-5，P-12 无风险）*
- [x] **1.3.3** 更新后复测四实例版本，读数落 `research/instance-plugin-versions.json`
      —— *已落；含 before/after 四实例版本、通道、R-20 判定、两条现场发现*
- [x] **1.3.4** ⚠️ **确认 `origin`**：`git remote -v` 输出中 `origin` 必须是本仓
      —— `P-12` 记录过「本地实例仓 `origin` 误指上游」的事故形态
      —— *四实例 `origin` 均为 `https://github.com/jiozhaoyue/st-zip-converter.git`，与工作区
      `origin` 同一个（本仓，非上游）⇒ **P-12 风险不存在**；另记两 Real 克隆均为 shallow / branch main*

### 1.4 评审门（**1.1–1.3 的读数回报后再进入 §3**）

- [ ] **1.4.1** 把 1.1 / 1.2 的结论与 1.3 的版本读数**回报用户**，确认「一步直出」是否采纳
- [ ] **1.4.2** 若 1.1 判定成立 ⇒ 更新 `design.md` D2 与本节 §3 的产包实现路径，再继续

## 2 备份（**只 Luker 两处**，U-3；**必须先于任何写入**）

- [x] **2.1** **Real Luker `:8004`**：宿主原生数据包导出
      （`node scripts/instance-sync/export-backups.cjs --id real-luker`），
      落 `Downloads/`，命名含实例名与日期
      —— *2026-09-29 实测：`backup-real-luker-20260929-123607.zip`，
      **1605.3 MB（1 683 295 913 B）/ 8698 条目 / 337.5 s /
      sha256 `de2bc789d447706532d0b045bd833bbe0eb6e233c6c13bfead0c28ffd116eb45`**（exit 0）。
      对照 9/26 那轮（1602.7 MB / 8683 条）⇒ **+15 条目**（真源在使用中，符合预期）*
- [x] **2.2** **Dev Luker `:8003`**：同上（`--id dev-luker`）—— **本轮新增**（上一轮 U-9 只备份了 Real）
      —— *2026-09-29 实测：`backup-dev-luker-20260929-124354.zip`，
      **1213.0 MB（1 271 907 099 B）/ 8061 条目 / 181.6 s /
      sha256 `5cadfa39552301b92be11dea3f1a06c62f2cd7dcd9f2f8ca54c77bcb3f269fd8`**（exit 0）。
      ⇒ **Dev Luker 本轮首次获得回滚能力***
- [x] **2.3** 两处各产出可复核记录：**大小 / 条目数 / SHA-256** ⇒ `research/backup-records.json`
      —— *两处读数已落 `research/backup-records.json`；原始记录另在 `Downloads/backup-*-*.json`（脚本自动写）*
- [x] **2.4** 校验通过（文件存在、体积与条目数非零）后才允许进入 §5
      —— *两包 `exit 0`（脚本内已做 sha256 + 中央目录条目数校验），体积均 >1 GB、条目数均 >8000
      ⇒ 校验通过。**§5 尚未执行**（本轮止于「备份 + 产包 + OQ-2 判定」）*
- [x] **2.5** **登记再确认**：ST 两处（`:8001` / `:8002`）**不备份**
      —— 沿用上一轮 R-7 的**用户知情风险接受**，本轮不解除。
      缓解维持三条：`merge` 语义（不删独有）+ 写入前只读快照 + 逐目标零删除核对
      —— *2026-09-29 登记再确认：本轮 U-3 未变更 ⇒ ST 两处仍无备份。2026-09-29 新增的事实：
      **Dev Luker 现已具备回滚能力**（§2.2），Luker 一侧的风险面较上一轮**缩小***


## 3 产包器实现（**本子任务唯一的新代码**，`design.md` D1.2）

- [x] **3.1** 新增 `scripts/instance-sync/produce-via-plugin.cjs`（**入库**，U-11）
      —— *2026-09-29 已落（约 470 行）。**Dev Luker `--raw` 实跑端到端通过**（`exit 0`）：
      `l_default-user_part1_2026-09-29.zip` / 1213.0 MB / 8061 条目 / t+343.4 s*
- [x] **3.2** 复用既有资产，**不新造**（`design.md` D1.1）：
      `e2e/lib/instances.cjs`（`getInstance` / `PROFILES` / `userDirOf`）、
      `e2e/lib/harness.cjs`（`openInstance`）、
      `e2e/lib/resolve-playwright.cjs`（**不新增 npm 包**）、
      `e2e/specs/matrix.e2e.cjs` 的 `openWorkbench()`（spec §11.1）
      —— *已复用：`instances.cjs`、`resolve-playwright.cjs`、`harness.cjs`（仅取常量 `PLUGIN_SLUG`）、
      `export-queue.js` 的下载出口。⚠️ **两处有意不复用**（理由写在脚本头）：
      ① **`harness.openInstance` 不可直接用** —— 它内嵌 `assertDevTarget(inst.url)`，对 Real 源直接抛错，
      与 D1.3「产包器不调用 E2E 守卫」冲突 ⇒ 改为**复用其组件**（自起持久化 context + 同样的就绪有界等待）；
      ② **不复用指针点击** —— 宿主 splash 与第三方模态弹窗会拦截指针事件（§11.11），工具改用
      **页内 `element.click()`**（不做命中测试，天然免疫），代价是**旋钮落盘前必须回读**（实测回读 8 项全对）。
      `installChatFilesysPromptGuard` 未导出且本路径不需要 ⇒ **未改 `e2e/lib/` 任何文件***
- [x] **3.3** 九步流程逐条落实（`design.md` D1.2 第 1–9 步），**每一步都是有界等待**（L1-MR-7）
      —— *九步全部落地；Dev 实跑时序：就绪 t+23 s → 拉取 t+23.7 s → 文件树确认 t+339.8 s →
      入区 t+339.9 s → 落盘 t+343.4 s。另补**长跑心跳**（每 20 s 打印百分比/阶段/待导出区计数）——
      首跑 t+23.7 s→t+339.8 s 全静默，用的人无从判断是「在跑」还是「挂了」* 
- [x] **3.4** ⚠️ **判可见用 `getBoundingClientRect`，不用 `offsetParent`**
      —— spec §11.1 实测：fixed 元素 `offsetParent` 恒为 `null`，会造成假「不可见」
      —— *已用 `getBoundingClientRect().width` 取读数。实测 `#btn-host-fetch` 是 `display:"flex"` 但
      **width:0**（插件抽屉未展开）——**这正是采用页内 click 的实证依据*** 
- [x] **3.5** **R-20 硬门禁**（`design.md` D1.4）：第 3 步读实例插件版本 vs 工作区 HEAD，
      **不一致即拒绝执行**并非零退出、提示先 `git pull`
      —— *已实现（`assertR20`）。Dev 实跑打印「R-20 过：实例插件 f75c68e == 工作区 f75c68e」*
- [x] **3.6** **端口纪律**（`design.md` D1.3，**不调用 `e2e/lib/guard.cjs`**，但继承其三条精神）：
  - [x] **3.6.1** `--source` **必填**且必须在登记表内，否则**启动时立即非零退出**
        —— *负例实测：无 `--source` ⇒ exit 2；未知 id ⇒ 报错并列出可用 id*
  - [x] **3.6.2** **不给默认值** —— 严禁 `?? 'dev-luker'` 这类兜底（兜底值就是误连入口）
        —— *`--source` / `--layout` 初值均为空串，无兜底（负例实测 exit 2）*
  - [x] **3.6.3** **禁止自动改写目标** —— 不得因「端口被占」回退到别的实例
        —— *脚本无任何端口回退逻辑；端口只从登记表读*
  - [x] **3.6.4** 拒绝 `8000`（L0-16）；**打印解析出的端口与 side（Dev/Real）**供人工核对
        —— *`assertSource()` 拒 8000；每跑首行打印 `id/side/host/port/url`（实测 `id=real-luker side=real port=8004`）*
- [x] **3.7** 产物出口：点待导出区条目的「下载」（`src/ui/export-queue.js` 的 `download(id)`
      → `triggerBlobDownload`），**捕获 Playwright `download` 事件** → `saveAs(--out)`
      —— *已实现并实测（1.2 GB 包能正常落盘）。⚠️ 踩点：`download.suggestedFilename` 在本版
      Playwright 是**方法不是属性** —— 当属性读拿到的是函数源码（首跑打印出了函数体）⇒ 已修*
- [x] **3.8** 产出读数 JSON（条目数 / 压缩后体积 / `sha256` / 源实例版本 / 插件版本）落 `research/`
      —— *已实现（默认落本任务 `research/`，`--readings-dir` 可覆盖）。Dev 读数落
      `research/produce-dev-luker-raw.json`。另把「入库记录清理」留痕：实测删掉 **3 条**同名残留
      （本轮只产出 1 个产物）⇒ 如实记录删了什么，**不静默删别人的东西*** 
- [x] **3.9** `--include-backups` **默认关**（沿用上一轮 U-4：`backups/` 不同步）
      —— *已实现（默认关）；`--raw` 模式会**强制打开**（pristine 透传的条件之一）并在输出明示*

## 4 写入前三道守卫（**必须在任何写入之前全部生效**，`design.md` D4.1）

- [ ] **4.1 链接守卫**：`lib/link-guard.cjs` —— 解析数据路径下的 symlink / junction，
      指向工作区仓的**默认跳过**，重跑须显式 `--allow-links`
      —— 这是 `P-19` 的防护（上一轮实测 **1090 条**穿透写进 `My-repo/ST-BgLoader`）
- [ ] **4.2 只读快照**：`node scripts/instance-sync/snapshot-manifest.cjs` 对**每个将被写入的目标**
      落 `research/pre-<target>-<ts>.json`（相对路径 + 大小 + mtime）
- [ ] **4.3 宿主源码禁改断言**（**新 `L0-1` 的硬约束，程序化而非靠自觉**）：
      写入前断言所有目标路径都落在「被宿主仓 `.gitignore` 覆盖」的范围内
      —— 判据 `git -C <实例仓> check-ignore -v <路径>` **有输出**；
      **任何一条落在源码面（无输出）⇒ 立即中止**
- [ ] **4.4** 三道守卫的读数落 `research/pre-write-guards.json`

## 5 搬运与灌入（**复用上一轮，不改语义**，`design.md` D4）

- [ ] **5.1** **Dev Luker `:8003` / Real Luker `:8004`**：`restore-luker.cjs`，
      宿主原生 `POST /api/users/restore-backup`，`mode=merge`
- [ ] **5.2** ⚠️ **ST settings 不得回归**（`design.md` D4.2，上一轮 J 事故）：
      `import-st.cjs` 的 settings 分支必须是**按目标键集的交集合并**。
      上一轮用并集把 Luker 的 27 个专有顶层键写进 ST ⇒ `settings.json` 从 **44 KB 膨胀到 113.7 MB**，
      ST 前端卡在「settings 未就绪」，**所有第三方扩展都不加载**（冒烟 53→50）。
      **只复用不重写**，并在 §6 加「`settings.json` 体积不得异常增长」的断言
- [ ] **5.3** **Dev ST `:8001` / Real ST `:8002`**：`import-st.cjs` 逐类目
      （原生端点 + 磁盘目录形态类目；ST 无整包导入）
- [ ] **5.4** **PT web `:8899`**：`import-pt.cjs`（**宿主数据管理面板，不是点设置抽屉**），
      `merge` 策略 + `slow` 方式；>100 MB 需 `--allow-large`
- [ ] **5.5** **TT**：`build-packs.cjs` 产物 + 导入说明 ⇒ **人工交付物**（C-3，无浏览器端口）
- [ ] **5.6** **零删除核对（逐目标）**：与 §4.2 的快照比对，确认**目标独有内容全部仍在**（含空目录）

## 6 核对（**判据必须显式，不得静默**，`design.md` D5）

- [ ] **6.1** 逐目标产出**差异核对读数**：源覆盖率（源有→目标有，按**路径**）+ 目标独有零删除证据
- [ ] **6.2** **不可达条目必须显式列出并从分母剔除**
      —— 宁可显式剔除，**不得静默算作已覆盖**
- [ ] **6.3** 单列不判项（链接子树内条目、宿主自管缓存等）**显式列入**，不参与判定
- [ ] **6.4** **PT 专用判据**（路径比对不可用，`design.md` D5.2 / spec §12.5 三条已实测判据）：
  - [ ] **6.4.1** 体积吻合（最可信）：PT 侧各模块体积合计 ≈ 源包未压缩量
        （上一轮 1161.6 MB ≈ 1.16 GB 精确吻合）
  - [ ] **6.4.2** 角色目录数：源 `chats/<角色>/` 目录数 == PT 计数（上一轮 23 == 23）
  - [ ] **6.4.3** 归一后的系列计数（上一轮 165 == 165）
  - [ ] **6.4.4** 装置：`node scripts/instance-sync/import-pt.cjs --report`（**只读出口**）
- [ ] **6.5** ⚠️ **计数口径纪律**（`design.md` D5.3，**本仓已栽 5 次**）：
      **对照之前先问「这两个数字量的是同一件事吗？」** 五条同形坑逐条自查：
      版本化 blob 条目数 ≠ 角色数；`card.name` 在 V3 卡里不是卡片名（在 `card.data.name`）；
      文件条目数 ≠ 聊天数（含 `.luker-state.*` / `runs/**`）；人类名条目里混有非卡片；
      源侧**落盘名** ≠ 卡片内 name。
      **核对脚本必须在内联注释里写清「这个数字量的是什么」**
- [ ] **6.6** **`settings.json` 体积断言**（5.2 的守护）：与 §4.2 快照比，不得异常增长
- [ ] **6.7** 全部读数落 `research/coverage-<target>.json` 与 `research/coverage-summary.json`

## 7 可重跑性与 E2E（AC-A2 / AC-A8 / 父任务 AC-P4）

- [ ] **7.1** **连续两次产包**，条目数与体积一致（确定性证据）
- [ ] **7.2** ⚠️ **陷阱处置**（`design.md` D6）：两次产包**连续执行**，
      并**同时记录源的 mtime 快照**（`data/default-user` 下文件的相对路径 + mtime 的哈希）。
      - 两次快照**一致**而产物不一致 ⇒ **真缺陷**，须修
      - 快照**不一致** ⇒ 读数**标注「源在期间变动」**，**不算失败**，并重跑
      - **这一条不写清楚，AC-A2 会变成假红或假绿**
- [ ] **7.3** E2E 产包 spec（若新增）：**连续两轮全绿**方可宣称可重跑
- [ ] **7.4** E2E 只连白名单 `{8001, 8003, 8899}`；Real 端口出现即**启动期抛错**
      （`e2e/lib/guard.cjs` 已有实现，17 项负例用例 —— **不修改、不放宽**）
- [ ] **7.5** 清初态纪律（spec §11.2）：要换源包先删 `workspace` store 的 `active_session`
      后**重载页面**；**只动 `workspace` store，不删 `files` store**（后者是用户既有数据）
- [ ] **7.6** 持久化环境里的断言一律用**增量**，不用绝对值

## 8 质量门（收口前必须全绿）

- [ ] **8.1** `npm test` 全绿**零回退**（对比 0.3 的基线）
- [ ] **8.2** 五条静态守卫 `exit=0`；`npm run build` 通过
- [ ] **8.3** `npm run e2e` **exit 0**，且**连续两轮全绿**
- [ ] **8.4** **R-20 复核**：本任务若改了插件代码 ⇒ 更新实例后再跑 8.3，并记录实例版本
- [ ] **8.5** `git status --short` 复核：**无计划外文件**；`test-results/` / `research/` 未入库
- [ ] **8.6** **零凭据入库**复核：提交前确认无本地绝对路径、无 token、无真实聊天数据
- [ ] **8.7** 逐条勾选本文件的**全部**复选框（**实时勾选**，不得事后补）

## 9 规范落库与收口

- [ ] **9.1** 规范落 `.trellis/spec/`（**自包含**，内联读数与 `file:line`，**不得**写「详见任务目录」）：
      - **插件驱动产包器的契约**（九步流程 + 产物出口 + 读数形态）
      - **端口纪律的分层**：登记表是唯一定义点，守卫是 **E2E 的**使用限制，
        产包器是另一个消费者 —— **各有各的使用限制，不是两份端口表**
      - **R-20 程序化**：把「实例插件版本 == 工作区」做成硬门禁（而非提醒）
      - `design.md` D6 的**可重跑性判据**（mtime 快照配对，避免假红/假绿）
      - 写入前三道守卫的**顺序**（备份 → 快照 → 源码面断言）
- [ ] **9.2** 更新对应 spec 索引（若新增文件）
- [ ] **9.3** 残留登记：OQ-2 若判定「不成立」的实测理由、不可达条目清单、任何单列不判项
- [ ] **9.4** 提交（**显式 pathspec**，L0-7(2)）：`git diff --staged --name-only` **恰等于**目标文件集，
      推送 `origin`（**不推 upstream**）
- [ ] **9.5** 在父任务 `prd.md` 的 AC-P2 / AC-P3 / AC-P4 上回填读数

## 本轮进度快照（2026-09-29 13:50 收尾）

> 用途：本任务跨会话续做的**唯一权威状态**。`research/*.json` 被 `.gitignore:59` 覆盖
> ⇒ **不入版本库**，细节读数只在本机；本节的结论与路径才是可跨机延续的部分。

### 已完成

- **§0 全部**（基线 `npm test` 610 passed / E2E 281/281 / 五守卫 EXIT=0 / 四实例在听）
- **§1.3 全部**（四实例 `git pull` 到 `f75c68e`；`origin` 均本仓；读数 `research/instance-plugin-versions.json`）
- **§2 全部**（Real Luker `1605.3 MB / 8698 条 / sha256 de2bc789…`；Dev Luker `1213.0 MB / 8061 条 / sha256 5cadfa39…`；读数 `research/backup-records.json`）
- **§3 全部**（产包器已落并经实跑验证；见上方 §3 逐条）
- **§1.2 全部 —— OQ-1/OQ-3 判定 `IDENTICAL`**：插件原样产物 vs 宿主原生备份
  **8060/8061 条逐条 `crc32` 全等**（仅 Host 请求期 `manifest.json` 的时间戳不同，已单列）。
  读数 `research/plugin-vs-native-backup.json` + `research/oq1-native-backup-notes.json`
- **§1.1 部分 —— OQ-2 目标 `l` 已实测（结论见下）**：Dev Luker 三布局的**对照侧**
  （`build-packs` 基线，源 = 插件自己的原样包 ⇒ **两侧同源、零漂移**）已产出；
  插件侧 `l` 已产并比对，`st` 在跑，`tt` 未开始

### OQ-2 实测结论（目标 `l`，2026-09-29）

**条目级：6561/6562 条逐条 `crc32` 全等；0 条仅 A、0 条仅 B。唯一差异是根 `manifest.json`。**

⚠️ **这条差异**不是**请求期时间戳** —— 解包核验后发现两侧 `createdAt` **都是** `FIXED_TIMESTAMP`
（`2020-01-01T00:00:00.000Z`），真正不同的是 **`selection` 字段**：

| 侧 | `globalExtensions` | `vectors` |
| --- | --- | --- |
| 插件产物 | **false** | **false** |
| `build-packs` 基线 | true | true |

**归因**：`build-packs` 不传 `selection` ⇒ 取 `L_SELECTION`（`transform.js:223-234`，10 键全 true）；
而插件把**它自己实际用的 selection** 记进去 —— 实测为 `globalExtensions:false, vectors:false`
（与宿主原生备份 `manifest.json` 里记的**同一组**值一致，见 OQ-1 的读数）。

⇒ **这就是 OQ-2 的意义所在**：转换器本身一步直出是等价的（6561 条字节级全同），
但**两侧的 selection 口径并不天然一致**，它会被写进产物元数据。
同步链若采纳一步直出，**必须显式对齐 selection**，不能吃某一侧的默认。

> **一处被推翻的自测预测（如实登记）**：定稿前的预测是「三目标都应 IDENTICAL，因为
> `manifest.json` 用 `FIXED_TIMESTAMP`」。**预测部分正确（时间戳确实是固定的）、部分错误
> （差异另有其因）**。而且第一版比对器把 `manifest.json` **按文件名整条豁免**，
> 差点把这条实质差异**吃掉**——正是本仓 spec §7.3 记的「白名单会一路长大到把判定吃光」。
> 已修为**字段级判定**（仅当差异**只**落在 `createdAt` 这类请求期字段上才豁免，
> 否则照实计入并报出**具体字段名**）；修后 `--self-test` 仍 IDENTICAL、OQ-1 仍正确豁免。


### 本轮新增的两件交品物（入库）

| 文件 | 作用 |
| --- | --- |
| `scripts/instance-sync/produce-via-plugin.cjs` | 插件驱动产包器（§3 的全部契约；含 R-20 硬门禁、端口纪律、`--deselect` 类目收窄） |
| `scripts/instance-sync/diff-packs.cjs` | 包↔包**条目级**比对（路径集合 + 逐条 `crc32`；含 `--self-test` 自检与请求期元数据单列） |

### 一条**新的功能性发现**（阻塞级，已绕开，未定位根因）

**插件在浏览器里拉取含 GB 级 `backups/` 的宿主包时会功能性停滞**：真源 Real Luker
实测 `已接收 1281.9 MB` 之后**连续 140 s 零字节**；而**同一端点**经 Node 侧流式接收
337.5 s 就收完 1605.3 MB。⇒ 是**浏览器路径**的问题，不是端点。
**影响**：不 `--deselect settings`（Luker 的 `settings` 隐含打包 `backups/`）时，
本工具在真源上**不可用**。已实现 `--deselect` 绕开；根因（OPFS 写入 / checkpoint / 流式背压）
**未定位**，留作后续。细节与实测序列见 `research/browser-fetch-stall-and-run-log.json`。

### 待续（下一轮从这里接）

1. **§1.1 收口（剩两个目标）**：`--source dev-luker --layout st` 与 `--layout tt` 的产包 + 比对
   ⇒ 落 `research/one-step-layout-st.json` / `-tt.json`。
   按 `l` 的实测推断，差异应当**同样只落在 `manifest.json` 的 `selection`**（`st`/`tt` 目标不合成
   `manifest.json`，故也可能**完全一致**）；**以实测为准，不要照抄这条推断**。
2. **下一步的关键决策（需用户裁定）**：一步直出若采纳，`selection` 口径必须显式对齐
   —— 是「插件侧按宿主默认收窄」还是「`build-packs` 侧补上同样的 selection」，
   两条路产出不同元数据，且影响下游（`globalExtensions`/`vectors` 是否入包）。
   这是 §1.4 评审门要问的第一件事。
3. **A1.2 的真源要求**：本轮 OQ-2 在 Dev Luker 上做（§1.1.1 明文允许「先用 Dev 走通」）；
   **真源 Real Luker 的插件产包尚未跑通**（被上面那条停滞挡住）。下一轮用
   `--deselect settings` 在 `:8004` 补做，并对齐基线源（真源可用
   `--source real-luker --layout l --raw --deselect settings` 快速取得同源基线）。
4. **§1.4 评审门**：把 1.1/1.2 结论回报用户、确认「一步直出」是否采纳（**尚未开**）。
5. **§4–§6**：三道写入前守卫、搬运灌入、核对（**尚未开始**；§5 写入是唯一不可逆环节）。
6. **§7–§9**：可重跑性（AC-A2 需连续两次产包 + 源 mtime 快照配对）、质量门、规范落库。
   ⚠️ 其中「**插件的 selection 可能被持久化档案恢复**」是一条**尚未查证的嫌疑**
   （`restoreWorkspaceState` 里确有 `setSelectionState(savedState.selection)`，
   且本轮读数记的 `globalExtensions:false` 与模块默认的 `true` **不一致**）
   ⇒ AC-A2 的可重跑性必须先查证这一点（做法：清 `active_session` 前后各跑一次，比对 selection 回读）。

### 本轮**未**触碰的边界（如实登记）

- `src/**` **零改动**、`e2e/**` **零改动**、`e2e/lib/guard.cjs` 未放宽
- 未执行任何**写入实例**的动作（§4–§6 未开始）⇒ 四实例的数据与插件以外内容均未变
- 实例上只做了两件事：① 插件目录 `git pull`（§1.3，U-5 授权）；② 只读拉取（宿主备份 + 插件产包）

## 回滚点

| 点 | 回滚动作 |
| --- | --- |
| 产包器实现有缺陷 | 删 `scripts/instance-sync/produce-via-plugin.cjs` ⇒ 回到「Node 侧原生端点产包」（上一轮已验证的路径） |
| 一步直出（§1.1）不成立 | 沿用 `build-packs.cjs`（既有、已验证）；**无回滚必要**，只是少一条优化 |
| 写入前三道守卫任一条报红 | **中止写入**，排查后重跑；`link-guard` 报红时**不得**用 `--allow-links` 绕过，须先人工确认 |
| ST settings 膨胀 | 写入前快照可定位；`test-results/settings-repair-backups/`（上一轮留底）+ `repair-settings-merge.cjs` |
| Luker 写入出错 | 用 §2 的宿主原生备份回滚（**Dev Luker 本轮才有回滚能力**） |
| ST 两处写入出错 | **无回滚能力**（U-3 登记为已知接受风险）；缓解 = `merge` 不删独有 + 快照定位 |
| 全部 | 本任务改动面 = **1 个新脚本（+ 可能的 `lib/` 小件）+ 1 个可能的 E2E spec**；`src/**` **零改动** ⇒ `git revert` 一次提交即可 |

## 与兄弟任务的边界（**不越界**）

| 不做 | 归属 |
| --- | --- |
| R-16 / R-17 / R-19 三条插件缺陷 | **子任务 B** `09-27-plugin-defect-fixes` |
| 常驻 watcher / 定时守护 | U-2 已排除（`design.md` D8） |
| 插件内跨实例推送 | 同源限制做不到（`L1-MR-1`） |
| 修改 `e2e/lib/guard.cjs`、放宽 E2E 目标 | U-7：E2E 仍只连 Dev |
| 清理实例历史数据 / 空目录 | 上一轮 R-8 / R-9，须另走 PARDON |
