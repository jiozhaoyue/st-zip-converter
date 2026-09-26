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

---

## 7. 覆盖率判定的三条口径（2026-09-26 第三轮实证；**照抄会误报**）

「同步成功」的不变量是「**包 → 目标**每条都到」。但**同一句不变量在三类目标上要用三种口径**，
口径错了会得到**看起来像失败的成功**（或反之）。判定核心 `scripts/instance-sync/lib/t1-coverage.cjs`
（纯函数，单测 `test/instance-sync-t1-coverage.test.js` 15 项，**含负例**）。

### 7.1 口径一：路径比对（Luker 目标、以及一切非角色卡类目）

Luker 的原生存储**就是**包内那套内容寻址 blob ⇒ 逐路径比对正确。
**实测**：Real Luker `7177/7177`、Dev Luker `7177/7177`。

### 7.2 口径二：宿主命名规则（**ST 目标的角色卡**）

包内角色卡是 `characters/<sha256>`（内容寻址），而 ST 一律写成 `characters/<角色名>.png`
（`characters.js:257` `path.join(directories.characters, `${outputFile}.png`)`，
`outputFile` = `preserved_name` 经 `path.parse().name`）。
⇒ **逐路径比对在 ST 上恒假**：实测同一份数据，只用路径口径报 **94.75%**，改用「先路径、后落盘名」报 **100%**。

```bash
# 规则实现在 lib/luker-card-adapter.cjs；先看「包内条目 → 宿主落盘名」的映射与版本归并读数
node scripts/instance-sync/diag-st-char-map.cjs --pack <pack-st.zip> --target dev-st --list 20
# 需要「应有的角色名清单」时（清理/核对用）
node scripts/instance-sync/diag-st-char-map.cjs --pack <pack-st.zip> --target dev-st --dump-names /tmp/names.json
```

**判定要报出「按规则命中」的条数**（本次 380 条），否则规则与路径无法区分，等于偷偷放水。

### 7.3 口径三：单列不判的三类（**登记 ≠ 放过**）

| 类别 | 例子 | 为什么不算同步的账 |
| --- | --- | --- |
| 合成元数据 | `_convert/**`、`manifest.json` | 宿主按设计跳过（Luker 回执 `path_not_in_selected_categories`） |
| Luker 私有状态 | `characters/<名>.state.<编辑器>.json` | ST 无对应机制（走 `characters/import` 得 400） |
| **宿主自管缓存** | `backups/**`（Luker restore 前轮换）、`thumbnails/**`（ST 导入成功即失效，`characters.js:1591`/`avatars.js:52` → `thumbnails.js:83-92` 的 `unlinkSync`） | 执行者是**宿主**、对象是**可重建的派生缓存** |
| **链接子树内** | junction / symlink 指向的目录（Dev Luker 的 `extensions/ST-BgLoader`） | 那是**别人的活工作区**，随对方仓漂移 |

判据写在 `HOST_MANAGED_CACHE` 与 `compareCoverage({ linkedRoots })` 里，**都有负例单测**：
「缓存目录之外的必须仍算真删除」「链接根之外的缺失仍必须判缺失」。
⇒ 加白名单时**必须同时加负例**，否则白名单会一路长大到把判定吃光。

## 8. ST 角色卡的落地形态（拆壳 · 归并 · 精灵图）

`lib/luker-card-adapter.cjs` 是**唯一实现**（导入器 `import-st.cjs` 与诊断器
`diag-st-char-map.cjs` 共用，避免两处推导漂移）。

1. **拆壳**：Luker 把角色卡存成 KV 外壳 `{"key": "…/孤独摇滚.png-1771010065094.1455", "value": "<卡片 JSON 字符串>"}`
   ⇒ 取 `value` 解析成标准卡片再投递。**V2 卡名在 `card.name`、V3 卡名在 `card.data.name`，两处都要认**。
2. **键尾名字的两个陷阱**：① **先剥版本戳再剥扩展名**（反了会落成 `x.png.png`）；
   ② 键**只有落在 `characters/` 下才可信** —— `data/_uploads/` 的键尾是上传号，取它只会得到 `<sha>.png` 无名卡片。
3. **版本归并**：同一 `avatar` 的多条是**历史版本**（实测 430 条 → 26 个角色，平均 15.4 版，最大 250 版；
   逐份**内容指纹不同**已实证）。ST 一个名字一份文件 ⇒ **只投最新版**，否则落盘的是包内顺序最末那份。
4. **精灵图**：`characters/<角色名>/<图>.png` **不是卡片**，走 `characters/import` 得 `{"error":true}`
   ⇒ 改**同路径裸落盘**（ST 本来就按这个形态存精灵图）。
5. **落盘名必须收敛成宿主可落盘**：非法字符 / Windows 保留设备名 / 超长（带短哈希避免截断撞名），
   见 `sanitizeHostName()` 与其单测。

