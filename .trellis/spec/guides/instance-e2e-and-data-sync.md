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

## 11. 功能矩阵 E2E 的实现纪律（2026-09-26 第五轮实证；2026-09-27 增补 §11.1b / §11.6 / §11.7）

> 本节全部判据都来自 `e2e/specs/matrix.e2e.cjs` 与 `e2e/lib/harness.cjs` 的实测。
> 该 spec 覆盖 **M-1…M-10b**，并在**两个 Dev 实例（dev-st / dev-luker）各跑一遍** ⇒
> 单轮 = **断言 182 项 / 通过 182 / 失败 0（exit 0）**（2026-09-27 实测：**连续三轮全绿**）。
> 全量 `npm run e2e`（guard + matrix + smoke）= **断言 235 项**；
> ⚠️ 其中 **smoke 的"插件已挂载"一组在机器高负载时会超窗**（它只等 20 s，而矩阵等 40 s）
> —— 见 §11.6 的独占机器纪律；空载实测插件挂载**稳定**（连开 3 次页面，3/3 在 25 s 内挂上）。

### 11.1 打开插件工作台：必须走真实路径，且「可见」要单独断言

冒烟 spec 只用 `querySelector` 查**存在性**，所以一路绿灯；矩阵要**真实点击**，立刻暴露两层：

1. **宿主的扩展抽屉默认是关着的**。插件设置面板整体挂在
   `#rm_extensions_block.drawer-content.closedDrawer`（`display:none`）之下 ⇒
   即便展开插件自己的 `#st_zip_converter_settings`，抽屉内控件
   `getBoundingClientRect()` 仍是 **0×0**，Playwright 的 `click` / `selectOption`
   会以 `element is not visible` **超时 30 s** 才失败。
2. **打开路径的文案跨宿主不同**：ST 是「扩展程序」、Luker 是「扩展」
   ⇒ **只能按 class 定位**。

固化为 `openWorkbench()` / `openHostExtensionsDrawer()`（`e2e/specs/matrix.e2e.cjs`）：

```
openHostExtensionsDrawer() —— 打开宿主扩展抽屉，**不依赖聊天区消息**：
  ① #extensions-settings-button > .drawer-toggle          ← 宿主原生开关，**优先**
  ② .drawer-opener[data-target=…] → 再点 #<target> > .drawer-toggle（回退；与①语义相同）
  ③ 任意 [id*=extension].drawer 的 .drawer-toggle          （兜底）
  → 有界等待该抽屉 .drawer-content 有非零尺寸且 display ≠ none
openWorkbench() 继续：
  → 展开 #st_zip_converter_settings 的直接子 .inline-drawer-content
  → **有界等待 #target-select 有非零尺寸**（这一步才是「控件真实可用」的判据）
```

### 11.1b 锚点必须锚在宿主**静态 DOM** 上，不得锚在会被消费掉的 UI 上（2026-09-27 实测）

旧版 `openWorkbench` 走「点 `#extensionsMenuButton`（魔法棒）→ 点菜单里带 `.drawer-opener` 的项」。
2026-09-27 实测该路径**两实例同时失效**：全页 `.drawer-opener` 为 **0**、
`#extensionsMenuButton` 点不动（Playwright 30 s 超时），而实例端面健康、插件已就绪。
当时的排查一度判为「宿主侧阻塞（宿主把菜单按钮隐藏了）」，**实际是锚点选错**：

- `.drawer-opener` 的**唯一来源**是宿主**聊天区的系统消息模板**
  （`templates/welcome.html:49` / `welcomePrompt.html:10`，均带
  `data-target="extensions-settings-button"`）。它**不属于魔法棒菜单**。
  聊天区没有这条系统消息时（实测 `#chat .mes` = 0）全页一个都没有。
  **取证方式**：对实例 `public/scripts/extensions/third-party/` 全目录 grep `drawer-opener`
  —— 命中项只有**本仓副本自己的**文档与 spec，**没有任何宿主扩展注入它**。
- 空聊天下宿主的发送表单是隐藏的 ⇒ `#extensionsMenuButton`（`templates/wandButton.html`，
  由 `addExtensionsButtonAndMenu()` 挂进 `#leftSendForm`）随之**不可点**。
  于是「重启实例 / 全新 profile / 页面 reload」三种尝试全部无效（当时逐一试过，都无效）。
