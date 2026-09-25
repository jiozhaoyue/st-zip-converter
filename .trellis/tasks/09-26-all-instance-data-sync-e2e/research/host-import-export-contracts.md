# 四宿主的原生导出/导入契约（同步通道选型的证据）

> 取证日期：2026-09-26 ｜ 全部读自实例仓源码，附 `file:line`
> 目的：确定「把 Real Luker 的数据同步到各实例」时，每个宿主**可用的原生通道**是什么，
> 以避免裸文件拷贝（L0-1）。

## 0. 结论速览

| 宿主 | 原生整包**导出** | 原生整包**导入/恢复** | 同步通道 | 能否 Playwright 驱动 |
| --- | --- | --- | --- | --- |
| **ST 1.19.0** | ✅ `POST /api/users/backup` | ❌ **无**（两端点实测 404） | 浏览器端逐类目导入（宿主原生 UI） | ✅ 有 HTTP 端口 |
| **Luker 2.7.0** | ✅ 同路径 | ✅ `POST /api/users/restore-backup`（`mode=merge`/`overwrite`） | **原生整包恢复**，`mode=merge` 即「覆盖同名、不删独有」 | ✅ 有 HTTP 端口 |
| **TT** | ✅ `POST /api/users/backup`（同路径，另有 `native` 落盘开关） | 经其 `data-migration` 系统扩展读 `data/default-user` 树 | 产包 + 人工导入 | ❌ **Tauri 桌面应用，无浏览器端口** |
| **PT** | ✅ M21 导出（浏览器侧归档） | ✅ M21 导入（`merge`/`skip`/`replace-module`/`replace-all`） | **浏览器驱动 M21 导入** | ✅ `apps/web` dev `:8899` |

## 1. SillyTavern 1.19.0

### 1.1 导出（可用）

`Instance/Real/SillyTavern/src/endpoints/users-private.js:156`

```js
router.post('/backup', async (request, response) => {
    const allowFullDataBackup = !!getConfigValue('backups.allowFullDataBackup', true, 'boolean');
    if (!allowFullDataBackup) { /* 403 Full data backup is disabled */ }
    const handle = request.body.handle;
    if (!handle) { /* 400 Missing required fields */ }
    if (handle !== request.user.profile.handle && !request.user.profile.admin) { /* 403 */ }
    await createBackupArchive(handle, response);
});
```

- 需**登录态 + CSRF**；`handle` 须等于当前用户或调用者为 admin。
- 受 `backups.allowFullDataBackup` 配置门禁，**默认 true**。
- 本插件已在用该端点：`src/ui/host-bridge.js:693`（`fetch('/api/users/backup', …)`）、
  `index.js:952` 注明「ST 宿主的 `/api/users/backup` 端点不支持 selection（全量 glob 导出）」。

### 1.2 导入（**不可用**）

`src/ui/host-bridge.js:59-110` 的端点评测注释（2026-09-25 认证态黑盒实测）：

```
 *   - Luker 2.7.0：`/api/users/restore` → 404；`/api/users/restore-backup` 存在（空体 → 400）。
 *   - ST 1.19.0：两者**均为 404** —— ST 不提供整包恢复能力。
```

⇒ **ST 目标必须走浏览器端逐类目导入**（宿主原生 UI）。仓内 ST 侧可核对的导入端点为
`src/endpoints/characters.js:1560`（`POST /import`）、`src/endpoints/chats.js:771`（`POST /import`）、
`src/endpoints/chats.js:751`（`POST /group/import`）、`src/endpoints/worldinfo.js:99`（`POST /import`）。

## 2. Luker 2.7.0

### 2.1 整包恢复端点（**本次 Luker 目标的通道**）

`Instance/Real/Luker/src/endpoints/users-private.js:1237`

```js
router.post('/restore-backup', async (request, response) => {
    const handle = request.body.handle;                       // 400 if missing
    if (handle !== request.user.profile.handle && !request.user.profile.admin) { /* 403 */ }
    if (!request.file) { /* 400 No backup file uploaded */ }
    if (!originalName.toLowerCase().endsWith('.zip')) { /* 400 must be .zip */ }

    const mode = String(request.body.mode || 'merge').toLowerCase() === 'overwrite'
        ? 'overwrite' : 'merge';                              // ← 默认 merge
    const selection = sanitizeBackupSelectionForUser(parsedSelection, isAdminUser);
    if (!Object.values(selection).some(Boolean)) { /* 400 至少选一个类目 */ }
    …
    const restoreResult = await restoreUserBackupArchive(uploadPath, directories, selection, mode, {…});
```

**关键：`mode` 默认 `merge`** —— 正是用户裁定的「覆盖同名，不删独有」语义。
`overwrite` 模式另有**快照回滚**保护：

- `users-private.js:683` `if (mode === 'overwrite') { … }` → 先对将被覆盖的路径做 snapshot；
- `:718` 「Failed to snapshot existing data before overwrite … Manual recovery required」；
- `:886-895` 提取失败时用 snapshot 回滚。

`restoreUserBackupArchive` 实现于 `users-private.js:593`；
另有 `/restore-backup/probe`（`:1197`）供 UI 预检（跨引擎模式需 scratch 凭据）。
三个端点（`restore-backup` / `lan-migration/import` / 其一）共用同一实现（`:1295` `:1402` `:1481`）。

### 2.2 插件侧已有的恢复能力探测

`src/ui/host-bridge.js:71-72`：

```js
const RESTORE_ENDPOINT_CANDIDATES = Object.freeze({
  luker: Object.freeze(['/api/users/restore-backup', '/api/users/restore']),
  st:    Object.freeze(['/api/users/restore', '/api/users/restore-backup']),
});
```

