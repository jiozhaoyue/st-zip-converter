# 8004 Real Luker 实机诊断报告

> 任务：`09-25-live-perf-diagnosis`（父任务 `09-25-workbench-native-onesop`）
> 日期：2026-09-25 · 实例：`https://127.0.0.1:8004`（Luker 2.7.0 / release / `239b329ea`）
> 插件版本：`355fdc1`（Git 安装于 `data/default-user/extensions/st-zip-converter`）
> 方法：全局 Playwright 1.62.1（免安装）+ CDP `Performance.getMetrics` / `Profiler` + 页面内 `PerformanceObserver`

## 0. 方法学与只读约束

**只读硬约束**（用户授权 8004 的唯一条件「不要把数据搞坏」）：

- 仅 GET 与具只读语义的查询；**全程未调用** `POST /api/users/restore`、`extensions/{install,delete}`；
- 未点击任何执行类按钮（转换 / 拉取 / 恢复 / 导出 / 删除）；
- 未向 `Instance/**` 写入任何文件；
- 唯一 DOM 交互是**展开插件自己的设置面板**与**在插件 UI 内部滚动/勾选类目复选框/切换下拉**（纯前端状态）；
- 唯一 DOM 副作用是自建的无害探针节点（`<span style="display:none">`，插入后 20ms 移除）。

> ⚠ 现场事实：**8004 无登录门槛**——匿名 `GET /api/users/me` 直接返回 `default-user`（`admin: true`），`GET /csrf-token` 可取。
> 这意味着该实例上任何写端点调用都会**直接作用在真实数据上**。本报告的所有脚本因此都显式回避写路径。

**采样设计要点**：v1 采样器曾把「页面聊天加载期」当成空闲基线（DOM 15k→93k，出现 8142ms 长任务），两窗口不可比；
v2 起改为**先等页面真正静止**（连续 3s 无 longtask 且 DOM 规模不变）再开窗，并用「人为制造 body DOM 变动」作为可重复刺激源。

**脚本清单**（均在 `research/`）：

| 脚本 | 用途 |
| --- | --- |
| `pw-a1-survey.cjs` | 页面盘点（DOM/CSS/动画/注入面/扩展清单） |
| `pw-bc-live.cjs` | v1 对照采样（**已废弃**，用于说明方法学修正） |
| `pw-bc2-live.cjs` | v2 严谨对照（静止后关闭态 vs 展开态 + 自愈成本对照实验） |
| `pw-d1-profile.cjs` | CPU Profile 归因（刺激窗口 vs 静默窗口） |
| `pw-e1-ui-open.cjs` | 插件 UI 可见态 + 交互态 Profile |
| `pw-f1-startup.cjs` | 启动期全程 Profile + 面板打开成本 |

---

## 1. 核心结论（先讲结果）

### 1.1 插件在三条路径上的主线程开销均 ≤ 0.06% —— 性能上不是卡顿源

| 场景 | 采样总量 | 插件耗用 | 占比 |
| --- | --- | --- | --- |
| **启动期** 36.1s（导航→静止） | 16866.5 ms | **8 ms** | **0.05%** |
| **宿主 DOM 变动刺激** 10s（41 次 body 变动） | 1829.2 ms | **0 ms** | **0%** |
| **插件 UI 交互** 12s（滚动/勾选/切下拉/details 开合） | 566.78 ms | **0.32 ms** | **0.06%** |
| **插件面板可见**（静态） | — | 未采到有效指标（CDP metrics 返回空） | — |

插件初始化全链路函数级明细（启动期，每个都是亚毫秒）：

```
1.0ms  (anonymous)      src/vendor/zip.js:0        ← 模块加载
1.0ms  mount            src/ui/host-bridge.js:975  ← 抽屉注入
0.5ms  main             index.js:70                ← 入口
0.5ms  applyPluginUi    index.js:484
0.5ms  verifyHostPlatform  src/ui/host-bridge.js:83
0.5ms  applyHostBadge   index.js:467
0.5ms  renderUsageDashboard  src/ui/usage-dashboard.js:44  ← 配额条（含 Luker 原生配额查询）
0.5ms  renderStashList  src/ui/stash-list.js:71
0.5ms  updateWorkspaceUI  index.js:399
0.5ms  flushPendingEntries  src/ui/log-console.js:249
0.5ms  resolveFilename  src/core/filename-template.js:51
0.5ms  info            src/core/logger.js:75
```