- 真正该用的锚点是宿主**静态存在**的 `#extensions-settings-button.drawer`
  （`public/index.html:5750`）里的 `.drawer-toggle`：实测 **36×32 可见**，
  且 `public/script.js:12150` 对它**有直接绑定**
  `$('.drawer-toggle').on('click', doNavbarIconClick)` ⇒ 与聊天状态**完全无关**。
  （对照：`.drawer-opener` 走的是 `script.js:10935 doDrawerOpenClick`，
  它做的事就是「取 `data-target` → 找 `#<id> .drawer-toggle` → 点它」——**同一条路，只是多绕一层**。）

**通用纪律**：E2E 的开场锚点要指向**宿主 HTML 里的静态节点 + 原生直接绑定的事件**。
凡是「由宿主运行时渲染、且可能被消费或替换」的节点 —— 系统消息、一次性引导提示、
随机 id 的弹层、随会话状态显隐的按钮 —— 都不能当锚点：
它们会让整个 spec 的失败形态**伪装成「宿主坏了」**，把排查引向宿主源码与实例健康度（本次即如此，
白查了重启实例、全新 profile、宿主源码、扩展开关四项）。

**三个具体的坑**（都实际踩过；**前两条对任何宿主菜单都成立**，第三条只作用于回退路径）：

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

