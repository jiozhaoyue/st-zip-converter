# 酒馆系数据包格式与互转(跨任务知识)

> 来源:09-01-cross-tavern-datapack 任务的读码调研(全部结论有 file:line 证据,见任务
> research/platform-facts.md)。做任何涉及四平台数据搬移的后续任务,先读本文件再动手。

## 包布局速查

- **ST**:zip 根摊平 ST 用户目录,无 manifest;官方备份默认排除 secrets.json。
- **L**:同 ST 摊平 + `manifest.json` `{schemaVersion:1, createdAt, handle, selection}`(src/users.js:1496)。
- **TT**:`data/` 根,用户数据在 `data/default-user/`,TT 私有在 `data/_tauritavern/`(extension-sources/mcp/skills/window-state)+ `data/_cache _css _errors`。
- **PT**:自家归档(per-file moduleId/sha256 清单)或 TT 布局;**摊平布局整包不可见**(readUserPath 返回 null)。

## 导入语义(最易踩的坑)

1. **L 恢复不解析包内 manifest.json**(users-private.js:311 显式跳过),selection 来自恢复请求;条目按"路径后缀"匹配目标目录 → 未知文件安全跳过,`data/default-user/` 前缀的包也能直接吃(这就是 tt→l 能通的原因)。
2. **L 备份类目映射**(users.js getUserBackupTargets:1363):settings 类目含 `backups/` 目录;assets 含 `user/files|images|workflows`;`extensions/`(用户级)属于 selection.extensions;`image-metadata.json` 不在任何类目 → L 备份天然不含它。
3. **PT 目录表没有 `extensions/`**(tauri-tavern data-tree.ts):default-user/extensions/** 会被 PT 丢弃;第三方扩展只认 `data/extensions/third-party/<name>/` 且必须有来源记录(extension-sources 或 manifest homePage,须 https),否则跳过并警告 —— 这是设计(重装式迁移),不是 bug。
4. **PT 的 wasm/流式细节**:zip.js v2.9 wasm 以 base64 内联,可整体 esbuild 打包;ZipReader 必须显式包 BlobReader。

## 转换工具的既有约定(本仓库)

- hub 布局 = ST 摊平;`data/default-user/` 前缀进出;TT 私有/派生默认丢弃(`--keep-all` 保留)。
- PT 目标:用户级 `extensions/<name>/` 自动迁移为 third-party 布局 + 合成来源记录(homePage 兜底),同名冲突保留第三方副本;third-party 根下散文件丢弃。
- L 目标:`image-metadata.json` 丢弃(L 类目不含);`_engine_dump.bin/_engine_meta.json` 仅 L→L 透传。
- IO 适配器注入:node-io(yauzl/yazl)与 zipjs-io(zip.js)必须产物同构(test/zipjs-io.test.js 逐条目 MD5 把关)。
- secrets 任何方向不剥离(用户硬性要求),产物含 API 密钥属预期。

## 增量与分包扩展规范 (Sessions 12-14)

### 1. 外部基准增量补丁包 (Base-ZIP Delta Patch)
- **触发机制**: 必须在 UI 中预先选定已有基准归档（Base-ZIP，支持从本地文件选取或从 IndexedDB 历史归档列表选取）。
- **对比维度**: 逐条目比对 `fileName`、`uncompressedSize`、`crc32`。
- **产物结构**:
  - 仅打包在基准包中**不存在**（added）或内容变更（modified）的条目。
  - 根目录注入审计清单 `_delta_manifest.json`:
    ```json
    {
      "version": 1,
      "generator": "st-zip-converter",
      "createdAt": "ISO-8601",
      "summary": { "added": 12, "modified": 3, "unchangedCount": 1500, "totalEntries": 15 },
      "changes": {
        "added": [{ "path": "characters/new.png", "size": 10240, "crc32": 12345678 }],
        "modified": [{ "path": "settings.json", "size": 2048, "crc32": 87654321 }]
      }
    }
    ```
- **价值**: 避免数 GB 庞大酒馆包在每次备份或迁移时重复传输全量不变资源（如海量立绘与静态资源），生成几 KB~几 MB 的紧凑增量包。

### 2. 智能独立切片分包格式 (Independent Split Multi-Volume Zip)
- **核心原则**: 严禁生成 `z01, z02` 或 `.part1.rar` 这一类必须全部集齐才能解压的断裂分卷。每个分卷**必须且只能是自包含的合法标准 ZIP 包**。
- **切片策略 (`src/core/splitter.js`)**:
  - 用户配置单卷阈值（如 100MB、50MB），规划器在条目边界进行贪心聚合切片。
  - 超大单文件自动归入专属独立卷，普通文件在不超过分卷上限的前提下打包。
- **卷内清单 `_split_manifest.json`**:
  - 每个分卷包根目录下均包含全集元数据清单，标明分卷所属组（`groupId`）、卷号（`partIndex`）、总卷数（`totalParts`）以及全局条目分布与哈希，确保在云端分散存储后可无损合并或按需部分提取。

### 3. 扩展轻量清单与 Git 浅层架构 (Extension Manifest & Shallow Git)
- **云端 408 痛点**: 大型扩展（如向量数据库、复杂 UI 扩展）其 `.git` 目录体积常达数百 MB，上传至云端反代常遭遇 HTTP 408 超时失败。
- **处理策略**:
  - 支持剥离 `.git` 完整历史或将其转换为浅层快照（Shallow Git），剔除庞大对象池。
  - 配合 `extension-sources` 清单保留仓库远端来源 URL 与 Commit/Release Tag，实现轻量化传输与目标机二次克隆/拉取。

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
- yauzl 中央目录游标不可倒回:一次遍历只能消费一次,检测与主循环必须分别 open。
- yazl addBuffer 的异步 deflateRaw 请求会在 zlib 线程池无限积压(峰值 884MiB 教训),
  大包必须用 addReadStreamLazy 惰性流直通。
