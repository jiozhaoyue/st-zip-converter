# 聊天记录纯库模式适配（ChatFilesys 联动）

> 跨仓任务：本仓（ST-zip-converter）为**消费侧**，`My-repo/ST-chatfilesys-rebuild` 为**供给侧**。
> 本文件是**工作副本**；契约条文最终落 `.trellis/spec/`。

## Goal

**让「聊天记录被收进数据库」的宿主环境里，数据包互转不再静默丢聊天。**

现状（本仓 `4b5511f`）：

- 转换器的聊天记录来源**只有一条**：源 zip 里的 `chats/**`、`group chats/**` 条目
  （`src/core/inspect.js:58-62`、`src/core/report.js:42`；宿主拉取走 `/api/users/backup`
  的整包，见 `src/ui/host-bridge.js:747`）。
- 一旦宿主处于**纯数据库模式**（`ChatFilesys` 的「纯数据库」：`docs/guide/modes.md` 载明
  「磁盘上的 jsonl 只在导出时生成」，存量聊天入库后**源文件被移回收站并删除**），
  备份包里 `chats/` 就是空的 ⇒ **打包产物里一条聊天都没有，且没有任何报错**。
- 反方向同样断：把含 `chats/**` 的包还原到纯库实例，文件落在磁盘上，而纯库模式**读库不读盘**
  ⇒ 用户看不到这些聊天，而「已还原」的读数还是绿的。

⇒ 这是一条**双向静默数据损失**路径，且用户在看到产物之前无法察觉。

## 非目标（本任务明确不做）

- **不**把转换器改成聊天数据库；**不**读写 ChatFilesys 的私有存储格式（SQL / 分片 / IndexedDB）。
- **不**触碰宿主的聊天读写路径（不装第二层 fetch 接缝）。
- **不**在没有 ChatFilesys 的环境里改变任何既有行为（默认纯文件路径零变化）。
- **不**要求用户做任何额外操作来完成一次转换（可用则自动增强）。

## Requirements

### R1 供给侧契约（`ChatFilesysApi` v1）· MUST

ChatFilesys 在 `globalThis` 上暴露一个**冻结的、带版本号的**只读/追加 API：

```js
globalThis.ChatFilesysApi = Object.freeze({
  apiVersion: 1,
  capabilities: Object.freeze({ list, export, import }),   // 三个布尔，能力自述
  mode(),                                                   // 'off' | 'pure' | 'mirror'
  listChats(),                                              // 轻量索引，不含正文
  exportChat({ avatarUrl, fileName }),                      // → 标准 jsonl 文本
  importChat({ avatarUrl, fileName, jsonl, sourceLabel }),  // → { ok, reason?, branchId? }
});
```

硬约束（**写入契约条文**）：

- **只读 + 追加**：`exportChat` 不得改动库；`importChat` **只做合并（指纹去重 + LCP 分叉）**，
  **绝不删除任何源**（导入旅程里「移回收站 → 删源」只属于它自己的 UI 路径，外部接入不得触发）。
- **幂等**：同一份 `jsonl` 重复 `importChat` 不产生重复楼层（内容指纹去重语义）。
- **失败必须可判**：返回 `{ ok:false, reason }` 或 reject，**不得**静默吞掉。
- **零副作用探测**：`mode()` / `capabilities` 为同步读取，不得触发网络或存储写。
- **没有删除/覆盖能力**暴露给外部调用方。

### R2 消费侧探测与降级 · MUST

- `probeChatStore()`：特性检测 `globalThis.ChatFilesysApi`（存在 + `apiVersion <= 1` +
  被调成员存在 + `capabilities.*`），**任何异常都收敛为「不可用」**，绝不抛出（L0-11 / L1-MR-1）。
- 无该 API ⇒ 全部走既有文件路径，**行为逐字节不变**（含日志：不产生噪音）。
- 有 API 但某能力缺失 ⇒ 该能力单独降级，其余照常。

### R3 导出侧：以库为准补齐 `chats/**` · MUST

- 打包前，若库可用且 `capabilities.list && capabilities.export`：
  1. `listChats()` 取库索引；
  2. 与源包已有的 `chats/**` 条目**按落盘名比对**，只取**缺失项**（已有项一律以源包为准，不覆盖）；
  3. 逐条 `exportChat()`，注入为 `chats/<fileName>` 条目，走**既有的类目/选择语义**
     （`selection.chats === false` ⇒ 一条都不注入；备份特征文件（`_backup` 等）不得注入；
     插件自己的隐藏容器 `__cfsys__` 前缀**必须过滤**）。
- **注入必须在源包层面完成**（生成「增强源包」），使后续转换的类目判定、目标路径映射、
  平台差异（`chats/` vs `data/...`）**全部复用既有代码**——不改 `transform.js` 主循环。