### 11.3 断言的判别力：七种「红灯其实来自断言自己」

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
| 「暂停窗口夹具 > 40 MB」（2026-09-27） | **陈旧阈值**：`ensurePauseFixture` 早已从「48 × 1 MB」改成「1500 × 3 KB」（多条目、少字节，为减持久化 profile 负担）⇒ 该断言在**正确实现下恒假**。**阈值必须与实现的 `minBytes` 同源**，改实现时同步改断言 |
| 「续传日志含『沿用断点跳过 N 项』」（2026-09-27） | **读了折叠态的 DOM**：`log-console.js:262` 在面板折叠时直接 `return`，不往 `#log-stream-container` 追加任何行（只更新「最新一条」与徽标）⇒ 折叠态读到的永远是占位符「暂无日志记录」。**先展开再读**（`readLogText()` 点 `#btn-toggle-log`，这也是真实用户动作） |
| 「native == 显式 st」（2026-09-27） | **陈旧读数的竞态 —— 同时制造假红与假绿**：`l` 与 `st` 的读数**模式完全相同**（「直通 7 合成 1 丢弃 4 产物 8」，只有字节数 826.0 B / 870.0 B 不同），而 `selectOption` 后按该模式等待会**立刻返回上一个状态的陈旧读数**。ST 宿主上该断言因此**恒假**；Luker 宿主上却因「陈旧值恰好等于期望值」**侥幸变绿**。**修法**：切目标先经过一个**读数必然不同**的中间态（`tt` ⇒ 路由 7 / 产物 7），落地后再切目标值。**纪律**：`selectOption` + 模式等待只保证「屏幕上出现了这个模式」，**不保证它是新状态算出来的** |
| 「M-9 分卷产出 > 1 份」（2026-09-27） | **`page.fill` 静默不写入**（最隐蔽的一种）：宿主 ST 的 splash / 弹窗 —— `<dialog open>` 内含 `#loader.splash-screen` —— 未关闭时，`document.activeElement.tagName === 'DIALOG'` ⇒ Playwright 的 `fill`（focus + insertText）**不报错但一个字符都没写进去**；同一状态下 `page.click` / `pressSequentially` 会**超时**（指针事件被弹窗吞掉）。后果：M-9 的「1 MB 阈值」没生效 ⇒ 分卷退化为单包 ⇒ 三条断言红，而现场毫无异常（元素可见、`disabled=false`、`readOnly=false`、`value` 读作空串）。**修法**：`fillNumber()` —— 填完**校验取值**，失效则退回程序化赋值 + 派发 `input`/`change`，并把走过的路径落进断言证据。**纪律**：凡 `fill`／`selectOption` 之类「失败也可能不抛错」的交互，都要**回读一次取值**；这也解释了「同一 spec 一个实例绿、另一个红」的最常见成因 |

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
npm run e2e                      # 全量：guard + matrix + smoke（2026-09-27 读数：断言 235 项）
node e2e/run.cjs --only matrix   # 只跑功能矩阵（**182 项**；需 :8001 与 :8003 在跑，且**先热身**）
```

前置：`:8001`（Dev ST）与 `:8003`（Dev Luker）在监听**且已热身**（见 §11.7）；
夹具由 spec **现场生成**到 `test-results/fixtures/`（`.gitignore` 覆盖，**不入库**）。
⚠️ 跑之前确认**没有别的会话在同一批实例上跑测试** —— 共用持久化 profile + 共用实例，
并发会让双方读数都不可信（实测：并发期间 smoke 的挂载断言与 `npm test` 的 5 s 超时同时抖动）。

### 11.6 跑矩阵时**独占机器** —— 负载型假红的唯一来源（2026-09-27 实测）

矩阵有若干**按墙钟计时**的有界窗口（M-9 分卷 240 s、M-7b 暂停窗口、`openWorkbench` 15 s），
而机器同时跑着两个酒馆实例 + 浏览器 + 编辑器，余量很小。2026-09-27 实测：

- 本轮 dev-st 的 **M-9 只切出 1 份分卷**（应 8 份）⇒ 三条断言红；
- **同一轮、同一 spec、同一份代码**的 dev-luker 同段**通过（8 份）**；
- 根因：当时**并发跑了 `npx vitest`**（55 个测试文件默认并行）造成负载尖峰。

**纪律**：
1. **跑矩阵期间不跑 `npm test` / 构建 / 大批量脚本**（反之亦然）——
   两者都是 CPU 密集且都有时间敏感的用例，并发只会同时污染两边的读数。
2. 同理，`npm test` **自身**在本机满载时也会出现 `Test timed out in 5000ms` 抖动
   （仓内未配 `testTimeout`，默认 5 s）：判别实验是 `npx vitest run --testTimeout=30000`
   —— 若它全绿，则红的是负载不是代码（2026-09-27 实测：默认超时下 10/9/13 项红，
   30 s 下 **514 passed / 2 skipped / 0 failed**）。
3. 出现「只在一个实例上红、另一个实例同段绿」的形态时，**先怀疑负载与陈旧状态**，
   不要急着去改代码 —— 这是本轮与上一轮各踩一次的同一个坑。
4. **跨会话同样要独占**（`P-18` 同族，2026-09-27 实测）：本机多个 agent 会话**共用**这两个实例
   与**同一个持久化 profile**。实测当时另有会话在跑 `test-browser.js` 与 `npx vitest`
   （还有一条 18:45 启动后就再没退出的僵尸 `e2e/run.cjs`），并发期间：
   - `npm test` 出 5 s 超时抖动（同一份代码三次读数：10 / 9 / 13 项红，且红的用例集每次不同）；
   - 全量 e2e 的 **smoke 段**（只等 20 s 挂载窗口）在**两个实例上**同时失败，
     而同一轮的 **matrix 段**（等 40 s、且先跑）零失败 —— 加载窗口不够 ≠ 功能坏了。
   **判据**：`matrix` 绿而 `smoke` 的挂载断言红、且**重启实例 + 热身**后单跑即绿 ⇒ 是负载。
   **纪律**：跑之前用 `Get-CimInstance Win32_Process` 扫一眼有没有别人的 `vitest` / `test-*.js` / `e2e/run.cjs`；
   拿不到干净读数时，**宁可如实报告"环境碰撞"也不要调宽断言**。

### 11.7 宿主**冷启动窗口**：插件可能根本没挂载（2026-09-27 实测）

**现象**：重启 Dev Luker 后**第一次**页面加载，整套矩阵失败 —— `#env-badge` 不存在、
`#st_zip_converter_settings` 不存在，而**同一轮里宿主侧的 `#extensions-settings-button > .drawer-toggle`
点击是 OK 的**（⇒ 宿主正常，是**我们的插件 JS 没跑**）。**同一次运行的第 2 次加载（reload）即恢复**，
其后一轮 182 项全绿。