命中结果**会话内缓存**（`restoreEndpointHit`），404 回退自愈；`restoreCapability` 三态
`unknown|available|unsupported`，`unsupported` 时禁用恢复入口并提示「改用宿主原生方式导入」
（**不出现死按钮**）。⇒ 本插件的恢复能力面与上述实测**一致**，无需新增探测逻辑。

## 3. TauriTavern

### 3.1 导出

`Instance/Real/TauriTavern/src/tauri/main/routes/user-routes.js:68`

```js
router.post('/api/users/backup', async ({ body }) => {
    const handle = String(body?.handle || '').trim();          // 400 if missing
    const useNativeSave = body?.native === true;
    const secretSettings = await context.safeInvoke('read_secret_settings');
    const includeSecrets = secretSettings?.allowKeysExposure === true;
    const archive = await context.safeInvoke('export_user_backup_archive', {
        handle, include_secrets: includeSecrets,
    });
    const archiveFileName = String(archive?.file_name || '').trim();
    const archivePath = String(archive?.archive_path || '').trim();
    …
```

- `native:true` → 归档**直接落服务端磁盘路径**（`archive_path`），不走浏览器下载。对 3.8 G 级数据更稳。
- secrets 是否含入由 `allowKeysExposure` 决定。
- 前端调用点：`src/scripts/user.js:303`。

### 3.2 导入

TT 有 `data-migration` **系统扩展**（`docs/CurrentState/iOSPolicy.md:140` 的
`extensions.system_allowlist` 明确含 `"data-migration"`），它读 ST 形态的 `data/default-user` 树。
⇒ 交付形态 = **TT 布局（`data/default-user/` 前缀）的数据包**，由用户在 TT 内导入。

### 3.3 为何不能 Playwright 驱动

TT 是 **Tauri 桌面应用**（`src-tauri/`），UI 跑在 WebView2 里；实例目录下**没有 `data/`**，
data root 由 `docs/CurrentState/DataDirectorySelection.md` 描述的**启动引导配置**在运行期决定
（`set_data_root` / `data_root`，且「运行期热切换」被列为不做项）。
⇒ 无浏览器可连端口，自动化不可行 —— 用户裁决「TT 人工」。

## 4. PureTavern

### 4.1 导入/导出（M21）

`Instance/Real/PureTavern/apps/web/src/features/import-export/README.md`

- 归档为**带版本与 SHA-256 的自有格式**（`manifest.json` + 模块记录 + blob），**不是 ST 的包**。
- 冲突策略：**`merge` / `skip` / `replace-module` / `replace-all`**，外加带护栏的
  `replace-local`（清空本地前对每个模块含 Secrets 做备份）。
- **dry-run 预览**（新增项/冲突/不可用模块/敏感数据/版本差异）。
- 导入前自动建**恢复点**，并有 **import journal** 记录活动模块/阶段。
- 关键互操作：**`tauri-tavern/` 子模块负责「PT 模块记录 ↔ ST `data/default-user` 树」双向转换**，
  转换是**语义级**而非路径重写（角色 = 一条 `cards` 记录 + 一个 `avatars` blob ↔ 一张内嵌卡片的 PNG）。
- **记录 id 由自然键派生**（avatar 文件名、chat 文件名、world book 文件名、preset 类型/名、asset 路径），
  且**复用匹配的本地 id** ⇒ **重复导入是更新而非新增**（这正是「覆盖同名」语义）。
- 未映射目录（`groups/`、`user/workflows/`）与可再生数据（`thumbnails/`、`backups/`、`vectors/`）
  分别落到 `unsupported` / `derived` 行；**每个文件都被记账**，`files` 计数之和 = 包内文件总数。
- Secrets 默认排除。

⇒ PT 目标通道 = **把 TT 布局树交给 PT 的 M21 导入（`merge` 策略）**，全部在浏览器侧完成，
可 Playwright 驱动（`apps/web` dev `:8899`，`apps/web/vite.config.ts:26` `port: 8899`）。

### 4.2 扩展安装

只支持**远程 URL**（jsDelivr / GitHub / GitLab / 直接 `.zip`），包存 M13 浏览器 blob，
经 `/api/extensions/*` 兼容路由 + Assets Service Worker 提供。
⇒ **无磁盘扩展目录**，「clone 到目录」对 PT 不成立。

## 5. 本插件已使用的宿主端点（`grep` 全仓）

```
/api/extensions/delete      /api/extensions/discover   /api/extensions/install
/api/users/backup           /api/users/me              /api/users/restore
/api/users/restore-backup   /api/users/storage/inspect
```

## 6. 转换侧的可用旋钮（`src/core/transform.js:234`）

```js
export async function convert(sourcePath, targetPath, {
  target, keepAll = false, dryRun = false, io = zipIo, onProgress,
  selection, excludedPaths, includeCache = false, includeBackups = false,
  includeAppPrivate = false, compressionLevel = 5,
  extensionMode = EXTENSION_MODES.FULL, gitMode = GIT_MODES.KEEP,
  keepDevFiles = false, pruneBuiltinAssets = false,
  signal, resumeCrcMap, onEntryDone,
} = {})
```

- **`includeBackups` 默认 `false`** ⇒ 用户裁决的「同步时排除 `backups/`」**已是转换器默认行为**，
  无需额外开关。
- `selection` / `excludedPaths` 可做类目级裁剪；`dryRun` 可先算账不落盘。
- `convert()` 是**纯逻辑 + `io` 注入接缝**（`io` 缺省 `zipIo`），故**可在 Node 里无浏览器跑**——
  产包不必经过 UI，可脚本化且可单测。
