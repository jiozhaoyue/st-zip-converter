# Dev 实例往返实测：`gitMode=minimal` 可行性取证

> 任务 `09-22-extension-git-slim` · 2026-09-25 · 用户已授权（选项 A：授权对 Dev 做往返实测）
> 目标实例：**Dev Luker 8003**（HTTPS，Luker 2.7.0）。**Real 8004 全程未触碰**。

## 1. 结论摘要

`gitMode=minimal` **在真实宿主上成立**：最小 `.git` 经宿主的原生恢复接口落盘后，
宿主「一键更新」链路依赖的三条命令全部通过，且首次更新后仓库**自愈为完整状态**。

## 2. 方法与产物

1. 造一个**真实 git 仓库**作探针扩展（`zz-git-slim-probe`）：3 个提交，其中第 2 个提交写入
   3 MB 不可压缩随机数据、第 3 个提交删除它但用 tag 保持可达——复刻「历史上提交过大文件，
   后来删了，但 packfile 里永远留着」这一体积黑洞的真实成因。
   - 探针 `.git` 原始体积：**3.03 MB**
2. 源包（ST 摊平布局，含根 `settings.json` 仅为满足布局探测）：**3.02 MB**
3. 用本插件转出 **`target=st` + `gitMode=minimal` + `selection.settings=false`** 的产物：
   - 产物 **3592 B**；`report.totals.droppedBytes = 3 150 682 B`
   - 包内 `.git` **恰好 5 条**：`config` / `HEAD` / `index` / `refs/heads/main` / `objects/.keep`
   - **不含根 `manifest.json`、不含 `settings.json`**——把对 Dev 状态的影响面压到最小
4. 经**宿主原生恢复接口**写入 Dev：`POST /api/users/restore-backup`
   - 响应 **HTTP 200**：`{"mode":"merge","restoredCount":7,"failedCount":0,"skippedCount":3,…}`
     （3 条 `_convert/*` 被宿主按合并语义跳过）
5. 落盘与 git 取证（见 §3）。

## 3. 取证结果

### 3.1 宿主恢复后落盘状态

```
data/default-user/extensions/zz-git-slim-probe/
  manifest.json  index.js
  .git/config  .git/HEAD  .git/index  .git/objects/.keep  .git/refs/heads/main
```

- **`.git/objects/` 目录真实存在，`.keep` 内容 101 字节**——即宿主的解压**保留了本插件合成的占位文件**。
  这是本策略唯一的「外部依赖」假设，至此被真机证实。
- 恢复后 `.git` 文件数 **5**。

### 3.2 宿主「一键更新」链路的三条命令（在实例目录内实跑）

| 命令 | 结果 | 判定 |
| --- | --- | --- |
| `git rev-parse --is-inside-work-tree` | `true`（rc=0） | ✅ 宿主判为**合法仓库**（即 `checkIsRepo` 的底层命令） |
| `git branch --no-color` | `* main`（rc=0） | ✅ 当前分支可读（即 `branch()` 的底层命令） |
| `git status --short` | `fatal: bad object HEAD`（rc=128） | ⚠️ 已知局限：首次更新前不可读（该链路不调用它） |

### 3.3 真实更新一次（模拟上游扩展发新版）

在探针上游仓库追加一个提交后，于实例目录内执行：

```
$ git pull origin main
Updating 2962785..183911d
Fast-forward
 update.txt | 1 +
 1 file changed, 1 insertion(+)
 create mode 100644 update.txt
```

- **rc=0，快进成功，新文件内容正确落地** —— 「一键更新」在真实实例上**可用**。
- 更新后 `.git` 文件数 **5 → 22**：缺失对象由 `pull` 自动补齐，`refs/remotes` 重建。
- 更新后 `git status --short` → **空**（干净）；`git fsck --no-progress` → **无输出**（rc=0）。
  即：**首次更新后仓库自愈为完整状态**。

### 3.4 界面侧

- `/api/extensions/discover`（扩展管理 UI 的数据源）→ HTTP 200，共 50 个扩展，
  **探针在列**：`{ "type": "local", "name": "third-party/zz-git-slim-probe" }`。
- 未通过无头浏览器完成对「检查更新」按钮的字面点击（该环境下扩展菜单未展开渲染，
  `extBlocks: 0`）。**上表三条命令即该按钮背后实际执行的命令**，且探针仍在 Dev 中，
  用户可在自己的浏览器里 5 秒内复核。

## 4. 过程中发现的两处宿主端事实（与本任务无因果关系，仅记录）

1. **Luker 的恢复路由不是 `/api/users/restore`**。黑盒探测结果：
   - `/api/users/restore` → **404**（无此路由）
   - `/api/users/restore-backup` → 路由存在（空体时 400 `No backup file uploaded`；带 `avatar` 字段即 200）
   - `/api/users/me` 同样 **404**
   - 本项目 `src/ui/host-bridge.js:728` 的 `restoreToHostInner` 固定 POST `/api/users/restore`，
     而 `restoreToLuker()`（`:1260`）只是把 `platform:'luker'` 转发给它。
   - 注意：插件在 Luker 下**隐藏**了该按钮（实测 `#btn-restore-luker` 为 `display:none`），
     且 09-01 任务的既有结论是「L 的 `restore-backup` 支持 selection + overwrite/merge；
     **插件不做导入端**（L 原生 UI 已覆盖）」——故这可能是有意为之而非缺陷。
     **但它是一处「代码里存在、在 L 上必然 404」的悬置路径**，建议单独立项判定：要么接线到
     `restore-backup`，要么把该函数标注为 ST-only。
2. **CSRF 令牌与会话 cookie 绑定**：只带 `X-CSRF-Token` 不带会话 cookie 会 403
   `Invalid CSRF token`；须先 GET 取得 cookie。且 Dev 开了 `enableUserAccounts`，
   匿名请求一律 403 —— 这也是为什么本次必须借已登录的浏览器会话上下文发起。

## 5. 对 AC 的支撑

| AC 条目 | 状态 |
| --- | --- |
| `minimal` 形成 Dev 实例往返实测结论（无论通过与否都必须成文） | ✅ 本文档（**通过**，含唯一已知局限 `status` 不可读） |
| 「接收方需联网」这一前提 | ✅ 属实且已写入 README 与 UI 提示：minimal 的对象存储由首次 `pull` 从 origin 补齐 |
| `.git/objects/.keep` 是本策略的命门 | ✅ 真机证实宿主解压保留该文件；缺它则 minimal 与 strip 等价 |