UI 交互态唯一被采到的插件函数：

```
0.13ms  updateFilenamePreview  index.js:92
0.13ms  resolveFilename        src/core/filename-template.js:51
0.03ms  formatDate             src/core/filename-template.js:30
```

> 这三条来自**自定义包名的实时预览**——即「切换下拉/勾选类目」时刷新包名预览的固有成本，合计 0.29ms。

### 1.2 真正的开销源（点名到函数与行）

**启动期 36.1s 内 16866.5ms 的主线程占用，分布如下：**

| 排名 | 函数 | 来源 | 启动期耗用 |
| --- | --- | --- | --- |
| 1 | `oe` / `p` / `ie` / `u` / `V`（同一库） | **`https://esm.sh/@chenglou/pretext@0.0.9`**（第三方扩展从 **外部 CDN** 拉的库） | **≈3700 ms**（2048.5+601.5+501+389+157.5） |
| 2 | `serializeFrontendLogValue` | 宿主 `/scripts/frontend-log-manager.js:25` | **1438.5 ms** |
| 3 | `cloneJsonValue` | 宿主 `/script.js:11727` | 287 ms |
| 4 | `Be` | 宿主 `/lib/jquery-3.5.1.min.js` | 177.5 ms |
| 5 | `settingsGetRequestInterceptor` | 宿主 `/script.js:15160` | 143.5 ms |
| 6 | `(garbage collector)` | native | 219 ms |

**宿主 DOM 变动刺激期（10s，41 次变动）的开销源：**

| 函数 | 来源 | 耗用 |
| --- | --- | --- |
| `runRegexScript` | **宿主正则引擎** `/scripts/extensions/regex/engine.js:901` | 102.7 ms |
| `serializeFrontendLogValue` | 宿主 `frontend-log-manager.js:25` | 43.7 ms |
| `cloneJsonValue` ×2 | 宿主 `script.js:11727` | 37.4 ms |
| `getMeasurableMes` | **扩展 `st-acu-visualizer`** `index.js:3566` | 30.7 ms |
| `updateIconDisplay` | **扩展 `QR`** `settings.js:57` | 19.7 ms |
| 插件相关 | — | **0 ms** |

### 1.3 为什么插件的自愈观察器不是问题（机理澄清）

`host-bridge.js:1223` 的共享 `MutationObserver` 监听 `document.body` 的 `childList+subtree`，每次变动去抖 200ms 后调用 `runInjectionWatchers()` 跑全部 4 个注入回调。
单看机制很可疑——实测也确实高频：**关闭态 12s 内宿主 DOM 变动 4520 次 / 80 批**，即约每 150ms 就有一批变动（远密于 200ms 去抖窗口）。

但四个回调的实际成本结构决定了它不成问题：

| 注入回调 | 每次调用做的事 |
| --- | --- |
| `mountSettingsDrawer` → `mount` | `getElementById('st-zip-converter-settings-panel')` → 命中即 return |
| `registerMenuButton` → `addBtn` | `getElementById('st-zip-converter-menu-item')` → 命中即 return |
| `mountLukerBackupManagerButton` → `addBtn` | `getElementById('st-zip-converter-luker-manager-btn')` → 命中即 return |
| `mountNativeBackupButton` → `addBtn` | **`querySelectorAll('.userBackupButton')`（全文档查询）** |

即：**3 次 O(1) 命中 + 1 次全文档 querySelectorAll**。在 21886 节点的文档上，41 次触发在 100µs 采样粒度下**一次都没被采到**——量级在亚毫秒。

> 早期一次「对照实验」曾算出 7.86ms/次，但那次的对照组设计有缺陷（`detached` 组不触发**任何** observer，而 `body` 组触发的是**整条 observer 链**）。函数级 Profile 纠正了该误判：那 7.86ms 属于宿主正则引擎/日志管理器/其他扩展。

---

## 2. 旧结论逐条复核