## 9. 写入前的链接子树守卫（**默认不穿透**）

`lib/link-guard.cjs`（单测 `test/instance-sync-link-guard.test.js`，含真实 junction 的建/拒/放行）：

- 裸落盘类目：**逐条跳过**落在链接子树下的目标路径并登记条数；
- 宿主原生 restore（一把写完、无法逐条跳）：**前置门禁**，发现链接即拒绝启动，除非显式 `--allow-links`。

**为什么必须默认拦**：2026-09-26 实测，`Instance/Dev/Luker/data/default-user/extensions/ST-BgLoader`
是指向 `My-repo/ST-BgLoader`（另一个仓、且当时**正被另一会话改动**）的 junction，
本次 restore 的 **1090 条穿透写进了那个仓的工作区** —— 这是「写入型」的 `P-18`：
不报错、读得到，但**改的是别人的东西**。

```bash
# 判定目标里有哪些链接子树（只读）
cmd //c "dir /AL \"<实例用户数据目录>\""
```

## 10. 清理「自己写错的东西」也走 PARDON（且有判据）

`scripts/instance-sync/cleanup-st-char-artifacts.cjs`（默认空转、`--apply` 才删）：
**三条判据同时成立**才删 —— 在 `characters/` **平铺**层 ∧ **不在同步前快照**内 ∧ **不等于应有落盘名**；
删除前先把 `路径 + 字节 + sha256` 落 `research/`。
意图很明确：**宁可漏删（残留看得见），不可误删**（目标侧常常没有原生备份）。

## 11. 功能矩阵 E2E 的实现纪律（2026-09-26 第五轮实证）

> 本节全部判据都来自 `e2e/specs/matrix.e2e.cjs`（**122 项断言**）与 `e2e/lib/harness.cjs` 的实测。
> 该 spec 覆盖 M-1…M-9 九条路径；全量 `npm run e2e` = **断言 175 项 / 通过 175 / 失败 0（exit 0）**，
> 且**连续两轮全绿**。

### 11.1 打开插件工作台：必须走真实路径，且「可见」要单独断言

冒烟 spec 只用 `querySelector` 查**存在性**，所以一路绿灯；矩阵要**真实点击**，立刻暴露两层：

1. **宿主的扩展抽屉默认是关着的**。插件设置面板整体挂在
   `#rm_extensions_block.drawer-content.closedDrawer`（`display:none`）之下 ⇒
   即便展开插件自己的 `#st_zip_converter_settings`，抽屉内控件
   `getBoundingClientRect()` 仍是 **0×0**，Playwright 的 `click` / `selectOption`
   会以 `element is not visible` **超时 30 s** 才失败。
2. **打开路径的文案跨宿主不同**：ST 是「扩展程序」、Luker 是「扩展」
   ⇒ **只能按 class 定位**。

固化为 `openWorkbench()`（`e2e/specs/matrix.e2e.cjs`）：

```
点 #extensionsMenuButton
 → 点 .drawer-opener（优先取文字含「扩展」者；**判可见用 getBoundingClientRect，不用 offsetParent**）
 → 有界等待 #rm_extensions_block 的 display 不为 none
 → 展开 #st_zip_converter_settings 的直接子 .inline-drawer-content
 → **有界等待 #target-select 有非零尺寸**（这一步才是「控件真实可用」的判据）
```

**三个具体的坑**（都实际踩过）：

| 坑 | 症状 | 正确做法 |
| --- | --- | --- |
| `offsetParent` 判可见 | Luker 上确定可见的宿主菜单按钮被判「不可见」（候选数 0） | 菜单是 `position:fixed`，而 **fixed 元素的 `offsetParent` 恒为 `null`** ⇒ 改用 `getBoundingClientRect()` 宽高 |
| class 名靠 dump 得到 | 选择器 `.drawer-open` 在**两实例**上都匹配 0 个元素 | 真实 class 是 **`.drawer-opener`**；先前 dump 用 `slice(0, 40)` **恰好把它截成 `drawer-open`** ⇒ **dump 必须打印完整 class**，截断的输出会制造假事实 |
| 按文案定位 | Luker 上匹配数 `0`，静默失效 | 文案跨宿主不同 ⇒ 按 class 定位，文案只作**优先级**而非判据 |

### 11.2 可重跑性：持久化 profile 会恢复上一轮的工作区

E2E 用持久化 context（`.pw-profile-dev`），而插件把当前工作区写进 IndexedDB 的
`workspace` store（`active_session`）并在下次加载时恢复（`restoreWorkspaceState`）。
后果是**同一个 spec 在两轮之间、两实例之间从不同初态起跑**，实测症状三条：

- 喂进新源包后**计划读数纹丝不动**（仍显示上一轮的包）——
  因为 `index.js:1473` 的 `if (!currentFile) { currentFile = item.file; … }`
  **只在尚无源包时采纳新文件**，否则只把文件存进 IndexedDB；
