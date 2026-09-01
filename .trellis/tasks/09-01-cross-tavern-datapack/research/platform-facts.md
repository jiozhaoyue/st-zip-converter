# 四平台数据包事实清单(读码确认)

> 来源:2026-09-01 两个会话的只读调研。所有结论都有代码证据;凡"仅凭目录推测"的都已标明或剔除。
> 实例路径铁律:所有实例数据只读,测试一律用工作区副本。

## 1. 包布局

| 平台 | 布局 |
|---|---|
| ST | zip 根摊平用户目录:`characters/ chats/ worlds/ User Avatars/ settings.json secrets.json` + 各预设目录,**无 manifest.json** |
| L | 同 ST 摊平 + `manifest.json`(见 §2) |
| TT | `data/` 根:`data/default-user/<同 ST 用户目录>` + TT 私有 `data/_tauritavern/`(extension-sources、extension-store、mcp、skills、window-state)+ `data/_cache _css _errors extensions content.log` |
| PT | 原生归档格式:manifest 带 per-file `moduleId/kind/sha256`;另可导入 TT 布局(见 §4) |

实测样本(工作区副本):
- `default-user-2026-08-25-172055.zip` ≈ 964 MiB(L 导出,真实数据)
- `tauritavern-data-20260825-100035.zip` ≈ 162 MiB(TT 导出)

## 2. 各平台导出/导入能力(证据)

| 平台 | 导出 | 导入 |
|---|---|---|
| ST | `createBackupArchive` `Dev/SillyTavern/src/users.js:1148`,摊平无 manifest,**默认排除 secrets.json** | **无整包导入**,只有单项恢复(presets/restore、settings/restore-snapshot) |
| L | `createBackupArchive` `Dev/Luker/src/users.js:1467`,manifest = `{schemaVersion:1, createdAt, handle, selection}`(users.js:1496) | `restoreUserBackupArchive` `Dev/Luker/src/endpoints/users-private.js:589`(见 §3) |
| TT | `data_archive/export.rs` 硬编码加 `data/` 前缀 | 三种布局策略 `import/layout.rs`:`DataRoot` / `UserHandleRoot` / `SillyTavernUserRoot`(**能直接吃摊平 ST 布局**) |
| PT | 原生归档(sha256 清单);另有 TT 迁移包导出(`tauri-tavern-service.ts` `#pack` → `packTauriTavernArchive`) | 最严:只认自家归档或 TT 布局(见 §4);摊平布局 `readUserPath` 返回 null → 整包忽略,所以"pt 认不了 st/l" |

## 3. L 的 zip 导入语义(关键,上一会话遗留缺口已补)

`Dev/Luker/src/endpoints/users-private.js`:

- **zip 里的 manifest.json 导入时不被解析**——`resolveAllowedRestorePath`(:311)把 `manifest.json` 列入跳过。selection 来自**恢复请求**(用户在 UI 勾选),不是来自包内 manifest(users-private.js:613 `getUserBackupTargets(directories, selection, options)`)。
- **条目按路径后缀匹配**:对每个 zip 条目,取其路径的所有后缀候选(:305-335),依次对 allowedFiles / allowedDirectories / 目录别名尝试解析。这解释了 `tt→l 能通`:`data/default-user/characters/x` 的后缀 `characters/x` 落进 `<root>/characters`。
- **未知条目 = 跳过而非报错**(:337-349 记入 `report.sampleSkippedEntries`,上限 30 条)。sidecar 文件放进去是安全的,但不会被保存。
- **mode=overwrite 时先对目标类目做快照再替换**(不是全盘 rmSync;`restoreFromSnapshot` 是引擎迁移的回滚机制,不是 zip 导入路径)。
- `_engine_dump.bin` + `_engine_meta.json`:db 引擎(sqlite/mysql/pg)的专有旁路;engineKind 不匹配时走 `cross-mode-restore.js` 编排器(fs 包导入 db 服务器会合成 `engineMeta={engineKind:'fs'}` 自动转换,不再报"先跑 storage-migrate")。
- selection 10 类:`settings, secrets, characters, chats, lorebooks, presets, assets, extensions, globalExtensions, vectors`(`storage/migration/selection-mapping.js:4`)。
- 存储四引擎(fs/sqlite/mysql/postgres,`storage.mode` 决定),fs 模式包 = 纯文件树。

**生成 L 包的硬约束**:条目路径相对用户目录摊平;manifest.json 带上(schemaVersion:1/createdAt/handle/selection)仅为保真,导入端不校验;secrets.json 由 selection.secrets 控制,须在包内存在。

## 4. PT 的 TT 布局导入与扩展闸(本会话深挖,修正上一会话结论)

