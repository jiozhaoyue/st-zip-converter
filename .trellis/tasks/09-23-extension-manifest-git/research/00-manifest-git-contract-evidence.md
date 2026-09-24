# 扩展清单与 Git 语义 — 证据与检索记录

> 采集时间：2026-09-24。所有结论均附仓库锚点（文件:行），不臆断。

## 1. 检索先行（L0-3 双通道）

| 通道 | 查询 | 结果 |
| --- | --- | --- |
| GitHub API | `search/repositories?q=sillytavern+extension+installer` | 命中 8 项，均为个人小仓（最高 11 star），无「扩展清单 + 在线安装引导」的通用库。`LenAnderson/SillyTavern-Everything`、`thexyzzyone/STFastUserSwitching` 与本任务无关。 |
| GitHub API | `search/repositories?q=extensions-index.json` | 命中项全部是 Tachiyomi / Komik 的扩展索引，与酒馆生态无关。 |

**结论**：不存在可复用的现成方案。`extensions-index.json` 的格式契约需以 **SillyTavern 官方 Content Downloader 规范**为准（本仓已实现的兼容格式即事实标准），无第三方库可引入。→ **不引入新依赖**，在仓内收敛为纯逻辑模块。

## 2. 现状证据（生成端）

| 事实 | 锚点 |
| --- | --- |
| `EXTENSION_MODES = { MANIFEST, FULL }`，默认 `FULL` | `src/core/transform.js:27`（`extensionMode = EXTENSION_MODES.FULL` 参数默认值于 `:203`） |
| MANIFEST 模式下扩展实体条目被丢弃（含 `.git`） | `src/core/transform.js:465/486/506/525`（`extensionMode !== EXTENSION_MODES.MANIFEST` 守卫）+ `:536` |
| 清单产出条件：**仅 ST / L 目标** 且 `extensionMode === MANIFEST` | `src/core/transform.js:775-777`（`shouldEmitManifest`） |
| 产出两份产物：包根 `extensions-index.json`（官方格式）+ `_convert/extensions-manifest.json`（转换器私有） | `src/core/transform.js:779-803` |
| 条目现有字段 | `src/core/transform.js:756-771`：`id / name / displayName / description / url / branch / commit / version / type / manifest` |
| `url` 取值链 | `src/core/transform.js:756`：`gitMeta.remoteUrl \|\| srcRecord.remote_url \|\| manifest.homePage`（**可能为空串**） |
| 私有清单顶层字段 | `src/core/transform.js:794-801`：`converter / generatedAt / mode / total / extensions` |

**缺口**：FULL 模式**完全不产出任何清单**（`shouldEmitManifest` 短路），因此 FULL 包恢复后无任何扩展安装/更新引导元数据。条目亦无「可否在线安装」的状态字段——空 `url` 与有效 `url` 在数据结构上不可区分。

## 3. 现状证据（消费端 / 恢复链路）

| 事实 | 锚点 |
| --- | --- |
| 恢复成功后**无条件自动**扫描包内清单并弹安装器 | `src/ui/host-bridge.js:488-505`（`restoreToHost` 尾部） |
| 读取方式：整条 `entry.read()` + `TextDecoder` + `JSON.parse`（主线程同步） | `src/ui/host-bridge.js:493-495` |
| 安装器已区分「本地已安装 / 待安装」两个状态 | `src/ui/host-bridge.js`（`installedNames.has(folder)` → 徽标文案） |
| 已安装项默认**不勾选**（`chk.checked = !isInstalled`） | 同上 |
| URL 渲染期校验：非 http(s) 显示「无远程 URL」 | `host-bridge.js` + `src/ui/escape.js` 的 `isSafeHttpUrl` |
| 安装主体：逐条 `await installExtensionViaHost({url, branch, replace})`，宿主端点自带 `depth: 1` 浅克隆 | `host-bridge.js:527`（`/api/extensions/install`） |
| 无 URL 项在点击安装时才抛错 | `host-bridge.js`：`if (!ext.url \|\| !/^https?:\/\//i.test(ext.url)) throw new Error('缺少有效的 Git HTTP(S) URL')` |
| 清单字段全部走 `createElement + textContent`（XSS 已止血） | `host-bridge.js` 注释块 + `src/ui/escape.js` 头部说明 |

