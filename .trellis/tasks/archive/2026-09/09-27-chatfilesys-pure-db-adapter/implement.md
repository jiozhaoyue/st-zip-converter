# 实施计划 · 聊天记录纯库模式适配

> 复选框**随执行实时勾选**（L0-2）。每条含验证命令与判据。

## 0 前置

- [x] **0.1** 记录基线：`npm test` 项数（当前 522 passed / 2 skipped / 56 文件），写入 `research/`
- [x] **0.2** 现场核对并发会话占用：`e2e/run.cjs` 进程是否存在 ⇒ 存在则本轮**不碰** `e2e/specs/**`
- [x] **0.3** 建 `research/` 目录（本任务全部读数落此处，不入库）

## 1 供给侧契约（文档层，不落他仓源码）

- [x] **1.1** 契约正文落 `.trellis/spec/frontend/chat-store-seam.md`（**自包含**：内联 API 形状、
      硬约束、降级语义、`file:line` 证据）
- [x] **1.2** 登记 `frontend/index.md` 索引一行
- [x] **1.3** 在 `ST-chatfilesys-rebuild` 侧的开销登记：本机无该仓任务目录写入权（工作区脏）
      ⇒ 以「契约文件 + 待办条目」形式交付，**不静默跳过**

## 2 `src/core/pack-inject.js`（纯逻辑）

- [x] **2.1** `planInjection({ libraryChats, sourceChatPaths, selection, includeBackups })` →
      `{ inject: [{ hubPath, ref, reason }], skipped: { missingKey, hidden, backup, alreadyPresent, categoryOff } }`
- [x] **2.2** 过滤规则：`__cfsys__` 前缀（隐藏容器）· 备份特征（复用既有判据，**不得另写一份**）·
      已存在落盘名 · `selection.chats === false`
- [x] **2.3** hub 路径 = `chats/<fileName>`（沿用库返回的落盘名，**不得改名**）；
      群聊按 `isGroup` 落 `group chats/`（若库标注）
- [x] **2.4** 单测 `test/pack-inject.test.js`：AC-2 / AC-3 全矩阵 + 群聊分支 + 空库

## 3 `src/core/zip-augment.js`（纯 IO）

- [x] **3.1** `augmentZip(source, entries, { io, onProgress, signal })`：源条目**惰性直通**复制，
      注入条目用 `add`；顺序 = 源序在前、注入序在后
- [x] **3.2** `entries.length === 0` ⇒ **原样返回 `source`**（不做任何 IO）
- [x] **3.3** 背压：每 N 条 `await writer.waitForRoom()`（复用既有内存纪律）
- [x] **3.4** 单测 `test/zip-augment.test.js`：AC-4（原条目逐字保留 + 注入条目内容相等 + 顺序）；
      空列表零 IO；同名冲突时以源包为准
- [x] **3.5** 单测：`signal.aborted` ⇒ 抛 `AbortError` 且**不留半成品**

## 4 `src/ui/chat-store-bridge.js`（桥接层，唯一外部接触面）

- [x] **4.1** `probeChatStore()`：存在性 + `apiVersion <= 1` + 成员函数 + `capabilities` 归一；
      **任何异常收敛为不可用**（不抛）
- [x] **4.2** `withTimeout(promise, ms)`：有界等待；超时 ⇒ `{ ok:false, reason:'timeout' }`
- [x] **4.3** `listLibraryChats()` / `readLibraryChatAsJsonl(ref)` / `importChatsToLibrary(list, {onProgress, signal})`
      —— 每个都：能力位检查 → 超时 → try/catch → 归一返回（**永不抛到主路径**）
- [x] **4.4** 单测 `test/chat-store-bridge.test.js`：AC-1 四态矩阵 + AC-5（挂起 ⇒ 超时降级）+ 归一化
- [x] **4.5** 调试探针：`getChatStoreProbe()` 快照 + 挂进 `window.__stZipConverterDebug`；
      **自检不含 token/handle/路径**（快照只含 `{present, apiVersion, mode, canList, canExport, canImport, lastReason}`）

## 5 编排接线（`index.js`）

- [x] **5.1** 转换前：`probe → list → planInjection → read → augment`，只在计划非空时增强
- [x] **5.2** 增强只发生在**源 Blob 路径**；Node/路径源不增强（无 `globalThis` 宿主；记 debug 日志）
- [x] **5.3** 日志读数：探测结果 / 计划条数 / 注入成功失败 / 跳过原因
- [x] **5.4** 中止语义：`signal.aborted` 时抛 `AbortError`（既有 pause 语义不变）
- [x] **5.5** 还原后：`importChatsToLibrary` 逐条入库 + 读数；不可用 ⇒ 可操作提示
- [x] **5.6** 回归自检：**未改** `transform.js` / `worker-client.js` / `plan-preview.js`
      （`git diff --stat` 逐文件核对）

## 6 质量门

- [x] **6.1** `npm test` **零回退**：60 文件 / 573 passed / 2 skipped / 0 failed（基线 56/522/2）
      ⚠️ 默认并发下先出现 13 条 **5s 超时型**失败（机器 idle 仅 3.3%，另一会话 18 个 chrome 在跑）；
      逐条单跑即过 —— 属资源争抢，非回退。`--maxWorkers=2` 复跑全绿。