`Dev/PureTavern/apps/web/src/features/import-export/tauri-tavern/`:

- 常量 `data-tree.ts`:`TAURI_TAVERN_DATA_ROOT='data'`,`TAURI_TAVERN_USER_ROOT='data/default-user'`,`TAURI_TAVERN_THIRD_PARTY_ROOT='data/extensions/third-party'`,`TAURI_TAVERN_EXTENSION_SOURCES_ROOT='data/_tauritavern/extension-sources'`。注释明言:目录名必须与 ST `USER_DIRECTORY_TEMPLATE` 逐字一致。
- 扩展导入 `application/tauri-tavern-import.ts:677 importExtensions`:
  1. capability 闸:`context.extensionMigration` 为 null → 整段跳过 + 警告"extension installer is unavailable"(:687-694)。capability 由 extensions 特性注册(`features/extensions/module.ts:112`),正常加载不缺。
  2. 来源解析 `readExtensionSource`(:755):优先 `extension-sources/<scope>/<名>.json` 的 `remote_url/reference/installed_commit`;**没有记录时退回扩展自身 manifest.json 的 `homePage`**(须 https),再没有才跳过并警告"reinstall it from the extension panel"。→ 上一会话"没有源记录=不可恢复"的说法**过强**,实际有 homePage 兜底。
  3. 通过 `buildImportedExtension`(`features/extensions/application/extension-service.ts:184`)重走与远端安装完全一致的校验/注册:`validateLegacyExtensionPackage`(`package-validator.ts:62`)要求 manifest.json 存在、`display_name` 必填、`js`/`css` 至少一项、路径安全(禁 `\ % ? # :`、控制字符、盘符等)。产出记录 `trust:'user-approved-legacy'`,更新检查照常可用。
- **判定:这是有意的设计(重装式迁移),不是 bug 也不是故意卡人**。依据:`extension-service.ts:172-181` 注释("校验、id 推导和记录结构复用 installRemote 那一套…更新检查也照常可用")+ `features/extensions/THREAT-MODEL.md:5`(扩展是页面上下文任意代码,安装须有来源)。
- PT 仓库历史:TT 导入功能非常新(`927163f 支持tt酒馆有损导入数据` → `3e8909a 快速导入`,在 `0.1.12` release 之后);用户实测失败很可能是安装版 PT 版本早于这套代码。

**用户真实 TT 包实测**(工作区副本):
- `data/_tauritavern/extension-sources/local/{JS-Slash-Runner,ST-Prompt-Template}.json` 两条记录齐全(host/repo_path/reference/remote_url/installed_commit)。
- `data/extensions/third-party/{JS-Slash-Runner,ST-Prompt-Template}/` 两个文件夹,manifest 均合规(display_name/js/homePage 均 https)。
- → 按当前 PT Dev 代码,**两个扩展都应能导入**;安装版失败更可能是版本旧或 capability 未加载。

## 5. 转换拓扑(结论)

**ST 用户目录布局为 hub + sidecar `_convert/meta.json`**(选项1+2合成):
1. ST 无导入 → 目标为 ST 的产物就是摊平布局本身,hub 零转换。
2. TT 内置 `SillyTavernUserRoot` 策略 → hub→TT 近零成本。
3. PT 只差前缀 → hub 包 `data/default-user/` 前缀 + 合成 extension-sources 即可走 PT 现成 TT 通道。
4. 四平台核心资产同构是共同祖先所致,hub 顺着代码纹理。

副作用:适配器 8 个而非 12 个;往返经 sidecar 保私有数据;中间产物本身是合法 ST 布局可直接人工验证。注意 sidecar 进 L/TT 后**不存活**(L 跳过未知条目、TT 收进 user dir),真正跨往返的私有元数据要靠各方向转换器记忆映射规则而非 sidecar 续传。

## 6. TT 测试路径(免 GUI)

- `cargo test -p tt-adapter-archive` 覆盖 `import/layout.rs` 布局识别(cargo 1.95 可用)。
- `tests/*.test.mjs` 有 `user-backup-route-contract.test.mjs` 可参照写合约测试调 `import_user_backup_archive`。
- 工具链:cargo 1.95 / node 24 / pnpm 10 / python 3.13 全齐(node 24 是 Termux 之外的开发机版本)。

## 7. 用户决策(2026-09-01 答复)

1. **交付形态:脚本 + 插件都要**;脚本须能在手机 Termux 跑。
2. **PT 扩展闸:待解释后定**(调研结论:转换器侧合成 extension-sources 即可绕过,不必改 PT 代码;若最新 PT 仍失败提 issue 而非 PR)。
3. **内容范围:全都要,secrets 绝对必须带**(zip 泄露是用户自己的责任,不做排除)。