**机理**（`src/ui/host-bridge.js:319 detectHost()`）：它是**一次性判定** ——
Luker 分支要求 `globalThis.lukerContext` 是**对象**（源码注释自己写了
「lukerContext 惰性 getter 在宿主脚本未就绪时可能抛错」）。冷启动窗口里该 getter 尚未装好
⇒ 判定落到 `standalone` ⇒ `bootstrap()` 走**独立态分支**、找不到 `#app` 骨架
⇒ **只留一行 `logger.warn` 后 return** ⇒ 用户观感是「扩展有时不出现，刷新一下就好」。

**纪律（两条，都别省）**：

1. **跑矩阵前先把实例"热身"**：让宿主完整启动并成功加载过一次扩展（一次页面加载即可）再开跑。
   矩阵自身的第一步虽是 `resetWorkspace`（含 reload），但**它救不了"这次加载压根没挂载"**。
2. **「插件没挂载」与「插件挂了但 UI 不对」要能区分**：前者是宿主/加载期问题，后者才是插件问题。
   判据：看宿主侧的 `#extensions-settings-button` 在不在 —— **它在而 `#env-badge` 不在 ⇒ 加载期问题**。

⚠️ 这条同时是一个**候选产品缺陷**（面向真实用户的静默失效，不只是测试问题）：
`bootstrap()` 在「判为独立态但页面无 `#app` 骨架」这一组合下有界重试 `detectHost()` 即可修
（该组合是「宿主未就绪」的强信号，不会误伤真独立态）。**本任务按 C-6 只登记未修**。

### 11.8 驱动**宿主拉取**路径：把成本压住 + 三处「流程理解」型假红（2026-09-28 实测）

宿主拉取（`#btn-host-fetch`）此前**没有任何 E2E 驱动过**（矩阵只走上传包）。补上时踩了四处，
其中三处**不是**超时不够、而是对流程的理解错 —— 换任何超时都修不好。

**先压成本**（否则一条用例就是几分钟起）：

- **ST 端点不支持 selection** ⇒ 拉就是全量（dev-st 实测 1.5 GB）⇒ 不适合做用例；
- **Luker 端点支持 selection** ⇒ 只勾**一个**类目即可把量压到几十 MB；
- ⚠️ **绝不能勾 `settings`** —— Luker 会隐含打包 `backups/`（GB 级历史快照，规范 §… 已记）；
- ⚠️ **但必须包含布局判据之一**（`characters/` 或 `settings.json`），否则拉回来的包认不出布局、
  转换阶段如实报错，反而掩盖你要验的东西。实践取 `characters`（≈40 MB）。
- 成本大的分支用**环境变量开关**（如 `SZC_HEAVY_HOSTPULL=1`）与快档共存：默认跑快档，
  重档（真拉 `chats` ≈670 MB）只在显式开关下跑 —— **不要**把几分钟的用例塞进他人的默认跑。

**四处假红**（前三条通用）：

1. **宿主 DOM 就绪 ≠ 插件已注入**：必须等 `#env-badge` 脱离模板初值「检测中...」
   （Luker 实测十几秒，负载高时更久 ⇒ 上界给 120 s）。只等 `#send_form` 会得到
   「抽屉不存在 / 按钮不可见」的连锁假红。
2. **抽屉要开两层**：插件抽屉**嵌在宿主扩展设置抽屉里**。只对插件抽屉内容强制
   `display:block` 不够 —— 祖先隐藏时 Playwright 一律判「不可见」，点击超时。
   正确顺序：先点宿主原生 toggle（`#extensions-settings-button .drawer-toggle` /
   `.drawer-opener[data-target=…]`），再展开插件抽屉。
3. **「点了按钮」不等于「设置生效」**：`if (btn) btn.click(); return true` 这种写法，
   按钮不存在时**照样返回 true**。收缩拉取量的 selection 必须**回读**（读回所有类目勾选态，
   断言只剩目标那一个）—— 否则会静默拉全量、几分钟都到不了你要验的那一步。
   本仓既有纪律「填值一律回读」同样适用于**点击类副作用**。
