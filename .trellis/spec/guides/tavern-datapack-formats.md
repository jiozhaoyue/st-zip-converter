# 酒馆系数据包格式与互转(跨任务知识)

> 做任何涉及四平台数据搬移的任务,先读本文件再动手。
>
> **证据分级**(本文件所有断言按此三类标注):
> - **〔仓内〕** 可在本仓代码/测试里直接核对(附 `file:line`)。
> - **〔镜像〕** 上游平台行为,本仓以测试镜像其规则(`test/real-samples.test.js`)。
> - **〔待验证〕** 既非仓内代码也非镜像测试可证 —— 已写明验证方法,不得当作既定事实引用。
>
> 上游行为的原始调研记录在归档任务
> `.trellis/tasks/archive/2026-09/09-01-cross-tavern-datapack/research/platform-facts.md`。
> 布局/路由的**仓内**权威实现是 `src/core/detect.js`、`src/core/transform.js`、
> `src/core/splitter.js`、`src/core/delta.js` 与 `test/real-samples.test.js`。

## 包布局速查

- **ST**〔仓内 `src/core/detect.js:3-9,76`〕:zip 根摊平 ST 用户目录(有 `characters/` 或
  `settings.json` 即判定 st),无 manifest;官方备份默认排除 secrets.json。
- **L**〔仓内 `detect.js:70`〕:同 ST 摊平 + 根 `manifest.json` 带 `schemaVersion` + `selection`
  (另有 `handle`,可作 handle 线索)。
- **TT**〔仓内 `detect.js:11-13,72`〕:`data/` 根,用户数据在 `data/default-user/`,
  TT 私有在 `data/_tauritavern/`(extension-sources / mcp / skills / window-state)
  + `data/_cache` / `_css` / `_errors`。
- **PT**〔仓内 `detect.js:65-68`〕:自家归档(根 manifest 带 `format` 或 `files[].moduleId`)
  判定为 `LAYOUTS.PT_NATIVE`,**v1 不支持** —— `convert()` 直接抛错要求改导 TT 迁移包;
  PT 目标的产物走 TT 布局(`data/default-user/`)。

## 导入语义(最易踩的坑)

1. **L 恢复不解析包内 manifest.json**〔镜像 `test/real-samples.test.js` 的 `lResolves` —— 它显式
   跳过 `manifest.json`〕:selection 来自恢复请求,条目按“路径后缀”匹配目标目录
   (`test/real-samples.test.js` 的 `L_FILES` / `L_DIRS` / `L_GLOBAL_EXTENSION_ALIASES`)→
   未知文件安全跳过,`data/default-user/` 前缀的包也能直接吃(这就是 tt→l 能通的原因)。
2. **L 备份类目映射**〔镜像 `test/real-samples.test.js` 的 `L_DIRS`〕:settings 类目含
   `backups/` 目录;assets 含 `user/files|images|workflows`;`extensions/`(用户级)属于
   selection.extensions;`image-metadata.json` 不在任何类目 → L 目标侧直接丢弃
   〔仓内 `src/core/transform.js:418-422`〕。
3. **PT 目录表没有 `extensions/`**〔镜像 `test/real-samples.test.js` 的 `classifyPtEntry`〕:
   `data/default-user/extensions/**` 会被 PT 丢弃;第三方扩展只认
   `data/extensions/third-party/<name>/` 且必须有来源记录
   (`data/_tauritavern/extension-sources/<scope>/<name>.json`,或扩展自身 manifest 的
   `homePage`,须 https),否则跳过并警告 —— 这是设计(重装式迁移),不是 bug。转换器为此自动把
   用户级 `extensions/<name>/` 迁移为 third-party 布局并合成来源记录
   〔仓内 `transform.js` 的 `userExtensionsMigrated` / `extensionSources` / `buildExtensionSources`〕。
