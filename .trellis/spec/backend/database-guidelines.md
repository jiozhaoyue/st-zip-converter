# Datapack Storage & Streaming Archive Guidelines（数据包存储与流式 IO）

> zip 数据包布局、流式 IO 契约、客户端暂存与 secrets 保真。

---

## Overview

本项目**不使用服务端数据库**。“存储”实体有三类：

1. **用户数据包（zip）——事实源**，由四个酒馆平台导出：
   - **SillyTavern (ST)**：zip 根摊平用户目录，**无** `manifest.json`。
   - **Luker (L)**：同为摊平布局，但带 `manifest.json`（`schemaVersion` + `selection`）。
   - **TauriTavern (TT)**：`data/` 根，用户文件在 `data/default-user/`（或其他 handle）下，系统文件在 `data/_tauritavern/`。
   - **PureTavern (PT)**：接受 TT 兼容布局；PT **原生归档**（manifest 带 per-file `moduleId` / `sha256`）识别为 `pt-native`，当前**明确拒绝转换**并提示改导 TT 迁移包。
   布局判定实现见 `src/core/detect.js`（`LAYOUTS` / `detectFromReader`）。
2. **浏览器暂存（IndexedDB）**——工作区缓存，不是事实源。
3. **可选 Authority 后端**——纯增强层，不可用时静默降级。

---

## Streaming IO & Memory Model

### 1. 逐条目直通
- **禁止把整个 zip 读进内存**：真实用户的包常在 1GiB 量级。
- 大条目走 `addLazy` 惰性流直通：泵到该条目才打开源流（`src/core/transform.js` 的 `lazyOpen`）。
- dry-run（`options.dryRun`）用 `NullZipWriter`：不打开任何数据流，只按声明大小计数（`src/core/null-writer.js`）。
- 内存峰值 ≈ **最大单条目**，与整包体积无关。
- **待验证**：具体峰值 MiB 数无自动化门禁，需 Playwright 基准实测（方法见 `quality-guidelines.md`）。

### 2. 游标不可倒回
- zip 中央目录游标**不能重绕**，因此：
  - 布局检测（`detectFromReader`）与主转换循环**必须分两次开包**：检测用 reader 在 `finally` 中 `close()`，随后重新 `openReader` 走主循环。
  - PT 目标在迁移用户级扩展前，会额外再开一次 reader 预扫 `third-party/` 目录名。
- 任何“边扫描目录元数据边读条目内容”的写法都无法工作。

### 3. 写入并发
- `src/core/zip-io.js` 的写入管线是并发滑动窗口 + `waitForSlot()` 背压；契约见 `quality-guidelines.md` 的「Zip IO 写入并发契约」，**禁止改回串行队列**。

---

## Storage & Persistence Policies

### 1. 客户端暂存：IndexedDB（`src/storage/db.js`）
- `DB_NAME = 'st_zip_converter_db'`，`DB_VERSION = 2`；stores：`files` / `workspace` / `preferences`。
- `files` 记录带 `origin`（`ORIGINS`：`upload` / `host-export` / `converted` / `delta` / `split-part`）与可选 `group`（分卷组内关联）。
- v1 → v2 迁移：`onupgradeneeded` 按 `role` 与元数据映射为 `origin`（`migrateRoleToOrigin`）；读取时 `normalizeRecord` 兜底补齐（兼容升级中断的残留记录）。
- 大 Blob（`size >= LARGE_BLOB_THRESHOLD = 16MB`）写入经模块内 `writeQueue` 串行化，与转换热路径解耦。
- 非浏览器环境：`isStorageSupported()` 为 false、`openDb()` 返回 `null`。
- **定位**：缓存。事实源是用户自己的 zip 与宿主服务端目录，IndexedDB 可清理、可重建。

### 2. 可选 Authority 后端（`src/storage/authority-store.js`）
- 探测 `window.STAuthority.AuthoritySDK`（由宿主安装的 st-authority-sdk 扩展注入）；不可用时所有导出接口返回 `null` / `false`，**调用方无需分支**。
- `createCheckpointAdapter()` 实现与 `TaskManager` 相同的 `{ save, load, remove }` 接缝；blob 分块落盘 + KV 存清单。
- **纪律**：后端只作增强，不可用时静默降级，纯前端路径保持全功能。

#### 2.1 分块产物传输契约（代际命名 · 流式切分 · 失败回滚）

> 2026-09-24 定稿（任务 `09-24-perf-hardening-transfer-memory`，审计 F-A / F-C / F-D / F-F）。
> 触发场景：任何改动 `putArtifact` / `getArtifact` / `deleteArtifact` 的实现或调用方。