4. **中止要走出那条分支自己的出口**：注入发生在**文件树扫描之前**，之后流程停在
   「统一文件树确认」等待用户确认 —— 此时任务控制条**本就该可见**（任务在跑）。
   只点 `#tc-abort` 不会结束那个等待；必须点 `#btn-host-tree-cancel`（该分支才 abort + 隐藏控制条）。
   另：日志面板**折叠时不追加行**（只计数）⇒ 任何 `waitLogMatch` 之前要**先展开**；
   日志正则要用 `[\s\S]*` 而不是 `.*`（面板 textContent 每条之间是换行）。



> 本节全部读数来自 `scripts/instance-sync/import-pt.cjs` 的实跑与
> `research/pt-sync-readings.md`。PT 侧路径相对 `Instance/Dev/PureTavern`。

### 12.1 第一纪律：**PT 的 `/api/*` 不是服务端后端，必须走页面内 `fetch`**

PT 把 ST 的客户端 API 在**浏览器里**重新实现了一遍：

- 路由注册在 `apps/web/src/features/import-export/legacy/register-routes.ts`，
  挂到 `CompatibilityRouter`；
- `apps/web/src/legacy-hook/bootstrap.ts` 用
  `installCompatibilityFetch(router)` **补丁页面内的 `window.fetch`** 使其生效。

**推论（很重要）**：用 Node 侧 / Playwright 的 `request` 去探这些路径会拿到 **404**，
**但那是探查方法的伪影，不代表能力缺失**。实测对照：

| 探测方式 | `POST /api/backups/archive/inspect` | `POST /api/backups/tauritavern/import/preview` |
| --- | --- | --- |
| **页面内 `page.evaluate(fetch)`** | **200**（返回真实的 659 records / 329 blobs） | **400** `{"code":"missing-file","pureTavern":true}` |
| 页面外（Node / request） | 404 | 404 |

**400 而不是 404** 就是「路由存在、只是缺参数」的证明。
⇒ 判定 PT 有什么能力，**只能**在页面内发请求。

**顺带更正**：`apps/remote-server` 是 **LLM 请求代理**（其 README 明写只有
`GET /v1/health` 与 `POST /v1/proxy`），**与备份/导入无关** ——
「起 remote-server 就能导入」是错的，起它对同步零帮助。

### 12.2 实际通道：宿主数据管理面板

面板是**独立 `<dialog id="pure-tavern-data-management-dialog">`**，
由设置里的「**打开数据管理**」按钮打开。
⚠️ **它不是「点设置项抽屉展开」就能看到的** —— 按后者写自动化会得到
「文件设进去了但流程没起来」（截图里面板根本没打开）。

面板内两组导入控件（`apps/web/src/features/import-export/runtime/index.js`）：

| 控件 | 用途 |
| --- | --- |
| `#ptdm-import-file` + `#ptdm-import-method` | PT 自家归档（`fast` / `slow`） |
| `#ptdm-tt-import-file` + `#ptdm-tt-strategy` | **TT 归档**（本项目产出 TT 布局树 ⇒ 走这组） |

`#ptdm-tt-strategy` 默认 **`merge`**（「合并并覆盖冲突」）—— 与 U-3「覆盖同名、不删独有」一致。
**`#ptdm-import-method` 是两组共用的全局选择框**（`selectedImportMethod()` 读它）：
`fast` = 整包解压进内存，`slow` = 逐文件低内存 ⇒ **大包必须 `slow`**。

### 12.3 四个必须踩过的坑

| # | 坑 | 症状 | 正确做法 |
| --- | --- | --- | --- |
| 1 | 只投文件不开始 | `setInputFiles` 后**毫无反应**（计数不动、无任何提示） | 必须点「执行 TauriTavern 导入」（`#ptdm-tt-import-confirm`） |
| 2 | 按钮**预览前 disabled** | 投完就点 ⇒ 拿到「被禁用」，流程**静默不走** | 投文件只触发**异步预览**（`previewTauriTavernImport`：`:629 disabled=true` → `:684 disabled=false`）⇒ **等按钮启用**再点 |
| 3 | **两层确认、同一选择器** | 日志停在第一层之后再无进展 | ①模块选择（`chooseImportModules`，`:187`）点「继续」→ ②「请确认」（`confirmAction`，`:150`）点「确定」，**两层都用 `[data-action="confirm"]`**，用「层内有无 `[data-action="all"]`」区分。且**中间隔着逐文件 CRC/SHA-256 校验**（7209 文件 / 1.16 GB 实测数分钟）⇒ 必须**按时长预算**持续等待，不能固定轮数 |
| 4 | 完成信号是**页面 reload** | 计数明明已增长，却判「超时未检出完成信号」 | 源码 `notify('success', …)` 之后**立刻** `setTimeout(location.reload, 500)` ⇒ 浮层只存在约 500 ms，秒级文本轮询**必然错过** ⇒ 用 `framenavigated` 事件作判据 |