- [x] **6.2** 五条静态守卫 `exit=0`；`npm run build` 通过（由 `npm run e2e:web` 的构建段实测）
- [ ] **6.3** 【**阻塞：供给侧未实现**】真机（Dev 实例）：AC-7 打包含库中聊天 / AC-8 还原入库 / AC-9 删掉接缝 ⇒ 断言转红
      ⚠️ 需临时把 Dev Luker 切纯库；**切换前后记读数、结束复原**；避开并发 E2E 窗口
      —— **2026-09-29 复核：仍阻塞，如实保持未勾**。阻塞物在**供给侧仓**（`My-repo/ST-chatfilesys-rebuild`
      未实现 `ChatFilesysApi` 接缝），**不在本仓可控范围**；本仓消费侧已用**桩供给方**在真实浏览器
      验通全链路（§6.5：30 项全绿）并备有可照做的落地方案（`research/provider-side-patch-guide.md`）。
      判据未取得真机读数前**不勾**（`prd.md` 明文：「不得用『文件路径绿』冒充」）。
- [x] **6.4** 已**如实登记**（不得用文件路径绿冒充）：契约待办写进 `spec/frontend/chat-store-seam.md` §5
- [x] **6.6** 【新增方向：**从聊天库导出**】纯库模式下只有库、没有源包时的出口：
      `exportLibraryToPack()`（造最小 ST 摊平源包 → 走同一条转换管线）+ 动作行按钮
      （`computeActionAvailability` 统一求值，**只在检测到库时可见**）+ 守卫消费点登记；
      守护用例 `specs/library-export.e2e.cjs`（13 项，无库/有库两态对照，验到产物内容）
- [x] **6.5** 【替代验证·已完成】用**桩供给方**在真实浏览器里跑消费侧全链路
      —— `e2e/standalone/specs-src/chat-store-module.e2e.cjs`（17 项，源码树挂载直驱真实模块）
      与 `e2e/standalone/specs/library-export.e2e.cjs`（13 项，真按钮真点击）；
      且原句中的（`page.addInitScript` 注入
      「注入 `ChatFilesysApi` 桩 → 真实转换 → 解包核对『源包优先 + 补齐缺失』」已覆盖；
      **判别力证明**由两条独立对照承担：源码树 spec 的 M14/M15（不注入桩 ⇒ 补齐消失）与
      library-export 的 E3（无库 ⇒ 按钮不可见）

## 7 收口

- [x] **7.1** 规范落库（自包含，内联读数与 `file:line`）
- [x] **7.2** `git status --short` 复核：无计划外文件（每次提交前都用 `git diff --staged --name-only` 对过集合）
- [x] **7.3** 提交（**显式 pathspec**）并 `git push origin` —— 本任务共 6 个提交：
      `2b9f04b`（消费侧适配）· `83b7e03`（自查三修）· `c16e65a`（导出补单测）·
      `43a3bd2`（从聊天库导出）· `1e26191`（file:// 提示 + 续传缺陷取证）· `c652d8d`（任务收口文档）
- [x] **7.4** 残留登记：供给侧实现待办、真机验证缺口、`group chats/` 分支未取证项
      —— *已逐条落 `prd.md` 的「残留」节（5 条）：① 供给侧未实现（阻塞 AC-7/8/9，附
      `research/provider-side-patch-guide.md` 可照做文档）；② 宿主拉取注入接线**已验通**
      （`e2e/specs/library-inject.e2e.cjs` dev-luker 两档各 21 项全绿）；③ `group chats/` 落点未取证
      （本机无群聊样本）；④ `*.bak.jsonl` 形态不在既有备份判据内（未擅自扩展）；⑤ 实例侧环境阻塞已解除
      （Dev 插件更新到 `61ce2f5`，dev-st 冒烟 36/36 全绿）*

## 回滚点

- 回滚 = 删 `pack-inject.js` / `zip-augment.js` / `chat-store-bridge.js` + 还原 `index.js` 接线。

## 收口记录（2026-09-29，Session 36 补）

- **AC 对照**（`prd.md` AC 表）：**AC-1 ~ AC-6 ✓**（单测与消费侧回归，总读数 573 passed / 0 failed）；
  **AC-7 / AC-8 / AC-9 未达成 —— 阻塞于供给侧仓未实现接缝**，按 prd 明文「如实登记为阻塞，
  不得用文件路径绿冒充」处理，**保持不勾**。消费侧已用**桩供给方**在真实浏览器验通全链路（§6.5，30 项全绿）。
- **收口复验**（2026-09-29 现场重跑）：`npx vitest run --maxWorkers=2` ⇒
  **64 文件 / 610 passed / 2 skipped / 0 failed，exit 0**（本任务收口时 573 项，其后由
  `09-28-convert-true-incremental-resume` 净增 37 项守护；**零回退**）。
- **解除阻塞的前置**：供给侧仓 `ST-chatfilesys-rebuild` 实现 `ChatFilesysApi` v1 接缝
  （落地方案见 `research/provider-side-patch-guide.md`），届时本任务可开**后续任务**补 AC-7/8/9。
- **本任务为独立任务，无父任务**；归档即为交付。