| 旧结论（`09-07`） | 本轮判定 | 依据 |
| --- | --- | --- |
| 「拉取时整页卡**是插件责任且已修**」（longtask 14→2，rAF 合帧） | **未复测**（本轮不做传输，避免 GB 级下载与 IndexedDB 写入） | 归入 T4；`view.js:56`/`export-queue.js:401`/`log-console.js:298` 的 rAF 合帧实现仍在 |
| 「打开抽屉持续卡**与插件无关**」（当时归因 43 个第三方扩展 CSS 动画） | **本轮强化为函数级证据**：插件在启动期 0.05%、刺激期 0%、交互期 0.06% | 见 §1.1 |
| 「43 个持续 CSS 动画来自其他第三方扩展」 | **本轮未复现**：静止页面 `document.getAnimations()` 返回 **0** | 可能因当时页面处于特定 UI 状态；不影响主结论 |
| 「徽标重复」「配额条重定义」等 UI 修复 | 已生效 | 实测 `#env-badge` ×1、`#usage-dashboard` ×1（无重复） |

---

## 3. 那么「UI 导致的 Luker 整体卡顿」是什么？

实测否定了性能层面的归因，但**用户的体感是真实的，只是成因不在主线程耗时**。本轮找到三条可解释路径：

### 3.1 感知层面的「沉重」：插件 UI 规模（有硬数据）

| 指标 | 实测值 |
| --- | --- |
| 插件工作台 DOM 节点 | **276** |
| 面板渲染高度 | **1237 px**（宽 474px 侧栏内 → 约 1.7 屏连续滚动） |
| 按钮总数 / 可见数 | **36 / 13** |
| 输入控件总数 | **19**（8 复选框 + 4 单选 + 7 下拉/文本） |
| `<details>` / `<label>` | 3 / 12 |

**13 个可见按钮的全部文案**（这是「按钮冗余」的直接证据）：

```
+ {part}  + {user}  + {date}  + {category}  + {mode}  + {target}
分卷标准   核心备份   全量备份
开始转换   从宿主拉取   恢复到当前用户
展开日志 ▲
```

- **6 个占位符插入 chip**（`+ {part}` 等）是模板作者的语法糖，普通用户不需要；
- **3 个包名预设**（分卷标准/核心备份/全量备份）与上方的包名输入框、下方 6 个 chip 三重表达同一件事；
- **3 个平铺动作按钮**（开始转换 / 从宿主拉取 / 恢复到当前用户）语义相邻但流程不同，平铺会让人不知道点哪个；
- 另有 **7 个 `<select>`/文本输入 + 8 个复选框**在同一列里平铺：目标平台、压缩率、智能分包、包名模板、扩展模式（2 卡单选）、保留构建配置、备份/缓存/私有/增量合并/差量补丁/剔除原生资产。

一个用户打开侧栏看到 1237px 的连续表单——这会被读作「卡/重」，即便它一毫秒都不耗。

### 3.2 界外发现（不属插件，但影响该实例体感，建议转达）

- **`esm.sh` 外部 CDN 依赖**：启动期约 **3700ms** 主线程耗在 `esm.sh/@chenglou/pretext@0.0.9`。这是**其他扩展**的 CDN 依赖，且违反本仓群的「零外部 CDN」偏好（`fe-offline-design` nocdn）。建议定位是哪个扩展并反馈。
- **宿主自身的 `serializeFrontendLogValue` 在启动期吃掉 1438.5ms**，每次 DOM 变动还会再吃 43.7ms/10s。
- **`st-acu-visualizer`（`getMeasurableMes`）与 `QR`（`updateIconDisplay`）** 在 body 变动时持续消耗。

### 3.3 插件 CSS 的规模（中性观察，非卡顿源）

插件注入 **365 条**带双前缀的规则（`style.css` 307 条 + 宿主 `#dynamic-styles` 自动生成的 58 条焦点态变体），占页面 **10760 条**总规则的 3.4%。
另：`#dynamic-styles` 里那 58 条**不是插件写的**——`focus-visible` 在本插件 `style.css` 中出现 **0 次**，且代码中无 `insertRule` / `createElement('style')` / `dynamic-styles` 任何操作，是**宿主对注入 UI 的自动无障碍增强**。

---

## 4. 止血建议清单（阶段 E1 · 待用户逐项裁决）

> 本任务原则上不改 `src/**`。以下每条给出：问题锚点 / 改动面 / 预期收益 / 风险 / 降级方式。
> **未获批项不进入实施。**

