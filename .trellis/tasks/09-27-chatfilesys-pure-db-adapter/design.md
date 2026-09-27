# 设计 · 聊天记录纯库模式适配

## D0 事实基础（现场取证，非推断）

| 事实 | 证据 |
| --- | --- |
| 转换器聊天记录**只从源 zip 的条目**来 | `src/core/inspect.js:58-62`、`src/core/report.js:42`、`src/core/splitter.js:61-65` |
| 宿主拉取 = `/api/users/backup` 整包（含 selection） | `src/ui/host-bridge.js:747` |
| 转换入口 = `runConversionTask({ source, target, options })`，`source` 是 Blob 或路径 | `src/core/worker-client.js:92` |
| 纯库模式：存量入库后**源文件被移回收站并删除**，磁盘 jsonl 只在导出时生成 | `ST-chatfilesys-rebuild/README.md`、`docs/guide/import.md`、`docs/guide/modes.md` |
| 纯库模式**读库不读盘**（fetch 接缝只拦 `/api/chats/*` 9 条路由） | `ST-chatfilesys-rebuild/docs/dev/seam.md` |
| ChatFilesys 当前**未暴露任何跨插件 API** | 全仓检索 `globalThis.` / `window.`：仅 `STAuthority` 与 `fetch`（2026-09-27 实测） |
| 本机 Dev Luker 装了 chatfilesys，但 `storage_mode: "off"`（非纯库） | `Instance/Dev/Luker/data/default-user/settings.json` |
| 本机**没有任何纯库模式实例** | Dev/Real 四个实例均为默认模式（实测） |

⇒ 两条推论：
1. **必须新增供给侧契约**才能拿到库索引（纯库下磁盘无文件，无从枚举）；
2. **本机无现成纯库实例** ⇒ AC-7/AC-8 的真机验证需要**临时把 Dev Luker 切到纯库**
   （属 `L0-1` 的「运行时数据可写」；切换前后必须记读数、结束复原，且**避开并发 E2E 窗口**）。

## D1 分层与落点

```
index.js（编排）
  └─ src/ui/chat-store-bridge.js   ← 唯一与外部聊天库打交道的地方（宿主差异/特性检测的落点，L0-9）
        ├─ probeChatStore()        特性检测 + 能力自述 + 超时
        ├─ listLibraryChats()
        ├─ readLibraryChatAsJsonl()
        └─ importChatsToLibrary()
  └─ src/core/pack-inject.js       ← 纯逻辑：决定「注入哪些」与「落到哪个 hub 路径」（零 DOM，可单测）
  └─ src/core/zip-augment.js       ← 纯 IO：把源包 + 注入条目重写为一个新包（复用 zipIo）
```

理由：`core/` 禁 DOM 但可用 `fetch`/`globalThis` 之外的纯逻辑；**特性检测与外部调用放 `ui/`**
（与 `host-bridge.js` 同层，符合 `L0-9` 宿主适配只许进桥接层）。决策逻辑（哪些条目要注入）
放 `core/` ⇒ 可 100% 单测，不依赖浏览器。

## D2 供给侧契约 `ChatFilesysApi` v1（本任务**只落契约文本**）

```js
globalThis.ChatFilesysApi = Object.freeze({
  apiVersion: 1,
  capabilities: Object.freeze({ list: true, export: true, import: false }),
  mode: () => 'pure' | 'mirror' | 'off',
  listChats: async () => [{ avatarUrl, fileName, chatName, floorCount, isGroup }],
  exportChat: async ({ avatarUrl, fileName }) => '<标准 jsonl 文本>',
  importChat: async ({ avatarUrl, fileName, jsonl, sourceLabel }) => ({ ok, reason?, branchId? }),
});
```

设计取舍：

| 取舍 | 选择 | 理由 |
| --- | --- | --- |
| 挂 `globalThis.ChatFilesysApi` vs 事件总线 | **globalThis，冻结对象** | 与宿主现有的 `STAuthority.AuthoritySDK` 同一形态；同步可探测、零竞态；事件总线需要双方同时在场，跨插件加载顺序不可控 |
| 能力自述（`capabilities`） vs 版本号推断 | **两者都要** | 版本号管「契约形状」，能力位管「这台机器这个模式下能不能做」（纯库下 `import` 可用，`off` 模式下三者都无意义） |
| 索引里是否带正文 | **不带** | GB 级库必须能只取索引；正文逐条按需取（内存纪律） |
| 导入语义 | **只合并、不删源** | 插件自己的「导入旅程」会删源（移回收站后删）。外部接入若复用该语义，会在用户没要求时**删掉磁盘文件**——不可接受 |
| 是否暴露删除能力 | **不暴露** | 最小攻击面；外部插件没有理由删库 |

