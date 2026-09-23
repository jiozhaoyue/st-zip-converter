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
  - `extensionMode = 'full'`（缺省）则直通打包扩展代码。

### 4. 备份聊天记录与快照过滤机制 (Backup Chats & Snapshot Filtering)
- **过滤规则 (`src/core/inspect.js:isBackupChatOrSnapshot`)**:
  - 匹配 `backups/` 目录下的所有系统快照文件。
  - 匹配 `chats/` 与 `group chats/` 下带有备份标识的文件：如 `*_backup.jsonl`, `backup_*.jsonl`, `*.bak`, `*.backup`, `*(backup)*.jsonl` 等。
- **行为约定**:
  - 宿主直接导出面板（Host Export）与外部 ZIP 转换面板（External Convert）均默认**不勾选**导出备份聊天记录。
  - 必须由用户显式勾选后才允许包含入包，从源头清理数倍于有效对话的废弃备份堆积。

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