4. **PT 摊平布局整包不可见**〔待验证〕:原始调研称 PT 对摊平布局 `readUserPath` 返回 null。
   验证方法:在 Dev PT 实例导入一个摊平布局包,观察是否报错/空导入。
5. **Method 93 (Zstandard) 条目**〔仓内 `src/core/zip-io.js`〕:TauriTavern / 7-Zip ZS 的 zstd 条目
   由 `src/vendor/fzstd.js` 注册为 zip.js codec,读包时透明解压并记日志。
   (旧文档提到的“zip.js wasm 内联 + esbuild 整体打包”已不适用 —— 本项目已无 esbuild 构建环节。)

## 转换工具的既有约定(本仓库)

- hub 布局 = ST 摊平;`data/default-user/` 前缀进出;TT 私有/派生默认丢弃(`keepAll` 保留)。
- PT/TT 目标:用户级 `extensions/<name>/` 自动迁移为 third-party 布局 + 合成来源记录
  (homePage 兜底),与 third-party 同名时保留第三方副本;third-party 根下散文件丢弃。
- L 目标:`image-metadata.json` 丢弃(L 类目不含);`_engine_dump.bin` / `_engine_meta.json`
  仅 L→L 透传,其余目标丢弃并写入警告〔仓内 `transform.js` 的 `ENGINE_DUMP_ENTRIES` / `sawEngineDump`〕。
- **IO 统一门面**:只有 `src/core/zip-io.js` 的 `zipIo` 一个适配器(封装 `src/vendor/zip.js` +
  `src/vendor/fzstd.js`)。`convert()` 保留 `io` 注入接缝(缺省即 `zipIo`,契约
  `{ openReader, createWriter }`),但**不存在** Node/浏览器双实现,也**没有**产物同构对拍测试;
  旧的 `yauzl`/`yazl`、`src/io/node-io.js`、`src/io/zipjs-io.js`、`test/zipjs-io.test.js` 均已删除。
- **合成条目命名空间**:扩展清单与安装物料统一在 `_convert/` 下
  (`_convert/extensions-manifest.json`、`_convert/INSTALL.md`、`_convert/meta.json`),
  官方 Content 下载索引 `extensions-index.json` 在包根(`transform.js` 尾部合成块 `emitSynthesized`)。
- secrets 任何方向不剥离(用户硬性要求),产物含 API 密钥属预期。

## 增量与分包扩展规范 (Sessions 12-14)

### 1. 外部基准增量补丁包 (Base-ZIP Delta Patch)
- **触发机制**: 必须在 UI 中预先选定已有基准归档（Base-ZIP，支持从本地文件选取或从 IndexedDB 历史归档列表选取）。
- **对比维度**: 逐条目比对 `fileName`、`uncompressedSize`、`crc32`。
- **产物结构**:
  - 仅打包在基准包中**不存在**（added）或内容变更（modified）的条目。
  - 包根注入审计清单 `_delta_manifest.json`〔仓内 `src/core/delta.js` 的 `generateDeltaArchive`〕:
    ```json
    {
      "generator": "st-zip-converter",
      "type": "delta-patch",
      "version": "1.0.0",
      "createdAt": "ISO-8601",
      "baseArchiveName": "<基准包文件名>",
      "stats": { "addedCount": 12, "modifiedCount": 3, "unchangedCount": 1500,
                 "deletedCount": 1, "totalChanges": 15 },
      "changes": { "added": ["characters/new.png"], "modified": ["settings.json"],
                   "deleted": ["old.txt"] }
    }
    ```
  - 清单只记**路径与计数**,不含逐条目 size/crc32;`deleted` 仅被记录,
    不会写入产物(增量包不含删除指令)。
- **价值**: 避免数 GB 庞大酒馆包在每次备份或迁移时重复传输全量不变资源（如海量立绘与静态资源），生成几 KB~几 MB 的紧凑增量包。