### G-01 结论修正：不在「性能」上做插件侧返工（建议：不做改动）

- **依据**：启动期 0.05% / 刺激期 0% / 交互期 0.06%。
- **建议**：性能项**不做插件侧改动**；把力气转到 UI 规模治理（T2）与传输期复测（T4）。
- **风险**：若不做，用户「卡」的体感可能仍在——但那属于感知问题，见 G-02。
- **替代**：若用户希望进一步压榨，唯一有实测依据的微优化是 `mountNativeBackupButton` 的全文档 `querySelectorAll('.userBackupButton')` 提前短路（例如先判 `.userBackupButton` 是否曾出现过），**预期收益亚毫秒级，性价比极低**。

### G-02 把「卡顿」的治理目标改为 UI 规模（建议：纳入 T2 主目标）

- **依据**：§3.1 的硬数据（1237px / 36 按钮 / 19 控件）。
- **改动面**：`src/ui/workbench-template.js` + `index.html`（同源同改，L1-MR-10）+ `style.css`。
- **预期收益**：感知层面直接改善；同时减少一屏内需要认知的决策数。
- **风险**：结构改动面大，需 `npm test` 全绿 + 两条守卫通过。
- **降级方式**：保留现有 id，只做「下沉/折叠」而非删除，必要时可快速回退。

### G-03 建议采集「传输期」数据后再对性能下最终结论（建议：纳入 T4）

- **依据**：本轮**未复测**拉取/转换期（避免 GB 下载与 IndexedDB 写入）。
- **建议**：T4 内做一次受控的传输期采样（或明确决定不复测，接受 09-07 的旧数据）。
- **风险**：若只静态度量就宣布「性能无问题」，可能漏掉传输期的真实卡顿。

### G-04 界外问题转达（建议：仅记录，不改本仓）

- 定位使用 `esm.sh/@chenglou/pretext` 的那个扩展（启动期 ~3.7s，且违反 nocdn 偏好）；
- 宿主 `frontend-log-manager` 的 `serializeFrontendLogValue`（启动期 1438.5ms）建议向 Luker 上游反馈；
- `st-acu-visualizer` / `QR` 在 DOM 变动时的持续消耗。

### G-05 方法学沉淀（建议：写入 spec）

- **教训**：对照实验的对照组必须**只差一个变量**。`detached` 组不触发任何 observer，`body` 组触发整条 observer 链 → 差值不能归因给某一个观察者。
- **正确做法**：先跑函数级 CPU Profile 点名，再设计对照。
- **建议落点**：`.trellis/spec/frontend/quality-guidelines.md`（性能取证的取证口径）。

---

## 4.5 传输期实测（用户明确要求补测）

**方法**：两轮受控实测（`pw-h1-transfer.cjs` / `pw-h2-transfer-timeline.cjs`）。点「从宿主拉取」→ 采样 45–90s → 主动中止。
**未含 `backups/`**（2.3GB，那部分测的是 Luker 服务端 archiver 打包耗时，非插件责任）。

### H1/H2 观测

| 项 | 观测值 |
| --- | --- |
| 传输量 | H1：采样 90s 收到 **1221.8 MB**；H2：45s 收到 **621.2 MB**（约 14–17 MB/s） |
| 进度百分比 | **全程恒定 18%**（H1 与 H2 一致） |
| longtask | H1：98 个 / 共 20054 ms / **最长 5536 ms**；H2：47 个 / 12243 ms / **最长 5177 ms** |
| 插件 JS 占比 | H1 **0.59%**（343ms/57827ms）；H2 各段 **2.4–3.2%** |
| 插件明细 | `fetchHostBackup`(host-bridge.js:253) 75–98ms/5s 段、`applyProgress`(view.js:35) 2–6ms/段、`onCheckpoint`(task-manager.js:99) 2ms/段 |

### H2 时间轴归因（每 5s 一段）

传输稳态期（10–45s）各段构成高度一致：

```
[10–15s] 采样 3261ms | 插件 2.79%
  native  (program)  2707ms   ← 占该段采样 83%
  plugin  fetchHostBackup (host-bridge.js:253)  83ms
  host    cloneJsonValue (script.js:11727)      67ms
  native  querySelectorAll                      126ms
```

