# 功能矩阵（M-1…M-9）实现记录与发现

> 第五轮（2026-09-26）。交付物：`e2e/specs/matrix.e2e.cjs`（+ `e2e/lib/harness.cjs` 一处扩展）。
> 读数：**122 项断言 / 通过 122 / 失败 0**，**连续两轮全绿**（可重跑性坐实）。
> 全文所有 `file:line` 均相对本仓根。

---

## 1. 矩阵覆盖与判定面

| # | 路径 | 判定面（全部来自插件渲染出来的 DOM / IndexedDB，不臆造内部符号） |
| --- | --- | --- |
| M-1 | 宿主检测 | `#env-badge` 文本（脱离模板初始值「检测中...」）+ `#target-select` 含 `native` 选项 |
| M-2 | 工作台注入 | 走**真实用户路径**打开工作台，并断言控件**真实可见**（见 §3） |
| M-3 | 计划预览 | `#plan-summary-bar` / `#output-estimate-text` / `#action-stats-badges` / `#category-checkboxes` |
| M-4 | 转换（四目标） | 待导出区 `.eq-name` 条目增量；四目标产物名互不相同 |
| M-5 | 导出队列 | `page.on('download')` 计数为 0；`.eq-title` 计数、`.eq-stored`/`.eq-ephemeral` |
| M-6 | 落库 | IndexedDB `st_zip_converter_db` / `files` store 的 `origin` 字段**增量** |
| M-7 | 断点续传 | `#task-controls.hidden` 状态机 + 转换路径的可达性登记（见 §5） |
| M-8 | 批量恢复 | `#btn-restore-luker` 可见性契约的双向互证（有产物 vs 分卷后置空） |
| M-9 | 分割 | 6 MB 放大包按 1 MB 阈值 → **8 个分卷**（`part1`…`part8` 连续） |

---

## 2. 六条「**我的断言写错**，不是插件缺陷」

> 本仓纪律「先证明判定能抓到违规，再相信它报 0」的另一面：**判错方向的红灯一样要查实**。
> 本轮 6 次红灯，回源码/实地取证后**全部**确认是断言侧问题。逐条留档，供后人少走一遍。

### 2.1 「徽标必含宿主版本号」—— 臆造契约

- **症状**：Dev ST 上 `#env-badge` = `SillyTavern 插件`，无 `· vX.Y`，断言红。
- **实情**：版本号是**按宿主可得性**渲染的 —— `applyHostBadge(host.platform)`（`index.js:703`）
  只传了 platform，第二参 `version` 缺省即不拼版本段。实测 Luker 上是 `Luker 插件 · v2.7.0`、
  ST 上是 `SillyTavern 插件`（两者**形态本就不同**）。
- **改法**：断言改为「已脱离模板初始值 `检测中...`」（= 检测真的跑完了），版本号只作**读数打印**。

### 2.2 `#count-chars` 恒为 0 —— 断言选错元素

- **症状**：计划摘要条读数完全正确，但 `#count-chars` / `#count-chats` 恒为 0。
- **实情**：那几个 `count-*` 属于 `#module-grid`（**宿主拉取**路径的模块计数），
  而外部包的计划渲染走 `renderCategoryStats`（`src/ui/category-filter.js:113`），
  更新的元素是 `#plan-summary-bar` / `#action-stats-badges` / `#output-estimate-text` / `#category-checkboxes`。
- **改法**：换断言面。

### 2.3 TT / PT 目标报「路由」而非「直通」—— 把语义差异当成 bug

- **症状**：`target=tt/pt` 时摘要条是「**路由** 7」，我按「直通 7」断言 ⇒ 红。
- **实情**（正确行为）：ST 与 Luker 的目录形态相同 ⇒ 类目条目**原样直通**；
  TT 的树根要套 `data/default-user/` 前缀、扩展另有 `data/extensions/third-party/` 落点
  ⇒ 条目必须**路由**到新路径。
- **改法**：tt/pt 断言改为「按路由计 7」+「摘要条不再报直通」。

### 2.4 「`.drawer-open` 选择器」—— **截断的输出制造了假事实**

- **症状**：宿主扩展抽屉打不开，两实例全红，诊断显示 `.drawer-open` 匹配到 **0** 个元素。
- **根因**：先前一次探针 dump class 时用了 `slice(0, 40)`，把
  `menu_button menu_button_icon drawer-opener …` **恰好截成** `menu_button menu_button_icon drawer-open`
  —— 我照着这个**被截断的字符串**写了选择器。真实 class 是 **`drawer-opener`**。
- **改法**：选择器改 `.drawer-opener`。
- **通用教训**：**dump 必须打印完整 class / 明确标注截断长度**；
  拿截断值当契约，得到的是「看起来合理、实际永不匹配」的判定。

### 2.5 「`offsetParent !== null` 判可见」—— 对 `position:fixed` 恒假

- **症状**：Luker 上确定可见的宿主菜单按钮被判为不可见（候选数 `0`）。
- **根因**：宿主菜单是 `position:fixed`，而 **fixed 元素的 `offsetParent` 恒为 `null`**。
- **改法**：改用 `getBoundingClientRect()` 的宽高判定。