- 注入条数、跳过条数、失败条数**必须进入报告与日志**（用户可见，不得静默）。

### R4 导入侧：还原后录入库 · MUST

- 还原成功后，若 `capabilities.import`：把本次还原包里的 `chats/**`（不含备份特征文件）
  逐条 `importChat()`。
- 单条失败**不阻断**其余条目（沿用导入旅程的失败安全语义），最终给出「成功 N / 失败 M（原因）」读数。
- 无 API 或能力缺失 ⇒ **不报错**，给一条**可操作提示**：
  「检测到聊天库插件处于纯库模式但未提供接入 API ⇒ 聊天文件已落到磁盘，请在插件弹窗用『转库』录入」。

### R5 有界等待与资源纪律 · MUST

- 每个接缝调用**必须有超时兜底**（L1-MR-7：任何 `await` 都必须能 settle）。
- 序列化：库条目**逐条**取（不得一次性把整个库读进内存）；注入条目按需流式写入增强源包。
- 转换过程可被 `signal` 中止：seam 调用之间检查 `signal.aborted`。

### R6 质量门 · MUST

- `npm test` 全绿零回退；新增单测覆盖：契约探测矩阵（缺 API / 版本不符 / 能力缺失 / 抛异常）、
  注入选择逻辑（类目关闭 / 隐藏容器 / 备份特征 / 已存在项）、增强源包往返（zip 内容与顺序）。
- 五条静态守卫 `exit=0`。

## Acceptance Criteria

| 编号 | 判据（可执行） |
| --- | --- |
| **AC-1** | 单测：`probeChatStore()` 在「无 API / `apiVersion=2` / 缺成员 / 成员抛异常」四种输入下**均返回不可用且不抛出** |
| **AC-2** | 单测：`selection.chats === false` ⇒ 注入 0 条；`__cfsys__` 前缀与备份特征文件**不得出现**在注入集合里 |
| **AC-3** | 单测：源包已有 `chats/A.jsonl`、库中也有 A ⇒ **不重复注入**（以源包为准）；库中另有 B ⇒ 只注入 B |
| **AC-4** | 单测：增强源包往返 —— 原条目**逐字保留**（名/内容/顺序），注入条目出现在 `chats/` 下且内容等于 seam 返回值 |
| **AC-5** | 单测：seam 调用挂起 ⇒ 在超时后**降级继续**（不挂死），且日志含原因 |
| **AC-6** | 单测：无 API 时，转换路径的**行为与日志与改动前逐字节一致**（既有 522 项全绿即是回归门） |
| **AC-7** | 真机（Dev 实例，非 Real）：纯库模式下打包，产物里含库中聊天；`unzip -l` 计数与库索引一致 |
| **AC-8** | 真机：把含 `chats/**` 的包还原到纯库实例 ⇒ 库中出现这些聊天（`listChats()` 可见），且**磁盘源文件不因此被删** |
| **AC-9** | 契约作废判据：把 `globalThis.ChatFilesysApi` 删掉重跑 ⇒ AC-7 的断言**转红**（证明断言真的依赖接缝） |

> AC-7 / AC-8 / AC-9 需要**供给侧已实现**；未实现时**如实登记为阻塞**，不得用「文件路径绿」冒充。

## 约束与既定事实

- 实例端口 / 守卫：E2E 只许连 Dev（`e2e/lib/guard.cjs`；`P-11`）。
- **不得改宿主源码**；实例的 `data/**` 属运行时可写（`L0-1` v1.5.0 三类边界）。
- 供给侧仓（`ST-chatfilesys-rebuild`）当前工作区**脏**（有并发写者）⇒ 本轮**不落它的源码**，
  只落**契约**与**消费侧**；供给侧实现另行登记。
- 纯库模式下 `chats/` 的落盘名即宿主的 `fileName`（family 主键绑定所在），
  注入时**必须沿用库返回的 `fileName`**，不得自行改名（否则宿主/插件对不上号）。


---

## 交付读数（2026-09-28 收口时实测）

| 项 | 读数 |
| --- | --- |
| 单测 | `npm test` = **60 文件 / 573 passed / 2 skipped / 0 failed**（基线 56/522/2） |
| 静态守卫 | 五条 `exit=0` |
| 消费侧**真浏览器**验证 | `e2e/standalone/specs-src/chat-store-module.e2e.cjs`（17 项，源码树挂载直驱真实模块 + 桩供给方）+ `specs/library-export.e2e.cjs`（13 项，真按钮真点击）—— 合计 30 项，全绿 |
| 独立形态总读数 | `npm run e2e:web` = **183 断言 / 183 通过 / 0 失败** |
| 判别力对照 | 不注入桩 ⇒ 补齐消失（M14/M15）；无库 ⇒ 按钮不可见（E3） |

## 残留（如实登记，勿当成已做）