### 12.4 存储风险：**「尽力而为」不是提示音**

PT 数据落 **IndexedDB**（无磁盘目录，`e2e/lib/instances.cjs` 的 `pt-web.userDir` 为 `null`）。
实测面板读数：存储模式 **「尽力而为」**、用量 **660.5 MB** / 配额 **10.6 GB**、**本地恢复点 3 个**。
面板自己的警告原文：

> 浏览器未授予持久化存储：磁盘空间不足时，**它可能在不通知的情况下清除本站的全部数据**。
> 建议定期导出 ZIP 备份到本地磁盘。

⇒ **PT 自带的「本地恢复点」也在同一个 IndexedDB 里，不构成异地冗余**。
`import-pt.cjs` 对 >100 MB 的包**默认拒绝执行**（需显式 `--allow-large`），
把风险摆到明面上，而不是替用户默默决定。

### 12.5 核对：路径比对**不可用**，只能用模块读数

PT 无磁盘目录 ⇒ `diff-report.cjs` 那套**按路径比对在 PT 上根本不可用**。
唯一可程序化读到的真源是：

- **IndexedDB 逐库逐 store `count()`**（键形如 `模块␟类型␟标识`，
  如 `chats␟messages␟<uuid>`、`characters␟cards␟<uuid>`）；
- **面板逐模块读数**（`#ptdm-modules .ptdm-module-row` 的 `N records · M blobs · X MB`）——
  界面上的模块条目会被虚拟滚动截断，**不能**当判据。

`import-pt.cjs --report` 就是这两者的只读出口。

**已实测可用的三条判据**（按可信度排序）：

1. **体积吻合**：PT 侧各模块体积合计 ≈ **1161.6 MB** = 源包未压缩 **1.16 GB**（精确吻合）；
2. **角色目录数**：源 `chats/<角色>/` 目录数 **23** = PT `chats|owner-aliases` **23**；
3. **归一后的系列计数**：源侧 `孤独摇滚1/2/2_1/3/3_1` 在 PT 侧归一到 `孤独摇滚`
   ⇒ 131+9+1+1+22+1 = **165** = PT 侧 **165**。

⚠️ **计数口径陷阱（本任务内第三次遇到同形坑）**

**纪律：对照之前先问「这两个数字量的是同一件事吗？」** —— 本仓已经栽了三次：

| 次数 | 拿什么去对什么 | 真相 |
| --- | --- | --- |
| ① 缺陷 F-4 | 「430 张角色卡」 | 那是**版本化 blob 的条目数**，实际只有 **26 个角色** |
| ② 缺陷 F-2 | 卡片名取 `card.name` | V3 卡的 name 在 **`card.data.name`** ⇒ 38 张卡被打回 sha256 兜底名 |
| ③ 本节（chats） | 「1029 条聊天」 | 那是**文件条目数**：**223** 真聊天 `.jsonl` + **786** `.luker-state.*` + **20** `runs/**` |
| ④ 本节（characters） | 「29 个人类名条目」 | 其中 **4 条不是卡片**（3 个 `.css` + 1 个 `.state.*.json`）⇒ 真卡片 **25** 张 |
| ⑤ 本节（卡片名） | 源侧**落盘名** vs PT 侧卡名 | `【Sgw】又看一集.png` 的**卡片内 name 实为 `朝月`** ⇒ 必须先解包取 `chara` 里的 name（复用 `lib/luker-card-adapter.cjs` 的 `extractPngCardName`） |