### 2.6 「恢复入口仅 Luker 显示」—— 照**过时注释**写断言

- **症状**：按「ST 上不该出现恢复入口」断言 ⇒ Dev ST 红。
- **实情**：`computeActionAvailability`（`index.js:140`）的契约是
  **`restore.visible = isHost && hasArtifact`**（`hasArtifact = !!lastConvertedBlob`）——
  **与平台无关**，有产物就可见。
  我据 `index.js:712` 的一句注释「*原实现*：… btn-restore-luker 仅 luker 显示」推断，
  而那句描述的是**已被替换掉的旧实现**。
- **改法**：改为断言「有产物 ⇒ 可见、且未探测前不禁用」，
  并利用**分卷路径会把 `lastConvertedBlob` 置 null** 这一点做**双向互证**
  （分卷接管后入口重新隐藏）—— 把「碰巧一直可见」排除掉。
- **通用教训**：**注释里的历史陈述不是契约**；断言必须以**当前代码路径**为准。

---

## 3. 打开工作台：必须走真实用户路径，且「控件真实可见」要单独断言

冒烟 spec 只用 `querySelector` 查**存在性**，因此一路绿灯；矩阵要**真实点击**，立刻暴露两层问题：

1. **宿主扩展抽屉是关着的**。插件设置面板整体挂在
   `#rm_extensions_block.drawer-content.closedDrawer`（`display:none`）之下 ⇒
   即使展开插件自己的 `#st_zip_converter_settings`，抽屉内控件
   `getBoundingClientRect()` 仍是 **0×0**，Playwright 的 `click`/`selectOption`
   会以 `element is not visible` 超时。
2. 打开路径**跨宿主文案不同**：ST 是「扩展程序」、Luker 是「扩展」
   ⇒ **只能按 class 定位**（`.drawer-opener` 优先取文字含「扩展」者）。

固化为 `openWorkbench()`：点 `#extensionsMenuButton` → 点 `.drawer-opener` →
等 `#rm_extensions_block` 非 `none` → 展开插件 inline-drawer → **等 `#target-select` 有尺寸**。

---

## 4. 【疑似产品缺陷 N-1】外部包路径上 `native` 未走布局码归一

**证据（现场实测，两实例一致）**：同一个小包、同一宿主，只改目标选项：

| 目标选项 | 计划摘要条 |
| --- | --- |
| `native`（宿主原生格式） | 直通 7 / **无合成** / 预计产物 **7** · 570.0 B |
| `st`（显式 SillyTavern） | 直通 7 / **合成 1** / 预计产物 **8** · 870.0 B |

**根因**：`native` 的语义是「当前宿主的布局码」，而**归一只在宿主拉取路径做了**：

- **有归一** —— `index.js:193`
  `const target = rawTarget === 'native' ? hostLayoutCode(host.platform || 'st') : rawTarget;`
- **无归一** —— 外部包路径的 `refreshPlan`（`index.js:631-641`）与
  `btnConvert`（`index.js:1519-1520`）都**直接取** `targetSelect.value`，
  于是字符串 `'native'` 直达计划器 / 转换器；
  而 `plan-preview.js` 的合成分支只认 `TARGETS.L`（:372）与 `TARGETS.ST`（:383）
  ⇒ **`native` 不匹配任何合成分支**，也不参与布局判定。

**影响面**：
- 在 ST 宿主上（源本就是 ST 布局）「原样直通」恰好**等价**，用户看不出差别；
- 在 **Luker 宿主上选「宿主原生格式」**时，用户期望得到 **Luker 布局包**，
  而按此口径会得到**未经布局转换的直通结果**。

**处置**：按本任务 `prd.md` Out of Scope「不修任何插件的功能缺陷 —— 发现的缺陷只登记、当轮不修」，
**本轮不修**，仅在矩阵里**钉住差异**（断言 `native` 与 `st` 的读数**不相等**；
将来若补齐归一，该断言会报红，提示把期望值改成「两者一致」）。

**建议**（留给后续裁决）：把 `refreshPlan` / `btnConvert` 的取目标处也走 `hostLayoutCode` 归一，
与宿主拉取路径（`index.js:193`）一致。

---

## 5. M-7 可达性真相：**转换任务根本不给 TaskManager 注册**

设计文档 §3.4 的 M-7 写「pause → resume 后 `resumedCount > 0`；terminate 后引用被重置」。
**实测与源码核实后：该描述在转换路径上不可达。**

- 全仓 `taskControls.showRunning` **只出现一次**（`index.js:942`），
  其上文是 `index.js:938` `taskManager.start(taskId, '宿主拉取', {…})` —— 即**宿主拉取**路径。
- `btnConvert` 路径（`index.js:1519` 起）自始至终**不碰 TaskManager**。
- 且 `onResume`（`index.js:491`）只在 `id.startsWith('fetch-')` 时才真正续传。

⇒ **续传只存在于「宿主拉取」路径**；「转换任务的暂停/续传」在产品里**不存在**。
矩阵据实按可达面验，并把差异钉住：