### 2. 智能独立切片分包格式 (Independent Split Multi-Volume Zip)
- **核心原则**: 严禁生成 `z01, z02` 或 `.part1.rar` 这一类必须全部集齐才能解压的断裂分卷。每个分卷**必须且只能是自包含的合法标准 ZIP 包**。
- **切片策略 (`src/core/splitter.js`)**〔仓内〕:
  - 阈值 `thresholdMB`（缺省 100MB），实际字节上限再乘 `SAFETY_MARGIN = 0.95`。
  - 条目先按优先级排序（`getEntryPriority`：1 核心文本/角色/聊天 → 2 扩展代码 → 3 媒体大资产），
    同优先级按路径字典序，再贪心装箱。
  - 超大单文件独占一卷，并置 `isOversized = true`。
  - 判定依据是**未压缩累计字节**，而分卷实际大小是压缩后 `blob.size` —— 可压缩文本条目会
    明显小于阈值（多切几卷）；`STORE_EXTENSIONS`（level 0 直存）条目则估算准确。
- **卷内清单 `_convert/split-manifest.json`**〔仓内 `splitter.js:107-121`〕:
  - **注意是 `_convert/` 目录下、名字带连字符**（旧文档写的 `_split_manifest.json` 不存在）。
  - 每卷各自写入一份，字段：`splitId` / `partIndex` / `partLabel` / `thresholdMB` /
    `thresholdBytes` / `fileCount` / `isOversized` / `files` / `generatedAt`。
  - **没有** `groupId` / `totalParts` / 逐条目哈希：卷间关联靠 `splitId` 与文件名模板
    （`resolveFilename` 的 `part` 变量 → Part 1/2/3…）。

### 3. 扩展轻量清单模式 (Extension Manifest Mode)
- **云端 408 痛点**: 大型扩展（如向量数据库、复杂 UI 扩展）其 `.git` 目录体积常达数百 MB，上传至云端反代常遭遇 HTTP 408 超时失败。
- **现行机制**〔仓内 `src/core/transform.js` 的 `EXTENSION_MODES` / `emitSynthesized`，
  对应 `transform.js` 主循环中 `extensionMode !== EXTENSION_MODES.MANIFEST` 的分支〕:
  - `extensionMode = 'manifest'`（**仅 ST / L 目标**生效）下，扩展实体文件一律不入包，
    仅解析并保留：`.git/config`（remote url）、`.git/HEAD`（分支）、
    `.git/refs/heads/<branch>`（commit，40 位 hex）以及扩展自身 `manifest.json`。
  - 产物：包根 `extensions-index.json`（兼容 ST 官方 Content Downloader 规范）+
    `_convert/extensions-manifest.json`（转换器结构化清单，供宿主插件自动呼出扩展安装面板）。
  - **不存在**“剥离 `.git` 历史 / Shallow Git 转换”这一能力——旧文档描述的浅层快照未实现；
    轻量模式的本质是**不打包实体**，由目标酒馆按清单重新克隆/拉取。
    > **2026-09-25 更正**：本句此前成立，现已**作废**——`gitMode`（见下文 §5）已实现
    > 「保留一键更新能力前提下剥离 `.git` 对象存储」的能力。轻量清单模式与 `gitMode` 是
    > **互补**关系：前者解决「不打包实体」，后者解决「打包实体时历史体积过大」。
  - `extensionMode = 'full'`（缺省）则直通打包扩展代码。

### 4. 备份聊天记录与快照过滤机制 (Backup Chats & Snapshot Filtering)
- **过滤规则 (`src/core/inspect.js:isBackupChatOrSnapshot`)**:
  - 匹配 `backups/` 目录下的所有系统快照文件。
  - 匹配 `chats/` 与 `group chats/` 下带有备份标识的文件：如 `*_backup.jsonl`, `backup_*.jsonl`, `*.bak`, `*.backup`, `*(backup)*.jsonl` 等。
