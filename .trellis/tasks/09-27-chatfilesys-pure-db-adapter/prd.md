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