**签名**

```js
putArtifact(name, blob, opts = {})   // opts: { chunkSize?, onProgress?(done,total) }
  → Promise<{ name, size, chunks } | null>   // null = Authority 不可用
getArtifact(name)                     → Promise<Blob | null>
deleteArtifact(name)                  → Promise<boolean>
```

**清单（KV `blob-manifest:<name>`）字段**

| 字段 | 语义 |
| --- | --- |
| `name` / `size` / `contentType` / `chunkSize` / `chunks` | 逻辑名、实际写入字节数、块大小、块数 |
| `parts[]` | `{ id, name }`——**读取端唯一依据**，禁止解析命名规律反推 |
| `gen` | 写入代际标识（`<base36 时间戳>_<进程内自增>`）；同名不同批次互不覆盖 |
| `savedAt` | 落盘时间戳 |

**分块命名**：`<name>__part_<gen>_<NNNNNN>`（序号 6 位补零）。命名含代际是**实现细节**，
消费者只准按清单 `parts[].name` 取块（`test/durable-mirror.test.js` 已按清单驱动断言）。

**顺序契约（不可颠倒）**

```
① blob.stream() 逐块读 → 每满 CHUNK_SIZE(4MB) 写一个【新代际】分块
② 全部块写成功后 → 写清单（清单 parts 指向新代际）
③ 清单写成功后 → 读旧清单，按旧 parts[].name 删旧代际块（不解析命名）
```

**内存模型**：写入路径**禁止整包 `arrayBuffer()` / `text()`**。峰值 ≈ `O(CHUNK_SIZE)`，
与产物体积无关（审计公式：由 `N + 2.33C` 降至 `O(C)`，N = 整包字节，C = 块大小）。
读取路径**禁止**先拼整包 `Uint8Array`；分块 Blob 直接入列交 `new Blob([...])`。

**失败与错误矩阵**

| 条件 | 行为 |
| --- | --- |
| Authority 不可用 | 全部接口返回 `null` / `false`，不抛错 |
| 某分块 `blob.put` reject | 删除本次已写分块 → **抛错**；清单不动，旧代际仍可读 |
| 读旧清单 `kv.get` reject | 删除本次全部分块 → **抛错**（读旧清单也在同一 `try` 内，否则留孤儿块） |
| 清单 `kv.set` reject | 删除本次全部分块（防孤儿）→ **抛错**；旧代际仍可读 |
| 旧代际清理失败 | 单块失败仅忽略，不阻断（孤儿块可接受，数据可读优先） |
| `getArtifact` 清单缺失 / 块缺失 | 返回 `null`，不抛错 |

**Good / Base / Bad**

- Good：同名重传 → 新代际分块落盘 → 清单换指 → 旧代际清理，全程无孤儿块、无新旧混合。
- Base：首次写入（无旧清单）→ 只走 ①②，跳过 ③。
- Bad：复用旧 part 名覆盖写 → 中途失败会让清单指向半新半旧的块（**数据损坏且无法察觉**）。

**测试点（`test/authority-store.test.js` / `test/durable-mirror.test.js`）**

- 探针对象对 `arrayBuffer` / `text` 直接抛错 → 写入路径回归到整包读取时**当场失败**。
- 同名两次写入：分块名互不重叠、清单 `gen` 变化、旧代际块已清理。
- 第 N 次 `blob.put` reject：本批已写块全部回滚，清单仍是旧对象引用，`getArtifact` 仍可读。
- 首次 `kv.set` reject：`_blobs` / `_kv` 均为空（无孤儿）。
- `kv.get`（读旧清单）reject：本批块全部回滚，清单未改动，解除注入后旧产物仍可读。
- `getArtifact` 兼容返回形状：base64 字符串 / `{ content }` / ArrayBuffer / Uint8Array / Blob。

### 3. Secrets Preservation（不可协商）
- `secrets.json`（API 密钥）**任何方向、任何目标都不得被剥离、过滤或改写**。
- 唯一例外：用户在类目勾选中**主动取消** `secrets`——此时产物不含该条目，并在报告 `filtered` 中留痕（`test/filter.test.js` 把关）。
- 字节一致性由 `test/convert.test.js` 的 `Buffer.compare` 断言。

### 4. Derived Cache Discard Rules
默认丢弃派生/私有缓存（`transform.js` 的 `DERIVED_DIRS` / `TT_PRIVATE_PREFIXES` / `TT_PRIVATE_FILES`）：
- `thumbnails/`、`vectors/`
- TT：`data/_cache/`、`data/_css/`、`data/_errors/`、`data/content.log`（含 `.1`）
- 保留开关均为 `convert()` 的 **options**（`keepAll` / `includeCache` / `includeBackups` / `includeAppPrivate` / `keepDevFiles`）——**不存在 `--keep-all` 这类 CLI 参数**。