1. **供给侧未实现**（阻塞 AC-7/8/9）：`ST-chatfilesys-rebuild` 本轮**正被另一会话通宵开发**
   （近 1 小时内仍在改 `index.js` / `core/errors.js` / `e2e/`），故**完全不碰**。
   落地方案与验收清单已写成可照做的文档：`research/provider-side-patch-guide.md`。
2. ~~宿主拉取路径的注入接线未在真机验~~ **已验通**（2026-09-28 04:3x）：
   `e2e/specs/library-inject.e2e.cjs` 在 **dev-luker** 上两档都全绿（各 21 项）——
   - **快档**（只勾 `characters`，chats 未勾）：路径被走到（探针 `lastListCount=3` + 桩 `listChats` 被调）、
     **正确地不注入**（尊重用户选择）、日志说明原因（`类目关断 3`）；
   - **重档**（`SZC_HEAVY_HOSTPULL=1`，勾上 chats ⇒ 真注入）：
     日志「**已把 2 条库中聊天补入源包**」、探针 `lastExportOk=2 / lastExportFailed=0`、
     导出的正是那两条桩聊天（隐藏容器条目被过滤）。
   ⇒ 「按钮 → 拉取 → 注入 → 补进包」这条链路在**真实宿主**上成立。
   仍未做：接真供给方（ChatFilesys）的端到端 —— 依赖供给侧实现（见残留 1）。
3. **群聊落点未取证**：`isGroup` 依据库索引，本机没有群聊样本验证 `group chats/` 落位。
4. **`*.bak.jsonl` 形态不在既有备份判据内**（`isBackupChatOrSnapshot` 只认 `*.bak`），
   本任务**未擅自扩展**（它同时服务既有备份过滤），仅登记。
5. ~~实例侧环境阻塞~~ **已解除**（2026-09-28 03:1x 复核）：此前读数不可解释的成因是实例页面
   一度停在 `Initializing…`（并发会话的挂死进程 + 高负载）。现在：
   - 两个 Dev 实例的插件从 `d15737a` 更新到 **`61ce2f5`**（`git pull --ff-only`，**只更新 Dev**，
     Real 未动；这正是父任务 R-20 的既定纪律）；
   - **dev-st 冒烟 36/36 全绿**（注入点 panel/drawer/menu 全在、零本插件报错/失败请求）
     ⇒ 顺带证明**本轮新增的代码没有破坏宿主侧注入**；
   - 新增实例侧用例 `e2e/specs/library-inject.e2e.cjs`：驱动此前**从未被任何 E2E 驱动过**的
     `#btn-host-fetch → injectLibraryChatsIntoSource()` 接线（用 dev-luker 的 selection 收窄拉取量，
     只勾 `characters`，避开 Luker 的 `settings` ⇒ `backups/` 巨量隐含打包）。

### 追加：实例侧接线验证（`e2e/specs/library-inject.e2e.cjs`）

`#btn-host-fetch → injectLibraryChatsIntoSource()` 这条接线此前**没有任何自动化覆盖**
（矩阵 spec 不驱动宿主拉取）。该用例把它补上，并做了成本取舍：

- **快档（默认）**：只勾 `characters`（≈40 MB，且是布局判据之一）⇒ 拉取快；
  此时 `chats` 未勾选 ⇒ 插件**正确地不注入**（尊重用户选择）。断言的是
  「路径确实被走到」（探针 `lastListCount > 0` + 桩的 `listChats` 被调过）与
  「**为什么**没注入可观测」（日志含「类目关断 3」）—— 后者顺带促成一处产品改进：
  `describePlan()` 原来不在摘要里报 `categoryOff`，用户/排障者看不出"是自己关了聊天"。
- **重档（`SZC_HEAVY_HOSTPULL=1`）**：把 `chats` 也勾上 ⇒ 真注入（dev-luker 的 chats ≈ 670 MB，
  全量拉取要几分钟）。**默认不跑**，以免这条用例拖慢他人每次的 E2E。

首轮假红三处，全部记在用例注释里：① 没等插件初始化（宿主 DOM 就绪 ≠ 插件已注入）；
② 只强制显示了插件抽屉内容、**没开宿主的扩展抽屉**（祖先隐藏 ⇒ Playwright 一律判不可见）；
③ 判「收窄生效」只断言"点了全不选"、没**回读** ⇒ 实际拉了全量，几分钟也没到注入点。

## 顺带发现（不在本任务范围，已另行登记）

- 🔴 **暂停 → 续传后产物缺条目**（静默数据损失）：由本任务新增的 `pause-resume.e2e.cjs` 取证，
  机理与两种修法见 `guides/standalone-web-and-cloud-e2e.md` §4.6。
  既有两层测试分别锁住了「机理」与「日志出现跳过 N 项」，**没有一条问过产物是否完整**。
