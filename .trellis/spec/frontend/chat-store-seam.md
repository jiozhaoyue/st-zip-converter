# 聊天存储接缝（纯库模式适配）

> **适用范围**：任何「把聊天收进数据库、磁盘上不再有 jsonl」的宿主环境，
> 以及任何需要在这种环境里**搬运聊天记录**的功能（打包、还原、备份、迁移）。
> 当前已知供给方实现：`My-repo/ST-chatfilesys-rebuild`（ChatFilesys，纯数据库模式）。
> 本条为**跨仓契约**：本仓是**消费侧**，接缝由聊天库插件**供给侧**实现。

---

## 1 为什么需要这条接缝（不是「想做个新功能」）

纯数据库模式下，**磁盘上的聊天文件不存在**：

- 存量聊天入库时源文件被移进回收站后删除（`ST-chatfilesys-rebuild/docs/guide/import.md`：
  「读源 → 算指纹 → LCP 合并 → 分块写入 → **快照进回收站 → 删源**」）；
- 磁盘 jsonl 只在导出时生成（`docs/guide/export.md`）；
- 读路径走 fetch 接缝从**库**拼装（`docs/dev/seam.md`：拦截 `/api/chats/*` 九条路由）。

而任何「按文件搬运」的工具（本仓的转换器就是）都只看得到磁盘：
`src/core/inspect.js:58-62` 把 `chats/**` 判为聊天类目，`src/ui/host-bridge.js:747` 拉的是
`/api/users/backup` 整包。⇒ 在纯库实例上打包，**产物里一条聊天都没有，且不报错**。
反方向同样断：还原只写磁盘文件，而纯库**读库不读盘**，用户一条都看不到，读数却是绿的。

**结论**：要把聊天搬出/搬进这种环境，必须能问到「库」——故需要一条显式接缝。

---

## 2 供给侧契约 `ChatFilesysApi` v1

挂在 **`globalThis`** 上的**冻结**对象（与宿主既有 `STAuthority.AuthoritySDK` 同形态；
同步可探测、零竞态，不像事件总线那样要求双方同时在场）。

```js
globalThis.ChatFilesysApi = Object.freeze({
  apiVersion: 1,
  capabilities: Object.freeze({ list: true, export: true, import: true }), // 能力自述
  mode(),                                                    // 'off' | 'pure' | 'mirror'（同步、零副作用）
  listChats(),                                               // → [{ fileName, chatName?, avatarUrl?, isGroup? }]
  exportChat({ avatarUrl, fileName }),                       // → 标准 jsonl 文本
  importChat({ avatarUrl, fileName, jsonl, sourceLabel }),   // → { ok, reason?, branchId? }
});
```

### 硬约束（供给侧，违反即为契约缺陷）

| 编号 | 约束 | 为什么 |
| --- | --- | --- |
| **S-1** | `importChat` **只做合并**（内容指纹去重 + LCP 分叉），**绝不删除任何源** | 插件自己的「导入旅程」会删源（移回收站后删）。外部接入若复用该语义，会在用户没要求时**删掉磁盘文件** —— 不可接受 |
| **S-2** | `importChat` **幂等**：同一份 jsonl 重复导入不产生重复楼层 | 搬运工具可能重试；不幂等就等于每次重试都污染库 |
| **S-3** | `capabilities` / `mode()` 为**同步零副作用**读取 | 消费侧要在「什么都不做」的默认路径上先探测，不能为此触发 IO |
| **S-4** | 失败必须**可判**：返回 `{ok:false, reason}` 或 reject | 「静默失败」在搬运场景里等于数据丢失 |
| **S-5** | **不向外部暴露任何删除/覆盖能力** | 最小攻击面；外部工具没有理由删库 |
| **S-6** | `listChats()` **不含正文**；`fileName` 必须是**宿主落盘名** | GB 级库必须能只取索引；落盘名是家族主键绑定所在，改名会让宿主/插件对不上号 |

> `apiVersion` 更高 ⇒ 消费侧**整体不接**（形状未知，宁可不接也不猜）。
> 版本号管「契约形状」，能力位管「这台机器这个模式下能不能做」——**两者都要看**。

---

## 3 消费侧纪律（本仓）

实现落点：`src/ui/chat-store-bridge.js`（唯一接触面，`L0-9`）+
`src/ui/chat-store-inject.js`（编排）+ `src/core/pack-inject.js`（纯决策）+ `src/core/zip-augment.js`（纯 IO）。

### 3.1 降级阶梯（`L0-11` / `L1-MR-1`）

| 档 | 条件 | 行为 |
| --- | --- | --- |
| 0 | 未检测到 `ChatFilesysApi` | **一个字节不动、一行日志不打**（默认路径零变化） |
| 1 | 有 API 但缺 `list` / `export` | 记一条 info 说明原因，透传 |
| 2 | 计划为空（源包已齐 / `selection.chats === false`） | 记一条 info，透传 |
| 3 | 逐条取正文**全失败** | 记一条 warn，透传（不产出「只多了一堆空条目」的包） |
| 4 | 有可补条目 | 产出增强包 |

### 3.2 绑定判据（易错点，都是实测踩过的）