### 5. Luker 私有配置的兼容沙箱
- 目标**不是** Luker 时，Luker 专属私有文件（`stats.json` / `macros.json` / `user_data.json` 等）被搬到 `_compat/luker/<原路径>` 而非丢弃；转回 Luker 时再解包回原位（`transform.js`；`test/private-configs.test.js` 把关）。

### 6. Extension Migration
- **PT / TT 目标**：用户级 `extensions/<name>/` 迁移为 `data/extensions/third-party/<name>/`，并产出 `data/_tauritavern/extension-sources/<scope>/<name>.json` 来源记录（源里已有记录则原样保留；否则仅在 `remoteUrl` / `homePage` 为 https 时合成，非 https 只记警告——PT 导入时会跳过该扩展）。
- 与已有 third-party 同名冲突时保留 third-party 版本，丢弃用户级副本并逐条记录。
- **ST / L 目标**：修正错误的 `third-party` 嵌套并摊平（`thirdPartyFlattenedCount`）。
- 另有交付模式开关：`EXTENSION_MODES.MANIFEST`（只导出来源清单，不打包插件实体与 git packfile，防 408 超时）与 `EXTENSION_MODES.FULL`（完整离线包）。

### 6.1 扩展清单契约（schema v2 · `src/core/extension-manifest.js`）

> 2026-09-24 新增（任务 `09-23-extension-manifest-git`）。**唯一权威实现点**，生成端与恢复端都经此模块，
> 不得在别处重复实现状态判定。

**两种产物，两种用途**：

| 产物 | 路径 | 产出条件 | 语义 |
| --- | --- | --- | --- |
| 私有清单 | `_convert/extensions-manifest.json` | **FULL 与 MANIFEST 都产出** | 转换器自用：恢复端据此引导安装或更新 |
| 官方索引 | `extensions-index.json` | **仅 MANIFEST** | 宿主 Content Downloader 的「按 URL 在线下载」格式 |

> **官方索引为什么 FULL 不产出**：该索引语义是「按 URL 在线下载」，而 FULL 包内已有扩展实体，
> 宿主若照索引再装一遍会造成重复安装与潜在覆盖（决策 D-6）。

**条目状态字段（派生，调用方不得传入）**：

```
sourceKind:   'git'（gitMeta.remoteUrl 或 sourceRecord.remote_url）
            | 'homepage'（manifest.homePage）
            | 'unknown'
availability: mode === 'full'                        → 'embedded'（包内已有实体）
              mode === 'manifest' && isInstallableUrl → 'installable'
              否则                                     → 'unavailable'
notes:        仅在有值时输出（unavailable / homepage 来源两种情况）
```

**归一与兼容（`normalizeManifestEntries`）**：v1 旧清单（无 `availability`）按 `mode` 推断；
非法取值回退同一规则；**非 http(s) URL 强制 `unavailable`**（不依赖点击时才失败）。

**恢复端触发（决策 D-4）**：只有存在 `installable` 条目时才自动弹出安装器
（`shouldAutoOpenInstaller`）；全部 `embedded` / `unavailable` 时仅写日志，不打扰用户。

**安全纪律**：包内 JSON 字段（`displayName` / `notes` / `url` / `name`）一律
`createElement + textContent`；`isInstallableUrl` 与 `src/ui/escape.js` 的 `isSafeHttpUrl`
**同规则**（核心层不得依赖 UI 层，故两处各持一份实现，回归由
`test/extension-manifest.test.js` 把关）。

### 7. 合成条目
- ST 目标会写入 `_convert/INSTALL.md`、`_convert/meta.json`、`_convert/extensions-manifest.json` 等说明性合成条目（`report.synthesized()` 记账）。
- 所有合成条目使用固定时间戳 `2020-01-01T00:00:00.000Z` 并按名字排序，保证可复现。

---

## Common Pitfalls & Anti-patterns

- **禁止** `fs.readFileSync(zipPath)` 或把整包读进内存（`src/core/` 内也不允许任何 `node:` 导入）。
- **禁止**在非转换环节改动条目字节或内容。
- **禁止**动态改写合成条目的时间戳（必须用固定 epoch 常量，保证字节级可复现）。
- **禁止**在 `src/core/` 中直接触碰存储（IndexedDB / OPFS / Authority）——一律经注入的 adapter 接缝。
- **禁止**把 IndexedDB / 浏览器存储当成用户资产的事实源（用户的文件必须能落到宿主服务端原生目录）。
