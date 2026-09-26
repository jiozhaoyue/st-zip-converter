# 实例 E2E 与数据同源（端口纪律 · 守卫 · 四宿主导入通道）

> **来源**：2026-09-26，任务 `09-26-all-instance-data-sync-e2e`。本文件**自包含**，
> 不引用任何任务目录（那些目录不入版本库，跨机器会悬空 —— 见规则块 `L0-17` / 坑 `P-17`）。
>
> 适用：任何要**打开实例页面做自动化**、**把数据搬进实例**、或**判断某宿主能不能接收数据**的任务。

## 1. 实例登记（端口是唯一判据）

| 端口 | 实例 | 协议 | 依据 |
| --- | --- | --- | --- |
| `8001` | Dev ST | **http** | ST `config.yaml` `ssl.enabled: false` |
| `8002` | Real ST | **http** | 同上 |
| `8003` | Dev Luker | **https**（自签） | Luker `config.yaml` `ssl.enabled: true` |
| `8004` | Real Luker | **https**（自签） | 同上 |
| `8899` | PT web（`apps/web` vite dev） | **http** | `apps/web/vite.config.ts` `port: 8899` |

**三条纪律**：

1. **`P-11`：Dev 与 Real 只能靠端口区分** —— 两个宿主的版本号**完全一致**
   （ST 1.19.0 / Luker 2.7.0 在 Dev 与 Real 上相同）。误连 Real 即操作 GB 级真实聊天数据，**不可逆**。
2. **协议按各宿主自己的 `config.yaml` 决定，不要猜**。**实测教训**：首版登记表把 ST 两个实例
   写成 `https://`，被启动器的就绪探针以 `TCP 已开但 HTTP EPROTO` 抓出 ——
   **探针只信登记表里的 URL，写错了就会以「就绪超时」的形式表现出来**，容易误判成实例没起来。
3. **禁止 `8000`**（`L0-16` 出厂默认段）；实例启动一律用其 `config.yaml` 的登记端口。

目录按标准仓群布局**相对解析**：本仓 `<Tavern-repo>/My-repo/st-zip-converter` ⇒ 实例根
`<Tavern-repo>/Instance`（即本仓根的 `../../Instance`）。**不写本机绝对路径**（`P-17` / `L1-MR-14`）。

## 2. E2E 只许连 Dev —— 守卫契约

等价实现见 `e2e/lib/guard.cjs`。**白名单 = `{8001, 8003, 8899}`；`{8002, 8004}` 出现即拒绝。**

```js
const DEV_PORTS = new Set(['8001', '8003', '8899']);
const REAL_PORTS = new Set(['8002', '8004']);
function assertDevTarget(rawUrl) {
  if (!rawUrl || !String(rawUrl).trim()) throw new Error('目标 URL 未提供：拒绝静默兜底');
  const u = new URL(String(rawUrl));
  if (!u.port) throw new Error('未显式写端口 ⇒ 目标不明，拒绝');
  if (u.port === '8000') throw new Error('出厂默认段，禁止（L0-16）');
  if (REAL_PORTS.has(u.port)) throw new Error(`端口 ${u.port} 是 **Real 实例**端口，疑似误连真实数据`);
  if (!DEV_PORTS.has(u.port)) throw new Error(`端口 ${u.port} 不在 Dev 白名单`);
  return u;
}
```

**四条不可省**（`tavern-browser-automation` skill 明列）：

1. **启动时断言**，失败即非零退出（不是跑到一半才发现）；
2. **环境变量不给默认值** —— 严禁 `?? 'http://127.0.0.1:8001'`，兜底值就是误连入口；
3. **禁止自动改写目标** —— 不得因「端口被占用」回退到其它端口（改端口 = 换实例 = 换数据区）；
4. **负例自检** —— 先证明判定能抓到 Real 端口，再相信它在别处报 0。
   可执行用例：`node e2e/run.cjs --only guard` → **17 项断言全过**，其中一条验证
   `openInstance()` 对 Real 端口**在启动浏览器之前**就抛错（证明守卫真的接在自动化路径上）。

**归因纪律**：实例页面上跑着 30 个第三方扩展，整页报错**不能**算到本插件头上。
采集必须**分两栏**：整页背景（不参与判定）与**本插件归因**（URL / 位置 / 堆栈含插件 slug 的才算）。