⑤ 的成品对照结论：**PT 侧 25 张卡 = 源包 25 张卡，逐张对应，零丢失**
（`default_Seraphina`→`Seraphina`；`孤独摇滚1/2/2_1/3/3_1`→6 张同名 `孤独摇滚`；
`恋爱饥饿症4.11`→`恋爱饥饿症4.1`；`新艾利都1`→`新艾利都`）。

PT 的 chat 模型另需记住：**每个聊天 = 1 条 `messages` + 1 条 `sessions`**
⇒ 222 个聊天 = 467 条记录 ✓ 与面板读数自洽。

### 12.6 复现命令

```bash
# 只读核对：打印 PT 侧模块读数与配额（不导入任何数据）
node scripts/instance-sync/import-pt.cjs --report

# 真导入（策略默认 merge、方式默认 slow；>100 MB 需 --allow-large）
node scripts/instance-sync/import-pt.cjs --pack <pack-tt-*.zip> --allow-large --timeout 3600000
```

### 11.9 第 4 宿主 **PureTavern** 的加载冒烟（2026-09-28 实测 9/9 全绿）

PT 此前**没有任何自动化**（`smoke.e2e.cjs` 的 `requiresInstances` 只有 dev-st / dev-luker，且部分断言
绑定了宿主名）。新增 `e2e/specs/pt-load.e2e.cjs`（`requiresInstance: 'pt-web'`，端口 **8899** 在白名单内）
只做**与宿主无关**的判读：插件抽屉注入、工作台容器渲染、五项关键控件齐全、平台徽标脱离模板初值、
**零本插件报错/失败请求**。

两条**实测事实**（别按直觉臆测）：

1. **PT 上「从宿主拉取」是可见的** —— PT 以 ST 兼容宿主自居（徽标「SillyTavern 插件」、
   有 `#extensions_settings` 与菜单锚点）⇒ `host.isPlugin` 为真 ⇒ 按钮按可用性求值显示。
   ⚠️ **本页曾写错一次**：最初断言"PT 纯前端 ⇒ 该按钮应不可见"，那是**臆造**；
   那次量到 `visible=false` 的真因是**宿主的扩展抽屉没打开**、祖先隐藏导致按钮没有尺寸
   —— 量的是"祖先隐藏"，不是"插件隐藏了它"。**教训**：判可见性前先把两层抽屉打开，
   否则你量的是祖先的样式，而不是被测控件的状态。
2. **平台徽标显示「SillyTavern 插件 · v1.18.0」** —— PT 兼容 ST 的这批 id，故走 ST 分支；
   扩展设置面板 / 菜单锚点 / 抽屉注入在 PT 上都在（`extPanel=true`、菜单锚点存在）。

**就绪等待要给足**：PT 实测 t+15 s 仍在「正在初始化…」，**t+30 s** 插件抽屉才出现 ⇒ 上界给 90 s
（与 ST 的 splash 同类；夹具里已有「等 splash 关闭」的处置，见 `harness.cjs`）。

**PT 的扩展在浏览器侧**（无磁盘用户目录）⇒ 本仓 e2e 登记表里 `pt-web` 的 `userDir: null`；
装/卸扩展走 PT 自身流程，不要试图往磁盘目录里塞文件。

### 11.10 运行器有两个「选择目标」的开关，别用错（2026-09-28 实测）

| 开关 | 作用 | 何时用 |
| --- | --- | --- |
| `--instance <id>` | 只跑该 spec **声明过的**其中一个实例 | 想「只跑 dev-luker」时用**这个** |
| `--url <base>` | **覆盖该 spec 的每一个实例**（循环里逐实例覆盖） | 实例换了端口/地址时用；**不要**用它挑实例 |

⚠️ **踩过的坑**：`--url` 指向 A 时，声明 `['dev-st','dev-luker']` 的 spec 会把 B 那一轮也跑到 A 上
⇒ 「拿 A 的页面去满足 B 的宿主名断言」⇒ 一堆看着像产品问题的红（当晚误判过一次）。
现在运行器在「`--url` + 多实例」时会打印**显式告警**，`--instance` 传了未声明的 id 会**明确报错**。

**可交付的双轮口径**（本仓纪律「连续两轮同读数」）：

```bash
npm run e2e -- --only matrix --instance dev-luker   # 该实例完整矩阵；实测连续两轮 91/91、断言行集合逐条一致
```
