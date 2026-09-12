# ST-Delegation-of-authority（Authority）后端集成调研（2026-09-12）

## Authority 是什么

SillyTavern 服务端插件（AGPL-3.0），三层架构：前端 `window.STAuthority / AuthoritySDK` → `/api/plugins/authority/*` Node 服务端插件 → Rust authority-core（SQLite + Blob + 私有文件）。为第三方扩展提供统一后端能力与权限治理。

## SDK 接入方式

- SDK 由 Authority 插件自动部署到宿主 `public/scripts/extensions/third-party/st-authority-sdk`，暴露 `window.STAuthority.AuthoritySDK` 与 `openSecurityCenter()`。
- 初始化（内联权限声明，非 manifest）：

```js
const client = await window.STAuthority.AuthoritySDK.init({
  extensionId: 'third-party/st-zip-converter',
  displayName: '酒馆数据包互转工坊',
  version: '1.0.0',
  installType: 'local',
  declaredPermissions: {
    fs: { private: true },        // 转换产物落盘
    storage: { blob: true },      // 大 zip 分块存储
  },
});
```

- 权限模型：扩展声明 → 用户授权（allow-once/session/always/deny）→ 管理员收口。需声明 `events.stream` 才能用 SSE。
- 能力：`client.fs.*`（用户+扩展隔离目录）、`client.storage.kv/blob.*`（blob 为 base64、支持大文件分块）、`client.jobs.*`（内置类型 delay/sql.backup/trivium.flush/fs.import-jsonl）、`client.http.fetch`、`client.events.subscribe`（SSE）。
- 不提供：任意 shell、zip 打包内置能力（需扩展用 Blob/fs API 组合）、宿主文件系统直通。

## 对本项目的价值（前端做不到 / 性能）

| 场景 | 现状（纯前端） | Authority 后 |
|---|---|---|
| 大包暂存 | IndexedDB（DB_VERSION 2，受浏览器配额/清理策略影响） | `storage.blob` 服务端持久化，跨设备/重装不丢 |
| 转换产物长期保存 | 待导出区，下载才入库 | `fs.writeFile` 落到服务端隔离目录，可命名归档 |
| 断点续传 checkpoint | OPFS tmp，易半成品 | 服务端 KV 记录 checkpoint + blob 存半成品，恢复会话续跑 |
| 多端同步 | 无 | 服务端存储天然共享（同用户同扩展隔离命名空间内） |
| 后台任务 | Web Worker（页面关闭即停） | `client.jobs`（仅内置类型，转换型任务不可托管——**限制**） |

### 边界与风险

1. Authority 不内置 zip 能力 → 转换/打包仍在本体 Worker 中做，Authority 只做**存储与续传层**，不迁移计算。
2. `client.jobs` 只有内置类型，不能提交自定义转换任务 → "后端并行转换"不可行，性能收益主要在 IO 持久化而非 CPU。
3. 强依赖：Authority 未安装时必须全功能降级（现架构本就支持无宿主后端），SDK 检测 `window.STAuthority` 缺失即跳过。
4. base64 blob 编码对大 zip 有 ~33% 体积/内存开销，需分块 + 仅作持久层，不进转换热路径。
5. AGPL-3.0：调用其 API 不构成衍生分发（本插件为独立作品经 HTTP/SDK 交互），但发布时需在 README 声明可选依赖与其许可。

## 建议集成设计（后续片实现）

> 2026-09-12 更新：第一片已实现——`src/storage/authority-store.js`（探测/init、
> `createCheckpointAdapter()` 复用 TaskManager {save,load,remove} 接缝接管断点
> KV 持久化、`putArtifact/getArtifact/deleteArtifact` 分块 blob，均安全降级；
> `test/authority-store.test.js` 5 项）+ 原生备份 UI 旁「一键拉取」按钮
> （`mountNativeBackupButton` opts.onQuickFetch → 复用完整 handleHostExport 流程）。
> 剩余：产物落盘 putArtifact 接入 export-queue 入库路径、Luker 备份管理器内注入。

新增 `src/storage/authority-store.js`（可选适配器，与 `db.js` 同接口）：

- `isAvailable()` — 探测 `window.STAuthority?.AuthoritySDK`，init 并缓存 client。
- `putArtifact(name, blob)` / `getArtifact(id)` — blob 分块写读（>4MB 切块）。
- `saveCheckpoint(taskId, state)` / `loadCheckpoint(taskId)` — KV。
- `task-manager.js` 的 checkpoint 持久化增加 strategy：`opfs`（默认）| `authority`（可用时）。
- 权限弹窗由 Authority SDK 自带 UI（Security Center），本体不重复造轮子。

## 文档来源

- https://github.com/Youzini-afk/ST-Delegation-of-authority （README，2026-09-12 抓取）
- 详细 API 待实现前复核其 `docs/server/http-api.md`、`docs/server/capabilities-and-isolation.md`。