## 3. 四宿主的原生导出/导入通道（**决定「能不能同步」**）

| 宿主 | 整包**导出** | 整包**导入** | 结论 |
| --- | --- | --- | --- |
| **ST 1.19.0** | ✅ `POST /api/users/backup`（`src/endpoints/users-private.js:156`） | ❌ **没有** —— `users-private.js` 只有 `/backup`，无任何 import/restore 路由；`public/scripts/user.js` 只实现 `backupUserData` | 只能**逐类目**喂 |
| **Luker 2.7.0** | ✅ 同路径 | ✅ `POST /api/users/restore-backup`，**`mode` 默认 `merge`**（`users-private.js:1237`、`:1264`）；`overwrite` 模式自带 snapshot 回滚（`:683`/`:886`） | **`merge` 即「覆盖同名、不删独有」** |
| **TauriTavern** | ✅ `POST /api/users/backup`（`{handle, native}`；`native:true` 落服务端磁盘）（`src/tauri/main/routes/user-routes.js:68`） | 经其 `data-migration` 系统扩展读 `data/default-user` 树 | **Tauri 桌面应用，无浏览器端口 ⇒ 不可自动化** |
| **PureTavern** | ✅ M21 导出（浏览器侧归档） | ✅ M21 导入，冲突策略 `merge`/`skip`/`replace-module`/`replace-all`；**记录 id 由自然键派生并复用本地 id** ⇒ 重复导入是**更新**而非新增 | 纯前端，**无磁盘扩展目录**（包存浏览器 Profile 的 M13 blob） |

### ST 的逐类目端面（**没有 bulk 通道**）

| 类目 | 端点 |
| --- | --- |
| 角色卡 | `POST /api/characters/import`（`characters.js:1560`） |
| 聊天 / 群聊 | `POST /api/chats/import`（`chats.js:771`，**带 `validateAvatarUrlMiddleware`**）、`POST /api/chats/group/import`（`:751`） |
| 世界书 | `POST /api/worldinfo/import`（`worldinfo.js:99`） |
| 设置 | `POST /api/settings/save`（`settings.js:206`，**整份替换**语义） |
| 背景 | `POST /api/backgrounds/upload`（`backgrounds.js:135`，**逐文件**） |
| 预设 / 主题 / QuickReplies / instruct | **无导入端点** |

**三条硬约束**：① `chats/import` 依赖角色 ⇒ **必须先导角色卡**；
② `settings/save` 整份替换会丢目标实例的自定义项 ⇒ **必须先读回再合并后写**，不能直接覆盖；
③ 预设/主题等**无法通过 API 同步** ⇒ 「源覆盖率 100%」在 ST 目标上**不可达**，
验收标准必须按**可达类目**折算。

## 3.5 备份导出通道的实测形态（大包必看）

`POST /api/users/backup` 返回 **`transfer-encoding: chunked`、没有 `content-length`**
（2026-09-26 探针实测）⇒ **必须真流式**：浏览器只用来取会话（cookie + `GET /csrf-token`），
字节由 Node 侧 `https.request` 接收直写磁盘。整包进内存或走 Playwright 的 download 事件都不稳。

**速率会塌方**：`data/default-user/backups/` 里是**已经 deflate 过**的历史备份包，
服务端仍会再压一遍 —— 实测速率从约 **7 MB/s 塌到 0.9 MB/s**。这是正常现象不是故障；
同步载荷若已排除 `backups/`（`convert()` 的 `includeBackups` **默认就是 `false`**）则不受影响。

## 4. 实例生命周期

- 启动前**先查端口是否已在监听**：已在运行就**幂等跳过**，不要重复拉起（本机取证时
  `8003`/`8004` 常常本来就在跑）。
- 就绪判定用**有界等待**（`L1-MR-7`）：轮询 TCP + HTTP，超时即杀进程并非零退出，绝不已 pending 收场。
- **收尾只关「本次启动」的实例**，别人原本在跑的实例保持原样。
- 日志与产物落 `test-results/`（已被 `.gitignore` 覆盖）；**严禁**写进 `Instance/**`。

## 5. 数据搬进实例时的语义纪律