**缺口**：
1. 三类状态（包内已有实体 / 仅清单可在线安装 / 无 URL 不可安装）在数据与 UI 上**只区分了两类**，「包内已有实体」这一状态**完全不存在**（因 FULL 不产清单）。
2. 无 URL 的项在列表里看不出不可安装，要点击后才失败。
3. 「已安装」判断只比对宿主 `discoverHostExtensions()`，未表达「本包已内嵌实体」。
4. 文案未说明在线安装需要网络 + 宿主安装端点权限 + 仓库可访问。

## 4. 双入口副本约束（L1-MR-10）

`extension-mode` 选择器在**两份副本**中各存一份，结构改动必须同源同改：

- `index.html:277-296`（独立态）
- `src/ui/workbench-template.js:193-210`（插件态）

> 另注：两副本**整体结构已经分歧**（`index.html` 缺 `#stash-list` / `.wb-block` 等两块式节点，`src/ui/workbench-template.js:31/46/56` 有）。该分歧属 `09-24-dual-entry-sync-standalone` 的任务范围，**本任务不修**，但改动选择器区域时须避免依赖不存在的节点。

## 5. 与 `09-22-extension-git-slim` 的关系（去重结论）

| 维度 | `09-22-extension-git-slim`（`gitMode`） | 本任务（清单契约） |
| --- | --- | --- |
| 解决的问题 | FULL 包内 `.git` packfile 体积过大 | 清单元数据完整性 + 恢复引导语义 |
| 新选项 | `gitMode ∈ {keep, strip, minimal}` | 无新转换选项；清单字段强化 |
| 交集点 | `MANIFEST` 模式下 `.git` 整体不打包 → 其 PRD 已声明对 `gitMode` 「不产生额外作用」需 UI 联动禁用/说明 | 本任务**只在文案层**声明该语义，**不实现** `gitMode` 选择器与联动 |
| 依赖 | 其 OQ-1（`minimal` 可行性 Dev 实测）未闭环 → 本任务**不引用其未定结论** | 本任务不阻塞、不重复实现 |

**结论**：两任务互补不重叠。本任务不得触碰 `gitMode` 相关代码路径（该标识当前在源码中根本不存在，`grep` 已确认）。

## 6. 决策记录（2026-09-24，用户交互问答 + 主代理范围裁定）

| 编号 | 决策 | 来源 |
| --- | --- | --- |
| D-1 | **FULL 模式也生成清单**，条目标 `availability = embedded` | 用户选项 A |
| D-2 | **新增「仅导出扩展清单」只读选项**（不触发安装） | 用户选项 A |
| D-3 | **无 URL → 显式 `availability = unavailable`**，不伪造 URL（不引入 `.git/config` 回退提取） | 用户选项 A |
| D-4 | **恢复后保持自动弹出**，但只列「可安装项」；已内嵌实体默认不勾选并折叠 | 用户选项 A |
| D-5 | **MVP 边界**（用户授权主代理裁定，选 A 档）：清单契约强化 + 恢复引导闭环 + README 文案；**不含** `gitMode` 的 UI 联动实现 | 主代理裁定 |
| D-6 | FULL 模式**不生成**官方 `extensions-index.json`（该索引语义为「按 URL 在线下载」，与包内已有实体冲突，避免宿主 Content Downloader 重复安装） | 主代理裁定（设计取舍，理由见 `design.md` §3） |
| D-7 | 新增纯逻辑模块 `src/core/extension-manifest.js` 承载 schema 与状态判定，`transform.js` 只调用 | 主代理裁定（`transform.js` 已 911 行，避免继续膨胀） |