- **行为约定**:
  - 宿主直接导出面板（Host Export）与外部 ZIP 转换面板（External Convert）均默认**不勾选**导出备份聊天记录。
  - 必须由用户显式勾选后才允许包含入包，从源头清理数倍于有效对话的废弃备份堆积。

### 5. 扩展 `.git` 历史策略 (gitMode) — 2026-09-25 落地

**问题**：真实用户包 503 MB 里 **464 MB 是扩展 `.git` 的 packfile**——`git clone` 未加 `--depth 1`，
且历史提交过的音视频/大文件即使已删也永久留在 packfile 里。`isJunkOrDevFile()` 只剔
`.git/logs/`、`.git/hooks/`、`.git/refs/original/`，**packfile 必然全量直通**。

**契约**（`src/core/transform.js` 的 `GIT_MODES`，默认 `keep`）：

| 策略 | 包内保留的 `.git` | `checkIsRepo` | `branch()` | `pull()` | 首次更新前 `status` |
| --- | --- | --- | --- | --- | --- |
| `keep` | 全部条目 | ✅ | ✅ | ✅ | ✅ |
| `minimal` | 下列白名单 + 合成的 `objects/.keep` | ✅ | ✅ | ✅（自动补齐对象，之后自愈为完整仓库） | ❌ `fatal: bad object HEAD` |
| `strip` | 无 | ❌ 不认仓库 | — | — | — |

`minimal` 的**确切保留集**（多一条少一条都算违约）：
`.git/config`、`.git/HEAD`、`.git/index`、`.git/refs/heads/**`，外加**合成**的 `.git/objects/.keep`。

**为什么必须有 `.keep`（本策略的命门，缺它则 minimal 与 strip 等价）**：
git 的 `is_git_directory()` 要求 `.git/objects` 与 `.git/refs` 是**真实存在的目录**；
而本项目管线**丢弃空目录条目**（`src/core/zip-io.js:101` `filter((e) => !e.directory)`、
`:111` `if (entry.directory) continue`）。故只能用**一个普通文件**把 `objects/` 目录「撑」住。
占位内容非 0 字节（个别解压实现会跳过零长度条目）。`git fsck` 对该文件无告警（实测 rc=0）。

**实测取证**（两处，均可复现）：
1. **git 二进制层**（临时目录）：只留 config/HEAD/refs 而**无** objects/refs 目录 →
   `rev-parse --is-inside-work-tree` rc=128（判为非仓库）；补上 `index` 与 `objects/.keep` 后，
   三条命令全过，`pull` 快进成功且新文件内容正确，更新后 `status` 干净、`fsck` 无告警。
2. **Dev Luker 8003 实例往返**（2026-09-25，任务 `09-22-extension-git-slim`）：
   3.02 MB 源包 → minimal 产物 **3592 B**（剔除 3 150 682 B）；
   经宿主原生恢复接口落盘后 **`.git/objects/.keep` 被保留**；
   实例目录内 `is-inside-work-tree=true`、`branch=* main`、
   `git pull origin main` **rc=0 快进成功并拉到上游新提交**，更新后 `.git` 文件数 5→22、
   `status` 空、`fsck` 无输出。详见该任务 `research/dev-instance-roundtrip.md`。

**已知局限（必须如实告知用户）**：
`minimal` 下**接收方必须能联网**——对象存储已被剔除，首次「检查更新」要从 origin 重新拉取；
且首次更新**之前**该扩展的 `git status` 不可读（`bad object HEAD`）。宿主的更新链路
（`checkIsRepo` → `branch` → `pull`，见 `src/endpoints/extensions.js:686-704`）不调用 `status`，
故不受影响。完全离线的接收方应选 `keep` 或 `strip`。

**实现落点**（改这块时一并看这些位置）：
- `src/core/transform.js`：`GIT_MODES` / `isGitEntry()` / `isGitMinimalKept()` / `normalizeGitMode()`
  / `gitDropReason()` / `GIT_KEEP_PLACEHOLDER`；三个 Git 元数据处理器改为三分支
  （MANIFEST / 不保留 / 写出），**解析逻辑在三档下都必须执行**（`extensionGitMeta` 照常产出）；
  `emitSynthesized()` 内合成 `.keep`。