- **`native (program)` 稳定占 76–87%**——V8 引擎自身执行（GB 级流数据的 native 拷贝/Blob/OPFS 写路径），**不计入任何 JS 函数**。插件的 JS 层始终只占 2.4–3.2%。
- `querySelectorAll`（native）持续 100–130ms/5s 段（3–4%），非插件调用（插件明细中无对应函数）。
- **5.2s / 5.1s 巨大长任务**落在传输过程中，其所在段落的构成就是上述 native 主导，`attribution` 仅 `containerType: window`（同源不可细分）。

### 传输期三条真实结论

1. **插件 JS 不是传输期开销主体**（2.4–3.2%）。主体是浏览器处理 GB 级流的 native 成本——这是**任何**大包下载的固有代价，不是本插件引入的。

2. **🔴 进度条恒定 18% —— 这是「卡顿感」的直接来源，且是确凿缺陷。**
   Luker `/api/users/backup` 不返回 `Content-Length`，而 `index.js:829` 在该分支**硬编码百分比**：
   ```js
   // index.js:829（无 Content-Length 分支）
   view.setProgress(18, `[2/3 传输中] 正在接收宿主打包的 ZIP 流 (无 Content-Length) · ${receivedText}${speedText}`);
   ```
   对照有 `Content-Length` 的分支（`pct = 15 + Math.round((received / total) * 20)`）。
   后果：用户拉 1.2GB 的**全程进度条一动不动停在 18%**，只有文字在变。**「它卡死了」的体感主要来自这里**，属反馈缺失而非性能问题，修复成本极低（可用已接收字节 + 已知总量估算，或改为不确定态进度动画）。

3. **界外发现（不在本仓，仅记录）**：
   - H2 `[5–10s]` 段出现 **770ms** 的正则开销：`RegExp: (<disclaimer>...</disclaimer>) (<guifan>...</guifan>)` —— 第三方扩展的正则脚本；另有 `RegExp: ([\s\S]*?)(<progress>...</progress>)` 148ms。这些是宿主正则引擎在处理内容时的真实开销。
   - 出现**外部域名脚本** `https://jnai2d9kgnbs6xzx5c.com/regex_bind/inject.js`（每段 5–8ms，持续参与）。来源未知的第三方域，建议用户核查其来源扩展。

---

## 4.6 配额显示缺陷（用户指出「从后端来讲完全错」· 已实锤）

三方对照（`pw-g1-quota.cjs`）：

| 项 | 插件 UI 显示 | 后端真值 | 判定 |
| --- | --- | --- | --- |
| 用户配额 | `3.6 GB / 无限制` | `usedBytes: 3862526856`；`quotaBytes: **null**` | 数值对，**语义错** |
| 浏览器配额 | `1.4 GB / 11.4 GB (12.2%)` | `estimate()` usage `1.394GB` / quota `11.394GB` | 数值对，**语义全错** |

**错因（后端视角）**：

1. **「用户配额」不是配额**。`quotaBytes: null` 意为管理员**未设配额**，`usedBytes` 是**用户目录总占用**。
   后端分项可与磁盘逐字节对齐（`du` 实测 `data/default-user` **3.7G**）：

   | 后端分项 | 字节 | 占比 |
   | --- | --- | --- |
   | **backups** | 2 438 015 867（**2.27 GB**） | **63%** |
   | chats | 699 780 005 | 18% |
   | extensions | 355 123 394 | 9% |
   | images | 171 067 610 | 4.4% |
   | characters | 113 148 452 | 2.9% |
   | presets | 61 609 983 | 1.6% |
   | worlds | 21 865 758 | 0.6% |
   | attachments / other / vectors | 1 915 787 | 0.05% |
   | **合计** | **3 862 526 856** | 100%（与 API `usedBytes` **完全一致**） |

   → 把「含 63% 历史备份快照的目录占用」展示为「用户配额」，用户会误读为自己的聊天数据体量。

2. **「浏览器配额」根本不是配额**。`estimate()` 返回的是**整个 origin**（`https://127.0.0.1:8004`）的存储用量，分项 `{fileSystem: 1484045587, indexedDB: 12757297}`：
   - **99.1% 是 `fileSystem`（OPFS）**，属宿主/其他扩展；
   - 本插件自己的 IndexedDB 仅 **12.76 MB**，占该行显示值的 **0.9%**。
   把 origin 总量摆在插件面板上，用户会以为插件吃了 1.4GB。