1. **只看落盘名（basename）** 比对两侧，且做 **小写 + NFC** 归一
   （Windows 文件系统大小写不敏感；macOS 的 NFD 会让同一名字产生不同码点）。
   ⚠️ **绝不可**拿「库里的聊天条数」去对「源包 chats 目录的条目数」——前者按聊天计、
   后者按文件计，且目录里混着 `.luker-state.chat_sync.json` 这类**伴生文件**。
2. **隐藏容器**（`__cfsys__`）必须过滤，且要**逐段查路径**而不是只查 basename：
   实测形态是目录与文件名**两处都带前缀**
   （`chats/__cfsys__/__cfsys__f___cb_e2e_-_2026-….jsonl`）。
3. **源包优先**：同名的库条目一律不注入。转换的语义是搬运既有数据，
   任何情况下都不该被一个副作用式的补丁**改写**。
   ⚠️ 实现时最容易写成反的（「源条目命中注入名就跳过源条目」）——那会让原聊天被顶替。
4. **备份特征文件**（`isBackupChatOrSnapshot`，含 `backups/**`）不参与「已有」判定：
   拿历史快照当「这个聊天已经在包里了」，会让**当前版本**被跳过。

### 3.3 有界等待与资源纪律（`L1-MR-7`）

- 外部插件的实现质量不可控，**任何一次调用都可能永不 settle**；
  每个调用都要有超时（默认 list 8s / export 20s / import 30s），超时 ⇒ 记 warn + 归一为失败。
- 逐条取正文（**一条一条来**），不得把整个库一次读进内存。
- 中止检查放在每条 seam 调用之间；`AbortError` 按既有语义静默上抛。

### 3.4 增强包为什么在**源包**这一层做（而不是在 `convert()` 里加选项）

注入条目一旦进入源包，下游**既有代码零改动**即可正确处理：
布局识别（`detectFromReader`）、类目判定（`routeSource`）、目标落位（`targetEntryPath`：
L 的 `data/...`、PT/TT 的 `data/extensions/...`）、`selection` 过滤、分卷（`splitter`）。
若在 `convert()` 里新增「注入条目」选项，则要同时改主循环、分卷器、报告计数与
Worker 消息协议四处（且 seam 在**主线程**上，Worker 拿不到）——回归面大得多。

增强的落点**恒为内存 Blob**，不用 OPFS：`needsTransform=false` 时增强包会**原样进待导出区**
成为用户手上的产物，而 OPFS 临时包要在「消费完毕」后清理，那个时点在两条分支里不一致——
漏清泄漏磁盘、早清毁掉产物。代价（峰值多一份包体积）已登记为残留。

---

## 4 与既有代码的接口

| 位置 | 角色 |
| --- | --- |
| `src/core/pack-inject.js` | 纯决策：`planInjection()` / `collectSourceChatFileNames()` / `normalizeChatFileName()` |
| `src/core/zip-augment.js` | 纯 IO：`augmentZip()`，**空注入列表 ⇒ 原样返回 source 引用**（零 IO） |
| `src/ui/chat-store-bridge.js` | 唯一外部接触面：`probeChatStore()` / `listLibraryChats()` / `readLibraryChatAsJsonl()` / `importChatsToLibrary()` / `getChatStoreProbe()` |
| `src/ui/chat-store-inject.js` | 编排：`injectLibraryChatsIntoSource()`（打包前）/ `importRestoredChatsIntoLibrary()`（还原后） |
| `index.js` | 接线：宿主拉取在**文件树扫描之前**注入；还原在**成功分支之后**入库 |

**注入必须在文件树扫描之前**：否则用户在树上勾选时根本看不到这些聊天，
而它们又会被打进包里——「我确认的东西」与「我拿到的东西」不一致。

`window.__stZipConverterDebug.getChatStoreProbe()` 暴露**只读**探针快照
（能力位 + 计数 + 原因文案；**不含** token / handle / 文件路径），形态沿用 R-19。

---

## 5 未做到 / 待办（**不要当成已实现**）

1. **供给侧尚未实现本契约**（截至 2026-09-27，`ST-chatfilesys-rebuild` 全仓检索
   `globalThis.` 只有 `STAuthority` 与 `fetch`，无任何跨插件出口）。
   本仓的消费侧因此只能靠单测（假供给方）覆盖；**真机（Dev 实例）验证未做**。
2. **群聊分支未取证**：`isGroup` 的判定依据取自库索引，本机没有群聊样本验证落点是否
   应为 `group chats/`。落错了宿主会读不到，属**未验证**项。
3. **增强包内存峰值**：纯库且库很大时，峰值多一份包体积（见 §3.4 的取舍）。
   可选优化：OPFS 落点 + 引用计数清理。
4. **`*.bak.jsonl` 形态未被既有备份判据覆盖**：`isBackupChatOrSnapshot`
   只认 `*.bak`（以 .bak 结尾）与含 `backup` 词的形态，
   `A.bak.jsonl` 这种「保留 .jsonl 后缀的 .bak 命名」不在其列。
   本任务**未擅自扩展**该判据（它同时服务既有备份过滤，扩面会改变既有行为），仅登记。