- `src/core/report.js`：`dropped(hubPath, reason, bytes)` 第三参可选（向后兼容），桶内 `droppedBytes`。
- `src/core/plan-preview.js`：动作链分支插在 **MANIFEST 分支之后、扩展 MIGRATE 分支之前**。
- `src/ui/workbench-template.js` + `index.js`：I 区单选框（`name="git-mode"`），
  **复用既有 `.ext-mode-row`/`.ext-mode-opt` 类，不新增 CSS**；`manifest` 模式下联动 `disabled`。
- `scripts/control-consumer-guard.js`：该组无 id，声明键为 `name:git-mode`。

## 环境教训

- 本机(开发机)无 MSVC 链接器(VS2022 目录为空),`cargo test` 无法链接——TT 的 Rust 侧
  (Real/TauriTavern/src-tauri/crates,含 tt-adapter-archive 的 import/layout.rs)验证只能靠
  往返 CRC 测试或实机导入;只查 `--version` 不代表工具链可用。
- **zip 读游标不可倒回**(旧 yauzl 时代的教训在 zip.js 上同样成立):一次 `openReader` 的条目
  迭代只能消费一次,所以“检测布局”与“主循环转换”必须**各开一次 reader**
  〔仓内 `src/core/transform.js` 中 `io.openReader(sourcePath)` 的两次调用〕。
- **写侧背压**:不得“逐条目读成 Buffer 再一次性 add”——旧 Node 实现在真实大包下把待压缩数据
  积压到峰值 884MiB。现行做法是 `zipIo` 的并发滑动窗口（`CONCURRENCY` 2–8）+ `waitForSlot` 背压,
  配合 vendor 内部 `CompressionStream`,峰值与包体积无关〔仓内 `src/core/zip-io.js` 头注释〕。
- **宿主恢复端点矩阵**（2026-09-25 **认证态**黑盒实测；本节此前有两处错误记载，见下）：
  - **Luker 2.7.0**：`/api/users/restore` → **404**（无此路由）；
    `/api/users/restore-backup` → **存在**（空体 POST → `400 {"error":"Missing required fields"}`）；
    带 `avatar` + `handle` + `mode=merge` + `incremental=true` → **200**，响应含
    `{mode, restoredCount, failedCount, skippedCount, rejectedCount, preflight:{categoryStats…}}`。
  - **SillyTavern 1.19.0**：`/api/users/restore` 与 `/api/users/restore-backup` **均为 404**
    ⇒ **ST 不提供整包恢复能力**（`src/endpoints/users-private.js` 仅注册
    logout/me/change-avatar/change-password/backup/reset-*/change-name；前端
    `public/scripts/user.js` 只调 `/api/users/backup` 做导出）。
  - **判定方法（可复核）**：认证态**空体 POST** 判存在性——路由存在 → `400`（拒绝请求，
    **不写任何数据**）；不存在 → `404`；无 CSRF → `403`。对照实验（Dev ST 8001）：
    `POST /api/users/backup`（已知存在）→ 400、构造不存在路径 → 404、不带 CSRF → 403。
- **两处既有错误记载（已更正，勿再引用旧文）**：
  1. `/api/users/me` 在 Luker **不是 404**：认证态实测 **200**（`{"handle":"default-user",…}`）。
     旧记载来自**匿名上下文**（`enableUserAccounts: true` 时匿名一律 403/被重定向），不构成结论
     ——这也正好解释 `fetchHostBackup`（`host-bridge.js` 内同样调 `getHandle()`）在 Luker 为何可用。
  2. 旧文称「插件在 Luker 下会**隐藏**恢复按钮（`#btn-restore-luker` = `display:none`）」
     **与现状相反**：`index.js` 的 `computeActionAvailability()` 里 `restore.visible` **无平台项**
     （仅 `isHost && hasArtifact`），模板里的 `display:none` 只是首屏初始态。
     该按钮在 Luker 上**可达**，另一入口是待导出区每行的「写回宿主」。