## D3 数据流

### 导出侧（打包）

```
源（宿主拉取 Blob / 用户上传 zip）
      │
      ├─ probeChatStore()  ──不可用──► 原样透传（零改动、零日志噪音）
      │
      ▼ 可用
   listLibraryChats() ──► 库索引
      │
      ▼
   pack-inject.planInjection({ libraryChats, sourceChatPaths, selection })
      │   · selection.chats === false ⇒ 空计划
      │   · 过滤 __cfsys__ 前缀与备份特征文件（复用 inspect.isBackupChat）
      │   · 源包已有的落盘名一律跳过（以源包为准，不覆盖）
      ▼
   [{ hubPath, ref }]  ──逐条──► readLibraryChatAsJsonl(ref)
      │
      ▼
   zip-augment.augmentZip(source, entries)  ──► 增强源包
      │   · 仅在计划非空时执行；否则**返回原 source 引用**（零成本）
      ▼
   runConversionTask({ source: augmented })  ← 转换核心**一行未改**
```

**为什么在源包层面注入**（D3 的关键取舍）：注入条目一旦进入源包，`detectFromReader`（布局识别）、
`routeSource`（类目判定）、`targetEntryPath`（目标落位：L 的 `data/...`、PT/TT 的 `data/extensions/...`）、
`selection` 过滤、`splitter` 分卷——**全部既有代码零改动即可正确处理注入条目**。
若改为在 `convert()` 内部新增 `injectedEntries` 选项，则要同时改：主循环、分卷器、
报告计数、Worker 消息协议（structured clone 大字符串）四处，回归面大得多。

代价：多一次整包读写。**用条件化消掉**——计划为空（常态）时不做增强，直接透传原 source。

### 导入侧（还原）

```
还原包 ──► restoreToHost(host-bridge, 既有路径) ──► 宿主写盘（既有行为不变）
                │
                ▼ 成功之后
        probeChatStore() 可用且 capabilities.import
                │
                ▼
        逐条 importChatsToLibrary({ avatarUrl, fileName, jsonl })
                │   · 失败单条不阻断（沿用导入旅程的失败安全）
                ▼
        日志：成功 N / 失败 M（附原因）
   不可用 ⇒ 一条可操作提示（纯库模式下文件写盘但库不可见 ⇒ 引导用户用「转库」）
```

## D4 内存与有界等待（L1-MR-7 / 既有内存事故教训）

| 风险 | 处置 |
| --- | --- |
| 增强包把 GB 级包再缓冲一份 | ① 计划为空不增强；② 有 OPFS 时写 OPFS 临时文件（`src/ui/opfs-*.js` 既有 helper），无 OPFS 才回落 `BlobWriter`；③ 增强后**立即**释放中间引用 |
| 投递过快 ⇒ 内存峰值 | 复用 vendor 的 `waitForRoom()` 背压（`zip-io.js` 有实测教训：916 条在飞 ⇒ 6.2 GB） |
| seam 调用挂起 | 每个 `ChatFilesysApi` 调用包 `withTimeout(ms)`；超时 ⇒ 记 warn + 视为失败（**绝不挂死主路径**） |
| 用户中止转换 | seam 调用之间检查 `signal.aborted`；`AbortError` 按既有语义静默上抛 |

## D5 可观测性

- 日志（`logger`）：探测结果（含模式与能力位）、计划条数、注入成功/失败、跳过原因计数。
- 报告：注入条目进 `report` 的 chats 计数（复用既有类目统计，不新增字段 → 不破坏既有断言）。
- 调试出口：`window.__stZipConverterDebug.getChatStoreProbe()`（只读快照，`Object.freeze`），
  沿用 R-19 已确立的形态；**不得**含文件路径外的任何凭据（无 token / 无 handle）。

## D6 与并发会话的边界（本机实测约束）

- 本仓 `e2e/specs/**` 与 `.trellis/tasks/09-27-plugin-defect-fixes/**` 正被**另一个会话**使用
  （实测 `node e2e/run.cjs --only matrix` 在跑）⇒ 本任务**不写这些路径**。
- 供给侧仓 `ST-chatfilesys-rebuild` 工作区脏（`M style.css`、`M ui/popup.js`、未跟踪 `ui/graph/`）
  ⇒ 本轮**不落它的源码**，只落契约。
- 实例插件目录（`Instance/Dev/*/.../st-zip-converter`）**不碰** —— 改了会让并发 E2E 的读数不可解释。

## 回滚

全部新增为**新文件 + 一处编排接线**；回滚 = 删新文件 + 还原 `index.js` 那一段。
无数据迁移、无持久化格式变更 ⇒ 回滚后旧包读写行为逐字节不变。