- `#task-controls` 初态隐藏（无活动任务）；
- **转换期间控制条始终保持隐藏**（转换不进 TaskManager 的**直接证据**）；
- 设计文档声称的 `resumedCount > 0` 一项**未验**（不在可达面内），
  已在 `prd.md` 残留表登记（R-16）。

**未做**：宿主拉取路径的 pause/resume 实测。理由：触发它会对实例发起**真实的全量拉取**
（Dev Luker 是 1 GB 级），为验状态机而拉全量不可接受；且本仓纪律要求「只读、最小触碰实例」。

---

## 6. 可重跑性（AC-5）的真敌人：**持久化 workspace 状态**

E2E 用持久化 profile（`.pw-profile-dev`），而插件把当前工作区状态写进 IndexedDB 的
`workspace` store（`active_session`）并在下次加载时恢复（`restoreWorkspaceState`）。

**实测症状**（同一 spec、同一实例、两轮之间）：

- 喂进新源包后计划读数**纹丝不动**（仍显示上一轮的包）——
  因为 `index.js:1473` 的 `if (!currentFile) { currentFile = item.file; … }`
  **只在尚无源包时采纳新文件**；
- `#stash-list` **一张卡都没有**；
- `targetSelect` 一会儿是 `native`、一会儿是 `l`（自动推断分支 `index.js:1475` 只在 `!currentFile` 时执行）
  ⇒ 同一个 spec 在两实例上跑出**不同读数**，一红一绿。

**改法**：`resetWorkspace(page)` —— 删 `workspace` store 的 `active_session` 后**重载页面**，
让插件以空工作区启动。**只动 `workspace` store**，不删 `files` store
（删除会波及用户在该 profile 里的既有测试数据，风险不对等）。

配合**增量判定**（M-6 的 `origin=converted` 记录**与基线比较**，而不是「等于 0」），
本 spec 已**连续两轮全绿**。

> 注：先前版本用「converted 记录数 == 0」的绝对判定 —— 第一轮绿、第二轮必红（上一轮记录还在）。
> **持久化环境里的断言一律用增量，不用绝对值。**

---

## 7. 夹具（fixtures）相关

### 7.1 放大夹具必须**不可压缩**

M-7 需要暂停窗口、M-9 需要切出多分卷，迷你夹具（2.5 KB）做不到。生成 ~6 MB 放大包时：

- **第一版**用 LCG（`seed & 0xff`）造「随机」字节 —— 结果 6 MB 被 deflate 压到 **13 KB**
  （实测：3 MB 输入 → 落盘 13582 字节）。
  **根因**：LCG 的**低位周期极短**（低位比特周期 2^k，取最低 8 位周期仅 ~256），序列高度可压缩。
- **现版**用 **SHA-256 计数器模式**（`sha256("<seed>:<ctr>")` 逐块拼接）：不可压缩 + 完全确定性。
  实测落盘 6.0 MB，分割切出 **8 个分卷**。

### 7.2 【缺陷登记】`fixtures/gen.js` 的 CLI 入口在本机**静默空操作**

- **症状**：`node fixtures/gen.js <outDir>`（即 `npm run gen-fixtures`，`package.json:31`）
  **退出码 0、零输出、不产任何文件**。
- **根因**：`fixtures/gen.js:144` 的入口守卫
  ``if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`)``
  —— `import.meta.url` 给的是 `file:///D:/…`（**三个**斜杠），而构造出的是 `file://D:/…`（**两个**）
  ⇒ **永不相等**。实测：`pathToFileURL()` 的输出以 `file:///` 开头（**三个**斜杠，
  盘符形态为 `file:///X:/…`），而上面构造出的是 `file://` 开头（**两个**斜杠）。
  （`node -e` 下 `process.argv[1]` 为 `undefined`，该行会直接抛 `TypeError` —— 同一缺陷的另一种表现。）
- **影响**：这是**文档化命令**（`CLAUDE.md` 的「常用命令」段列有 `npm run gen-fixtures`），
  但实际从未生效；调用方若依赖它产夹具会静默拿到空目录。
- **本任务**：`e2e/specs/matrix.e2e.cjs` **绕过该 CLI**，用动态 `import()` 直调 `generateAll()`。
- **处置**：属既有缺陷、非本任务范围，**只登记不修**（登记在 `prd.md` 残留表 R-17）。

---

## 8. 与 `design.md` §3.4 的差异汇总

| # | 设计文档说法 | 实测 | 处置 |
| --- | --- | --- | --- |
| M-7 | 「转换 pause → resume 后 `resumedCount > 0`」 | 转换**不注册** TaskManager ⇒ 不可达 | 按可达面验 + 登记 R-16 |
| M-3 | 「类目/计数与 `dryRun` 读数一致」 | 一致；但读出元素是 `#plan-summary-bar` 系，非 `count-*` | 已按实际元素断言 |
| M-8 | 「`restoreCapability` 三态与实际端点一致」 | 三态**不可直接观测**（未挂 `window`）；可见性契约可双向验 | 只验非破坏性部分（不主动发恢复请求） |