- **恢复端点解析契约**（落在 `src/ui/host-bridge.js`，2026-09-25 实现）：
  - 候选序 `luker → ['/api/users/restore-backup', '/api/users/restore']`、
    `st → ['/api/users/restore', '/api/users/restore-backup']`；命中结果**会话内缓存**（不持久化，
    刷新页面即重新探测）。
  - **仅 `404/405` 才回退下一候选**；非 404 失败（超时 / 5xx / 413 / 网络中断 / 取消）一律
    **不换端点**——那些情况下请求可能已被宿主处理，换端点重试 = 对同一用户目录**重复写入**。
  - 全候选 `404/405` ⇒ 判定「本宿主无整包恢复能力」（ST 即如此）：会话内记忆 + **禁用恢复入口**
    + 说明「请改用宿主原生方式导入」，**不得**留下点了必然失败的按钮，也**不得**报假成功。
- **恢复 payload 的两个坑**：
  - `selection` 恒**显式传**（全类目）：宿主响应里 `skippedCount` 会把非类目文件（如
    `manifest.json`）计入，属正常跳过。实测缺省 `selection` 时 Luker **亦**按全量处理，
    故显式传的目的是**不依赖未文档化的缺省行为**，与 Luker 自身 UI
    （`public/scripts/user.js`）与同类扩展 Atria 的 payload 对齐——不是「修 bug」。
  - **`200` 不等于「有写入」**：条目全部被跳过时宿主返回 `200 + restoredCount: 0`。
    本仓据此在 `restoreToHostInner` 内对 `restoredCount===0 && skippedCount>0` 标记
    `nothingRestored`，单条与批量路径都按「未写入」处置，不谎报成功。
- **类目目录名 ≠ 类目名（造探针包必看）**：宿主里 lorebook 的目录是 **`worlds/`**，
  `lorebooks` 只是**类目名**（`src/core/inspect.js`：`hubPath.startsWith('worlds/')`
  → `CATEGORIES.LOREBOOKS`）。2026-09-25 曾把探针包写成 `lorebooks/x.json`，
  得到 `200 + restoredCount: 0`（skip 原因 `path_not_in_selected_categories`）
  并被**误判**为「宿主静默空恢复」——教训：**先怀疑包的路径/类目，再怀疑代码**。
- **宿主请求的 CSRF 与会话绑定**：只带 `X-CSRF-Token` 而不带会话 cookie 会 403
  `Invalid CSRF token`；必须先用 GET 取到 cookie 再带令牌。若实例开了 `enableUserAccounts`，
  **匿名请求一律 403**（即使 `basicAuthMode: false`）——脚本化验收必须借已登录的浏览器会话上下文
  （本机 Dev 用 `playwright` + `.pw-profile-dev` 持久化档案副本，**不要直接用原档案**，避免与在跑的
  Chrome 争抢锁）。无头环境下宿主扩展菜单可能不渲染（`extBlocks: 0`），此时以
  `POST /api/extensions/discover`（扩展管理 UI 的数据源）作为界面侧取证。
  - **实例 `git pull` 后必须重启进程**（2026-09-25 实测教训）：只更新磁盘代码而不重启，
    会出现「服务端跑旧代码 + 浏览器加载新静态资源」的错配，浏览器端表现为**持续**
    `Invalid CSRF token. Please refresh the page and try again.`，且重启前用新页面仍可能偶然成功
    ——排查时先比对「进程启动时间 vs 代码更新时间」。
  - `getContext().getRequestHeaders()['X-CSRF-Token']` 与 `GET /csrf-token` 返回**同一令牌**
    （2026-09-25 两宿主实测），二者皆可作令牌来源。