- **「覆盖同名、不删独有」= 目标原生的 `merge` 语义**（Luker `restore-backup` 的 `mode=merge`、
  PT M21 的 `merge`）。**不要**用 `overwrite` / `replace-all`，也不要裸文件拷贝 ——
  裸拷贝会绕过宿主的类目映射与别名规则，造出「看起来一样、宿主不认」的假同源。
- **写入前**对每个目标做一次**只读清单快照**（相对路径 + 大小 + mtime），
  事后才能**精确报出**被覆盖的路径。快照是**取证**，不是回滚 —— 别把两者混为一谈。
- **核对判据**：正确的不变量是「**产出的包 → 目标**」覆盖率 100%（因为 `convert()` 本就按目标
  设计内丢弃类目，如 L 目标丢 `image-metadata.json`、派生缓存 `thumbnails/`/`backups/`/`vectors/`；
  而 PT 目标会把用户级 `extensions/<name>/` 迁移为 third-party 布局）。
  **拿原始源目录当分母算覆盖率是错的**，永远到不了 100%。

## 6. 交付包校验：断言必须有判别力

产包/交付物验收**不要**写「体积看着差不多」这类断言 —— 它永远通过。
断言要么取自**实测基线**，要么由**负例**证明它真的会失败。

### 6.1 各目标的布局判据（**从源码取，别凭印象**）

| 目标 | 条目名应当 | 源码依据 |
| --- | --- | --- |
| `l` / `st` | **摊平** —— 无一以 `data/` 开头（源是 Luker 备份的 `hubPath` 形态，本身没有 `data/` 这一层） | `transform.js:718` `targetEntryPath` |
| `tt` / `pt` | **全部**落在 `data/` 之下 | `transform.js:111` `DATA_PREFIX`、`:762` |

> ⚠️ **踩过的坑**：TT 目标的条目**并非全部**带 `data/default-user/` 前缀。
> `data/extensions/third-party/`（全局第三方扩展，`transform.js:104`/`:760`）与
> `data/_tauritavern/extension-sources/`（扩展来源记录，`:105`/`:939`）**同样合规**。
> 第一版断言写成「100% 带 `data/default-user/`」，结果对**完全正确的包**报错。
> ⇒ 正确判据是「**全部落在 `data/` 数据根之下**」，`data/default-user/` 的占比只作**读数报告**。

### 6.2 计数基线（取自源包实测，别猜）

Real Luker 真源包（1602.7 MB / 8683 条）实测的一级构成：

| 一级条目 | 源包 | 产包 | 说明 |
| --- | --- | --- | --- |
| `chats/` | **1029** | **1029** | 同步后应原样出现在各目标包里 |
| `characters/` | **430** | **430** | 同上 |
| `extensions/` | 6597 | **5774** | 差的 823 条是 `.git` 内部冗余，被产品安全清洗剔除 |
| `backups/` | 111（2479.5 MB） | **0** | `includeBackups` 默认 `false` ⇒ 同步时排除 |
| `user/` | 191 | 191 | — |
| `worlds/` / `backgrounds/` | 21 / 23 | 21 / 23 | — |

`backups/` **零条目**值得作硬断言：它占源包 **64% 体积**，混进来的第一信号就是包体积暴涨 ——
而**体积暴涨恰恰是「看着差不多」派最容易放过的东西**。

### 6.3 可执行校验（**正例 + 负例都要跑**）

```bash
# 正例：三个包一起校验（A1 存在且 >100 MB / A2 backups 零 / A3 类目计数 / A4 布局）
node scripts/instance-sync/verify-packs.cjs --stamp <yyyymmdd-hhmmss>

# 负例：拿**源包**当输入（它含 111 条 backups/、且是摊平布局）
node scripts/instance-sync/verify-packs.cjs --kind luker --file <源包>.zip   # A2 必失败、退出码 1
node scripts/instance-sync/verify-packs.cjs --kind tt    --file <源包>.zip   # A4 必失败、退出码 1
```

**负例是这套装置可信的前提**：2026-09-26 实测，正例全过**且两条负例都正确报错并退出码 1**，
才确认 A2/A4 真有判别力（也正因跑负例，才暴露出 6.1 那处断言写错）。
