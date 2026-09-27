# 实例清单与体积/内容取证

> 取证日期：2026-09-26 ｜ 方式：`ls` / `find` / `du` / `git log`（**只读**，未写入任何实例目录）
> 实例根：`D:\Repo\Tavern-repo\Instance\`

## 1. 目录与形态

| 实例 | 路径 | 形态 | 服务端扩展落点 | 用户数据落点 |
| --- | --- | --- | --- | --- |
| Dev ST | `Instance/Dev/SillyTavern` | Node 服务（可 `:8001`） | `public/scripts/extensions/third-party/<name>` | `data/default-user/` |
| Real ST | `Instance/Real/SillyTavern` | Node 服务（可 `:8002`） | 同上 | 同上 |
| Dev Luker | `Instance/Dev/Luker` | Node 服务（可 `:8003`） | `data/default-user/extensions/<name>` | 同上 |
| Real Luker | `Instance/Real/Luker` | Node 服务（可 `:8004`） | 同上 | 同上 |
| Dev TT | `Instance/Dev/TauriTavern` | **Tauri 桌面应用仓** | 运行期 data root 下的 `data/default-user/extensions/` | 运行期可选 data root |
| Real TT | `Instance/Real/TauriTavern` | 同上 | 同上 | 同上 |
| Dev PT | `Instance/Dev/PureTavern` | **纯前端 pnpm monorepo**（`apps/web`，`:8899`） | 无磁盘扩展目录（M13 浏览器 blob） | 浏览器 Profile（IndexedDB） |
| Real PT | `Instance/Real/PureTavern` | 同上 | 同上 | 同上 |

TT / PT **四个目录下均无 `data/`**（`ls` 无输出），故「离线目录同步」对这两宿主不成立。

## 2. 版本（P-11：Dev/Real 版本号完全一致，不能用版本区分）

| 实例 | `git log -1` | package 版本 |
| --- | --- | --- |
| Dev ST | `06bde939f` (2026-09-14) | `sillytavern 1.19.0` |
| Real ST | `06bde939f` | `sillytavern 1.19.0` |
| Dev Luker | `e1dbd1904` (2026-09-24) | `luker 2.7.0` |
| Real Luker | `e1dbd1904` | `luker 2.7.0` |

## 3. 体积与内容量

`data/default-user/` 一级：

| 实例 | 总体积 | 角色卡 | 聊天 | 世界书 | 主题 | 背景 |
| --- | --- | --- | --- | --- | --- | --- |
| **Real Luker** | **3.8 G** | 430 | 1029 | 21 | 5 | 23 |
| Dev Luker | 1.3 G | 73 | 733 | 14 | 5 | 41 |
| Real ST | 30 M | 29 | **0** | 1 | 5 | 23 |
| Dev ST | 30 M | 29 | **0** | 1 | 5 | 23 |

Real Luker 体积构成（`du -sh data/default-user/*/` 倒序）：

| 目录 | 体积 | 说明 |
| --- | --- | --- |
| `backups/` | **2.5 G** | 历史备份归档 —— **非活数据**，本次同步排除（用户裁决） |
| `chats/` | 670 M | 活数据 |
| `extensions/` | 356 M | 活数据（32 个仓） |
| `user/` | 154 M | 活数据 |
| `characters/` | 110 M | 活数据 |
| `OpenAI Settings/` | 37 M | 活数据 |
| `worlds/` | 22 M | 活数据 |
| `backgrounds/` | 12 M | 活数据 |
| 其余 | <1 M | — |

⇒ **排除 `backups/` 后的实际同步载荷 ≈ 1.3 G**。

## 4. Real Luker 的扩展清单（32 个，**全部是带 remote 的 git 仓**）

非 git 目录：**0 个**。远程分布：30 个 github.com + 2 个 gitee.com（`hide`、`st-chatu8`）。

`git -C <ext> remote get-url origin` 全表见 `docs/research/luker-extension-mechanics-and-git-prune.md` 同源取证；
关键点：**同步扩展可走 `git clone`（L0-1 允许路径）**。

Dev Luker 相对 Real Luker 的差集：

- **Real 有、Dev 无（12 个）**：`Acsus-Paws-Puffs` `Extension-Silence` `LittleWhiteBox`
  `Novel-Auto-Generator` `SillyTavern-Dialogue-Colorizer` `chat-companion-stats` `persona-tags`
  `shujuku-rebuild` `st-acu-visualizer` `st-persona-weaver` `st-yuzi-phone` `star`
- **Dev 有、Real 无（6 个 + 1 空目录）**：`Extension-VideoBackgroundLoader` `SillyTavern-ChatVault`
  `chat-history-backup` `chatfilesys` `st-chat-merger` `st-git-improve`、`third-party`（**空目录**）

> ⚠️ `Dev/Luker/data/default-user/extensions/third-party/` 是**空目录**，但它是 **P-10 事故形态**
> （Luker 扩展平铺，禁止嵌套 `third-party`）。本次不删任何目标独有内容（用户裁决「不删独有」），
> 故**只登记、不动手**；若后续要清理，须单独走 PARDON。

## 5. 服务端插件（`plugins/`）

| 实例 | `plugins/` 内容 |
| --- | --- |
| Dev Luker | `SillyTavern-MCP-Server` `archive-reserve` `authority` `st-git-improve` |
| **Real Luker** | **只有 `package.json` 与 `.gitkeep`，零后端插件** |
| Dev ST / Real ST | 只有 `package.json`、`.gitkeep`（ST 无服务端插件机制） |

⇒ 用户所谓「没有的部分就不要（如后端插件）」在本仓现状下**无对象**：真源 Real Luker 本身没有后端插件，
ST 也没有该机制。本任务**不做任何后端插件同步**。

## 6. 端口监听现状（**2026-09-26 更正版**）

> ⚠️ **本节曾出错并已更正**：首版用 `netstat … | grep -c "LISTENING.*:$p "` 判定，
> 该正则把顺序写反了（netstat 的列序是「本地地址 → 外部地址 → 状态」，`LISTENING` **永不**出现在端口**之前**），
> 因此**永远匹配 0**，得出「四端口全部未监听」的**假阴性**。更正后的正确判据与读数如下。

**正确姿势**：先匹配端口、再看状态，或直接 `awk '$2 ~ /:PORT$/ && $4=="LISTENING"'`。

| 端口 | 实例 | 状态 | PID |
| --- | --- | --- | --- |
| 8001 | Dev ST | **未监听** | — |
| 8002 | Real ST | **未监听** | — |
| **8003** | **Dev Luker** | **已在监听** | `76784` |
| **8004** | **Real Luker** | **已在监听** | `29452` |
| 8899 | PT web | **未监听** | — |

两个进程的命令行均为 `node.exe server.js --browserLaunchEnabled=false`（**cwd 不可直读**）。
因此**端口归属靠探针决定性判定**，不靠猜（P-11：Dev/Real 版本号完全一致，版本无法区分）：

| 探针 | :8003 | :8004 | 结论 |
| --- | --- | --- | --- |
| `/scripts/extensions/third-party/st-authority-sdk/manifest.json`（**Dev 全局 third-party 独有**，Real 该目录为空） | **200** | **404** | 8003 = Dev Luker，8004 = Real Luker ✅ |

> 对照说明：`ST-BgLoader` / `st-chatu8` 在**两侧都返回 200**，因为它们同时存在于两侧的
> `data/default-user/extensions/`（用户私有目录优先于全局 third-party，见
> `docs/research/luker-extension-mechanics-and-git-prune.md` §2.2）——
> **所以这两个探针不能用于区分实例**，`st-authority-sdk` 才可以。

**其它读数**：`:8003` 上曾出现多条 `ESTABLISHED`，追查发起进程为 `bash.exe` 且命令行是本会话的
shell 快照 ⇒ **是本次取证自身的 `curl`**，**没有用户浏览器挂在实例上**。
⇒ 实例虽在运行，但**当前无人交互**，写入前无需额外协调。

## 7. 磁盘空间

| 盘 | 总 | 已用 | 可用 |
| --- | --- | --- | --- |
| C: | 954 G | 831 G (88%) | **124 G** |
| D: | 1.9 T | 1.6 T (87%) | **251 G** |

估算：原生备份 4 份（Real Luker 3.8 G + Dev Luker 1.3 G + ST 两份各 30 M）→ 压缩后落 C:；
同步载荷 1.3 G × 4 个可落盘目标 ≈ 5.2 G。**空间充足**。

## 8. 下载文件夹现状

`C:\Users\caocaobi\Downloads\` 内**没有**任何 `default-user-*.zip` 形式的历史数据包
（09-06 调研提过的 `default-user-2026-09-06-175123.zip` 已不在）。新建备份不与既有文件重名。

## 9. 本仓既有 Playwright 资产

- `.pw-profile` 与 `.pw-profile-dev` 两个持久化 profile 已存在（已被 `.gitignore` 的 `.pw-profile*/` 覆盖）。
- 上一轮（`09-25-all-instance-plugin-sync`）的验证是**一次性 `.cjs` 探针**
  （`pw-dom-write-audit.cjs` 等 6 个），躺在任务目录里**不入库**，不可跨机器复用。
- 本仓 `package.json` **无** playwright 依赖；`node_modules` 内亦无。
