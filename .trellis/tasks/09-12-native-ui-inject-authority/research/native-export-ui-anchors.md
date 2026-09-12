# 四酒馆原生导出/备份 UI 锚点调研（只读实例源码，2026-09-12）

## 结论：四个宿主共用同一锚点 `.userBackupButton`

四个酒馆的用户设置面板均由 `templates/userProfile.html` 渲染，其中包含 `.userBackupButton`（`menu_button menu_button_icon`），由 `scripts/user.js` 绑定点击。注入一个同级按钮即可在原生导出 UI 处接管入口，与扩展设置抽屉共存、零样式冲突（按钮直接复用宿主 `menu_button` 类）。

| 实例 | 模板 | 绑定逻辑 | 按钮文案 | 差异 |
|---|---|---|---|---|
| SillyTavern | `public/scripts/templates/userProfile.html:75` | `public/scripts/user.js:696` `backupUserData(handle)` | Download Backup | 基准版 |
| Luker | `public/scripts/templates/userProfile.html:75` | `public/scripts/user.js:657` `backupUserData(handle, cb, selection)`（支持分类勾选，`BACKUP_DEFAULT_SELECTION`）；`:754` restoreUserData 带 onProgress/scratchCreds；`:936` createLanMigrationLink | Backup & Restore（打开备份恢复管理器） | 功能超集 |
| TauriTavern | `src/scripts/user.js:300/749/856`（Tauri 桌面壳，DOM 结构同上游） | 同 ST | 同 ST | 无 |
| PureTavern | `apps/web/.generated/public/scripts/user.js` + `templates/userProfile.html`（上游同构；另有 `legacy/upstream` 镜像） | 同 ST | 同 ST | pnpm monorepo 生成式 |

## 渲染时机（决定注入策略）

- ST/PT：user settings 面板在启动时渲染一次 userProfile 模板；`.userBackupButton` 出现晚于扩展加载 → 需轮询/观察。
- TT：管理员面板 `renderUsers` 会重渲染（user.js:856 对每个用户重绑），用户自己的 profile 区稳定。
- Luker：按钮打开的是备份管理器，锚点位置相同。
- 现有代码模式为 `setInterval` 幂等轮询（`mountSettingsDrawer`/`registerMenuButton` 同款），注入按钮沿用该模式：每秒检查，注入成功即 `clearInterval`。若宿主重渲染面板导致按钮丢失，重新加载扩展面板即可（与现有抽屉策略一致）。

## 已实现（本任务第一片）

- `src/ui/host-bridge.js`：抽出共用 `openConverterDrawer()`（展开抽屉+平滑滚动），`registerMenuButton` 与新增 `mountNativeBackupButton(onOpen)` 共用；`mountNativeBackupButton` 在 `.userBackupButton` 的 nextSibling 插入 `#st-zip-converter-native-btn`（复用 `menu_button menu_button_icon` 原生类），并支持 `opts.onQuickFetch`（「一键拉取」按钮 → 复用完整 handleHostExport 流程）。
- `index.js`：插件模式 `applyPluginUi()` 中与 `registerMenuButton` 并列调用。
- 无需新增 CSS：按钮全用宿主原生类，且位于宿主面板内，不触碰 `.app-container`/`.st-converter-drawer-app` 作用域铁律。

## 第二片（2026-09-12，commit 待填）

- **Luker 备份管理器内注入**：`mountLukerBackupManagerButton(onOpen)` — `templates/userBackupManager.html`（openBackupManager 动态渲染）的 `.backupActionRow` 首位插入转换器入口；仅 Luker 存在该锚点。
- **MutationObserver 统一注入**：新增共享 `watchHostDom(injectFn)` + `injectionWatchers` 集合，`mountSettingsDrawer`/`registerMenuButton`/`mountNativeBackupButton`/`mountLukerBackupManagerButton` 四个注入全部改为幂等回调 + 单个 document.body childList/subtree observer（200ms 去抖），替代各自 1s setInterval 轮询；宿主重渲染面板（含 TT 管理面板）时自动自愈重注入。
- **产物持久归档镜像**：`ExportQueue.stash/ensureStored` 入库成功后 `_mirrorToAuthority(item)` → `authority-store.mirrorArtifact(name, blob)`（fire-and-forget，不可用/失败只告警不阻断本地入库）；`test/durable-mirror.test.js` 5 项（mock db.js saveFile 驱动全路径）。

## 备份端点（后续在原生 UI 旁加"导出并转换"的接口基础）

- 全部四家：`POST /api/users/backup`（body `{handle}`，Luker 额外接受 `{handle, selection}`）→ 返回 zip blob + Content-Disposition 文件名。
- Luker 恢复：`POST /api/users/restore`（multipart，含 selection/mode/onProgress）——`host-bridge.restoreToHost` 已封装。

## 待办（后续片）

- [ ] 原生注入按钮的浏览器端实测（四实例 Playwright 冒烟）。