**顺带（关键正面发现）**：Luker 的存储能力远比插件当前用到的深，且**前端已提供可直接复用的原生 UI 模块**：

| 层 | 事实 | 出处（只读核对） |
| --- | --- | --- |
| 数据 | `POST /api/users/storage/inspect` 是**完整存储浏览器 API**：`path` 递归下钻、`breadcrumbs`、每项 `sizeBytes`/`childCount`/`canDrill`/`kind`/`note` | 实测响应；`src/endpoints/users-private.js:1664` |
| 配额 | 用户级字段 `storageQuotaBytes`，有效值由 `getEffectiveUserQuotaBytes(profile, settings)` 解析 | `src/users.js:1160`、`public/scripts/user.js:475` |
| 配额强制 | **超配额直接拒绝写入**：HTTP **413** `Storage quota exceeded. Used X of Y.` | `src/users.js:1176-1178` |
| 聚合视角 | `POST /api/users/storage/inspect-any`（管理员全平台/任意用户），该视角下 `quotaBytes` 恒为 `null` | `src/endpoints/users-admin.js:1325`、`src/storage/inspector.js:1291` |
| **原生前端模块** | `public/scripts/storage-inspector.js` **导出** `RestProvider` / `ThrowingMutator` / `openStorageInspector(dataSource)` / `mountStorageInspector(dataSource, container)` / `createStorageInspector(opts)` | 文件导出声明 |
| 原生前端模块 | `public/scripts/browser-storage-inspector.js` **导出** `BrowserProvider` / `openBrowserStorageInspector()` | 文件导出声明 |
| 宿主内用法 | `openStorageInspector({kind:'self'})`、`openBrowserStorageInspector()`、`mountStorageInspector({kind:'any',target}, container)` | `public/scripts/user.js:2361`、`:2362`、`:3108` |

**结论**：插件当前的「浏览器配额 + 用户配额」双行自绘条是**重复造轮子且口径错误**——宿主既有正确的数据语义（`quotaBytes` 可为 null = Unlimited、超限 413 强制），又有现成的原生 UI（含配额、堆叠条、下钻、图例）。插件自绘版本反而把「origin 总量」与「目录占用」误标为「配额」。

**对接形态（三选一，待用户裁决）**：

- **A** 面板内一枚入口按钮 → `openStorageInspector({kind:'self'})`（原生弹窗，零自绘、零说明文字）
- **B** `mountStorageInspector({kind:'self'}, container)` 把原生检查器**内嵌**进插件面板
- **C** 直接移除插件配额条（宿主 UI 已有该入口），仅保留错误反馈路径

**已知风险（须显式记录）**：A/B 依赖**动态 `import()` 宿主内部模块路径**（`/scripts/storage-inspector.js`）。该路径非文档化公开契约，宿主升级可能变更 → 必须按 L0-11 走「特性检测 + 静默降级」：`import()` 失败或导出缺失时，该入口整块隐藏，主路径不受影响。此处与 L1-MR-5「不翻源码找 API」存在张力，但**是用户明确指定的对接需求**，以特性检测兜底。

---

## 5. 未做/受限项（诚实声明）

| 项 | 原因 |
| --- | --- |
| 传输期**完整落盘**观测 | 两轮均在 45–90s 主动中止（受控，避免 GB 级不可控下载）；未见转换/导出阶段的完整数据 |
| H1 中「1221.8MB 后停滞 70s」 | H2 复测未见同样停滞（45s 时仍在增长），**不足以判定为缺陷**；疑似 Luker 服务端打包剩余部分时的无数据间隙，需更长时间窗复测才能定性 |
| 「插件禁用 vs 启用」对照 | 禁用扩展需修改宿主配置（写操作），违反只读约束 |
| 面板打开的一次性 layout 成本（F2） | CDP `Performance.getMetrics` 在该窗口返回空对象，未取到有效数据 |
| 独立态（`index.html`）实测 | 本轮只测插件态；独立态已知存在结构分歧（见 `09-24-dual-entry-sync-standalone`） |
| 其他宿主的对照 | 8001/8002/8003 均无响应，现场只有 8004 可用 |