- `#stash-list` **一张卡都没有**；
- `#target-select` 一会儿 `native`、一会儿 `l`（自动推断分支 `index.js:1475` 只在 `!currentFile` 时执行）
  ⇒ 同一个 spec 在两实例上跑出**不同读数**，一红一绿。

**两条纪律**：

1. **要换源包，先清初态**：删 `workspace` store 的 `active_session` 后**重载页面**。
   **只动 `workspace` store，不删 `files` store** —— 后者是用户在该 profile 里的既有数据，
   删除的风险不对等。
2. **持久化环境里的断言一律用增量，不用绝对值**。
   反例：断言「`origin=converted` 的记录数 == 0」——第一轮绿、第二轮必红（上一轮的记录还在）。
   正例：记下**基线**，断言「本轮点击后增量 == 本轮产出数」。

```js
// 增量判定的形态（e2e/specs/matrix.e2e.cjs）
const baselineConverted = (await storedIds()).filter(r => r.origin === 'converted').length;
// … 触发动作 …
t.eq('converted 记录增量 == 本轮产物数',
  after.filter(r => r.origin === 'converted').length - baselineConverted, allNames.length);
```

### 11.3 断言的判别力：三种「红灯其实来自断言自己」

本仓纪律是「**先证明判定能抓到违规，再相信它报 0**」。反过来同样要守：
**判错方向的红灯一样要查实** —— 本轮 6 次红灯，回源码/实地取证后**全部**是断言侧问题：

| 断言 | 错在哪 |
| --- | --- |
| 「`#env-badge` 必含宿主版本号」 | **臆造契约**：版本段是按宿主可得性拼的（`index.js:703` `applyHostBadge(host.platform)` 只传 platform）⇒ Luker 有、ST 没有。应断言「已脱离模板初始值 `检测中...`」 |
| 「`#count-chars` > 0」 | **选错元素**：`count-*` 属 `#module-grid`（**宿主拉取**路径），外部包的计划走 `renderCategoryStats`（`src/ui/category-filter.js:113`），更新的是 `#plan-summary-bar` / `#action-stats-badges` / `#output-estimate-text` / `#category-checkboxes` |
| 「目标 tt/pt 应报『直通 7』」 | **把语义差异当 bug**：ST/Luker 目录形态相同 ⇒ 直通；TT 树根要套 `data/default-user/` 前缀 ⇒ 必须**路由**。正确读数是「**路由** 7」 |
| 「`.drawer-open` 选择器」 | 见 §11.1 —— **截断的 dump** 制造了不存在的 class |
| 「`offsetParent !== null` 判可见」 | 见 §11.1 —— fixed 元素恒 `null` |
| 「恢复入口仅 Luker 显示」 | **照过时注释写断言**：`computeActionAvailability`（`index.js:140`）的当前契约是 **`restore.visible = isHost && hasArtifact`**，与平台无关；`index.js:712` 那句注释描述的是**已被替换掉的旧实现** |

**通用纪律**：断言必须以**当前代码路径**为准 ——
**注释里的历史陈述不是契约**，凭据要从实现取，且要**跑一次负例**证明该断言真的会报红。

### 11.4 放大夹具必须**不可压缩**

需要暂停窗口（M-7）或切多分卷（M-9）时，迷你夹具（2.5 KB）做不到。生成放大包时：

- **反例**：用 LCG（`seed & 0xff`）造「随机」字节 ⇒ 6 MB 被 deflate 压到 **13 KB**
  （实测：3 MB 输入 → 落盘 **13582 字节**）。
  **根因**：LCG 的**低位周期极短**（低位比特周期 2^k，取最低 8 位周期仅 ~256），序列高度可压缩。
- **正例**：**SHA-256 计数器模式**（`sha256("<seed>:<ctr>")` 逐块拼接）——
  不可压缩，且**完全确定性**（可重跑）。实测落盘 **6.0 MB**，按 1 MB 阈值切出 **8 个分卷**。

```js
const crypto = require('crypto');
const bytes = (len, seed) => {           // 确定性高熵字节
  const buf = Buffer.alloc(len);
  let off = 0, ctr = 0;
  while (off < len) {
    const h = crypto.createHash('sha256').update(`${seed}:${ctr}`).digest();
    const n = Math.min(h.length, len - off);
    h.copy(buf, off, 0, n); off += n; ctr += 1;
  }
  return buf;
};
```

### 11.5 复现命令

```bash
npm run e2e                      # 全量：guard + smoke + matrix（**175 项全过、exit 0**）
node e2e/run.cjs --only matrix   # 只跑功能矩阵（**122 项**；需 :8001 与 :8003 在跑）
```

前置：`:8001`（Dev ST）与 `:8003`（Dev Luker）在监听；夹具由 spec **现场生成**到
`test-results/fixtures/`（`.gitignore` 覆盖，**不入库**）。
