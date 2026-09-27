# 独立 Web 形态 / 云部署形态的自动化验证

> 适用：要验「**页面自己就是站点**」的那种形态（`index.html` 骨架 + `bootstrap()` 注入工作台），
> 以及**云托管形态**（子路径静态托管，如 GitHub Pages 项目页 `/<repo>/`）。
> 与 `instance-e2e-and-data-sync.md` 的分工：那份讲**宿主实例**上的 E2E（端口守卫、Dev/Real 红线、
> 实例数据搬移）；本份讲**没有宿主**的那条路径 —— 两者前置、风险面、判定口径都不同。

---

## 1 为什么单开一套运行器（`npm run e2e:web`）

| 维度 | `npm run e2e`（实例） | `npm run e2e:web`（独立/云） |
| --- | --- | --- |
| 被测对象 | 实例里加载的插件副本 | **本仓构建产物**（`dist/`） |
| 前置 | 实例在跑（8001/8003） | 一次构建 + 一个静态服务器 |
| 端口红线 | **Dev 白名单 / Real 拒绝**（`e2e/lib/guard.cjs`） | 无实例数据风险；用已登记端口 **4173**（L0-16） |
| 报错归因 | 只看能归因到本插件的（同页 30 个扩展） | **全量可归因**（页面 100% 是本插件） |
| 判定重点 | 宿主注入、跨宿主差异、CSRF/拉取/写回 | 子路径可用性、形态差异可见契约、转换闭环 |

代码落点：`e2e/standalone/{run.cjs,lib/*,specs/*,specs-src/*}`。
**它是独立目录**：`e2e/run.cjs` 只扫 `e2e/specs/`，两者互不触发（并发跑也不会互相污染）。
后缀必须是 `.e2e.cjs` —— `.spec.cjs` / `.test.js` 会被 vitest 当单测收集（实测踩过）。

### 两个挂载点（同一端口、同一台服务器）

| 前缀 | 根 | 用途 |
| --- | --- | --- |
| `/st-zip-converter/` | `dist/` | 构建产物 ⇒ `specs/` 下的用例（形态 / 云子路径 / 闭环 / 分卷） |
| `/src-tree/` | 仓库根 | **未打包 ESM 源码树** ⇒ `specs-src/` 下的用例 |

为什么要有源码树挂载：构建产物是**单包**，模块边界被打散 ⇒ 页内 `import` 不到单个模块。
源码树里模块是独立文件，于是可以在**真实浏览器**（真 `Blob`、真 `Worker`、真 `zip.js`）里
直接驱动真实模块跑完整链路 —— 例如聊天库适配的消费侧链路
（`specs-src/chat-store-module.e2e.cjs`：建源包 → 探测/列库 → 比对 → 只导出缺失项 → 注入 →
**真实转换** → 解包核对，外加「不注入桩 ⇒ 补齐消失」的判别力对照）。
这条路径**不需要任何实例**，也避免了「只为验一段逻辑去拉实例 1.5 GB 数据」的高昂代价。

> 安全：源码树挂载会暴露仓目录 ⇒ 服务器对**路径段以 `.` 开头或为 `node_modules`** 的请求
> 一律 404（`.git/`、`.env` 之类不提供）。

公共辅助在 `e2e/standalone/lib/common.cjs`（`waitForPlan` / `readCategory` / `readReportCount` /
`waitForQueue` / `fillNumber` / `downloadFirstRow` / `readZip` / `buildZip` / `ensureFixtures`），
三个 spec 共用 —— 不要在各 spec 里再抄一份。

## 2 为什么「子路径」是独立形态的核心判据

`vite.config.js` 用的是 `base: './'`（全部资源相对引用），**这正是云子路径部署能否成立的前提**。
在根路径跑永远发现不了绝对路径引用 ⇒ 运行器默认把站点挂在 **`/st-zip-converter/`** 之下：
真源 `dist/` 不动，靠服务器把前缀映射掉（`e2e/standalone/lib/static-server.cjs`）。

判定：
- **B2**：静态服务器收到的**同源**请求里，**没有一条**落在前缀之外；
- **B3/B4**：站点资源（含浏览器侧读数）零 4xx/5xx。
- `--prefix /` 可对照跑根路径形态。

### ⚠️ 改 base 时改哪个文件（实测踩过）

`package.json` 的构建脚本是 **`vite build --base=./`** —— CLI 标志**覆盖** `vite.config.js` 里的
`base`。所以：**只改 `vite.config.js` 的 `base` 对构建产物毫无影响**（实测：把 config 改成
`base: '/'` 重新构建，`dist/index.html` 里仍是 `./assets/…`，B2 照绿 ⇒ 一次**无效实验**）。
判别力证明必须改**构建脚本的标志**。

**已实测的判别力**（2026-09-27）：把 `--base=./` 改成 `--base=/` ⇒ 该 spec **10 条转红**
（A1–A5 形态判定全灭 + B1–B4 + 闭环一条）⇒ 这条断言确实抓得住「子路径部署坏了」。

## 3 四条「红灯来自断言自己」的坑（都在首轮踩过或差点踩到）

1. **favicon 假红**：`index.html` 未声明 icon ⇒ 浏览器会去**根路径**取 `/favicon.ico`，
   在子路径部署下**必然 404**，且与站点可用性无关。不排除它，B2/B3 会得到一条假红。
   ⇒ 断言里统一 `isFavicon()` 过滤（并在报告里写明为什么）。
2. **锚错了面板**：`#count-chars` 等计数在 **`#report-panel`（转换后报告）** 里，且初始 `hidden`；
   上传源包后填的是 **`#category-checkboxes` 下的类目卡片**（读数在 `.cat-badge`，形如 `1 项 · 20 B`）。
   拿报告面板的读数去断言「计划阶段解析正确」⇒ 一片假红。
   ⇒ 计划阶段读 `.category-card[data-category="…"]`，转换后读 `#report-panel`。
3. **恒真断言（假绿）**：`all.x >= full.x` 在两侧都是 0 时**恒真**。
   ⇒ 任何「A 与 B 相等/不小于」的断言前，必须先有一条**前置门**断言 A/B 非零（本套件里的 C11/E1）。
4. **`page.fill` 静默失败**：写分卷阈值时可能一个字符都没进去（宿主 splash 未关时更常见）。
   ⇒ 填值一律**回读校验**，失败退回程序化赋值（`fillNumber`）。

## 4 已登记的既有事实（**不要在断言里假装相反**）

### 4.1 「仅角色卡」与「仅聊天记录」当前产出**同一选择集**

`src/ui/category-filter.js:applyPreset` 里 `const isLinked = true;` 是**写死**的，
注释为「角色与聊天智能联动已恒开（用户裁决 6：移除该复选框，行为保留）」⇒
两个快捷预设都落到 `{characters, assets, chats}` 三类；「安全脱敏」是 `除 secrets/chats 外全部`。

- E2E 里**如实断言现状**（`workbench.e2e.cjs` 的 C10）：若将来有人把它们区分开，这条转红，
  从而**强制一次显式决策**（而不是让 UI 语义悄悄漂移）。
- 改这个方向是**产品裁决**，不是实现细节：把「仅角色卡」改成不含聊天，会让用户在
  「我只想要卡」时**静默丢掉聊天记录**（与 `L0-1` 的数据损失红线同形），故不得由实现方擅改。

### 4.2 独立形态的 Font Awesome 已改**本地副本**（原为 CDN 外链）

**现状（2026-09-28 起）**：`index.html` 引 `./src/vendor/fontawesome/css/all.min.css`
（本地副本，含 4 个 `.woff2`，见该目录 `README.md`）。跨源请求读数**归零**。

**为什么必须改**：原实现从 cdnjs 外链 Font Awesome ⇒ ① 违反用户级全局规则 **`nocdn`**；
② **离线 / 内网 / 云部署不可达 CDN 时全部图标失效**；而**插件态不受影响**
（酒馆宿主自带 FA），所以这个缺口只在独立形态暴露，平时看不见。

**守护断言（3 条，缺一不可 —— 「零跨源」本身也可能是「图标全没了」）**：
- **A6** 页面存在图标元素（读数非空，否则下面两条恒真）；
- **A7** `document.fonts.check('900 1em "Font Awesome 6 Free"')` 为真 ⇒ 字族**已加载**；
- **A8** 图标元素 `::before` 的 `font-family` 命中 FA。
- 外加 `B3/B4/F4` 的「零 4xx」兜住字体文件的取用失败。

**判别力已实测**：把 `webfonts/` 移走并**强制重建** ⇒ **6 条转红**
（A7/A8 + B3/F4 的两条 4xx + 另两条），复原后全绿。

> ⚠️ **A7 必须先显式 `await document.fonts.load(...)` 再问**：FA 的 `@font-face` 用
> `font-display: block`，字体**按需懒加载** ⇒ 就绪后立刻 `fonts.check()` 会**时真时假**
> （实测吃到过一次假红）。`document.fonts.load()` 强制拉取并 resolve，判据才确定。

> ⚠️ **这一轮踩到的坑**：首轮做这个实验时**没重建**，跑的是旧 `dist/`（字体还在），
> 于是「实验」全绿 ⇒ **无效实验**。原因是运行器的构建新鲜度判据只看 **mtime**，
> 而**删除源码文件不会让任何文件的 mtime 变新** ⇒ 判据看不见删除。
> 故：**凡涉及删文件/换文件的实验，必须 `--rebuild`**（该标志已加，注释里也写了原因）。

### 4.3 默认扩展模式是「轻量清单」⇒ 扩展实体代码**不在产物里**

`workbench-template.js:176` 的 radio **默认选中 `manifest`**（轻量清单模式），该模式按设计
「不打包扩展实体代码，但合成索引与安装脚本」（产物里能看到 `_extensions-index.json` /
`_convert/INSTALL.md` / `_convert/extensions-manifest.json`，看不到 `extensions/<名>/`）。
⇒ 任何「扩展落位」断言都必须**先把模式切到 `full`**，并把「默认值是什么」显式断言为**前提**
（`targets.e2e.cjs` 的 T5/T10 就是干这个的；首版漏了这一步，直接吃到三条假红）。

**切模式不能靠 `page.check()`**：该 radio 在折叠区里，可见性门会 30 s 超时，
`check({ force: true })` 也点不动 ⇒ 走 DOM 事件（`el.checked = true` + `change` 事件），
再**回读 `:checked` 确认真的切过去了**（动作方式不是判据，回读才是）。

### 4.4 `targets.e2e.cjs` 的落位判据来源

四目标的落位规则全部取自仓内权威文档 `tavern-datapack-formats.md` 的「包布局速查」，
且只断言其中标注**〔仓内〕**的条：ST/L 摊平（L 另加根 `manifest.json`）、TT/PT 走
`data/default-user/` + 扩展在 `data/extensions/third-party/` + PT 需**来源记录**。

### 4.5 🔴 已知缺陷：暂停 → 续传后**产物缺条目**（静默数据损失）

**取证（2026-09-28，`specs/pause-resume.e2e.cjs` 首次抓到）**：1500 条聊天的源包，
转换中途暂停再继续，产物只剩 **1453** 条（该轮跳过 48 项）；另一次实测 1437 条（跳过 64 项）。
**UI 与日志都报「转换成功」**，用户在下载前无从察觉。

**机理**（三处合起来构成必然的静默损失）：

1. `src/core/transform.js:354` 的 `onProgress` 在**投递给 writer 之前**上报
   ⇒ 断点清单记录的是「已读到」而不是「已写入」，**超前于**实际产物；
2. 暂停走 `worker.terminate()`，而 `src/core/worker-client.js:117` 明确
   「**半成品 BlobWriter 丢弃**」⇒ 已写入的那部分也一并没了；
3. 续传时 `resumeCrcMap` 命中即**跳过**（既不重读也不重写），而目标 zip 是**新建的空包**
   ⇒ 被跳过的条目**既不在旧产物（已丢）也不在新产物（被跳过）** ⇒ 永久缺失。

**为什么既有测试没抓到（本条最大的价值）**：

- 单测 `test/convert-resume.test.js` 锁的是**机理**而不是不变量 ——
  `expect(names).not.toContain('settings.json')`（「跳过 ⇒ 产物里没有」），
  于是「跳过语义」被验成绿；
- 实例矩阵 M-7b 只断言「日志出现『沿用断点跳过 N 项』」，**没有断言产物完整**；
- 两条合起来：**没有任何一条测试问过「用户拿到的包是不是完整的」**。

**修法（须与既有断言一起改，故未擅自改动，登记待裁决）**：

- **(a) 真正的增量续传**：把暂停时的半成品产物跨会话保留（如 OPFS 暂存），续传在其上继续写；
- **(b) 最小正确修**：转换路径**不传** `resumeCrcMap`（暂停后重做，但产物完整）——
  代价是 `test/convert-resume.test.js` 的「`not.toContain`」与矩阵 M-7b 的「跳过 N 项」
  断言**必须同步更新**（它们锁的是缺陷形态）。

E2E 当下**如实断言缺陷形态**（R12/R13 带 `KNOWN-DEFECT` 标记）：修好后这两条会转红，
从而**强制**把断言改成「产物条目数与源包一致」。

> 复核方式：`npm run e2e:web -- --only pause`，看 R9 的「沿用断点跳过 N」与 R12 的
> 「源 / 产物 / 跳过」三个数字。

## 5 覆盖范围（当前）

| spec | 挂载点 | 覆盖 |
| --- | --- | --- |
| `specs/workbench.e2e.cjs` | dist | 形态判定（`独立 Web 模式`）、形态差异可见契约（无「从宿主拉取」/ 无「写回宿主」行按钮）、**子路径挂载**、计划预览、**包选择预设**（精简/完整）、转换闭环（上传→转换→**下载并解包核对**）、转换后报告读数、零报错 |
| `specs/split.e2e.cjs` | dist | 阈值真写进输入框（回读校验）、**真的切成多份**（≥2 且序号从 1 连续）、分卷产物是合法 zip |
| `specs-src/chat-store-module.e2e.cjs` | src-tree | 聊天库适配消费侧全链路（真模块 / 真 Blob / 真转换 / 桩供给方）+ **判别力对照**（无桩 ⇒ 补齐消失） |
| `specs/flows.e2e.cjs` | dist | **文件名模板**（回读确认 + 预览求值 + 产物名真的按模板生成）+ **存工作区**（落库 `origin`/`role`、跨重载语义：临时产物清空而库内记录仍在） |
| `specs/pause-resume.e2e.cjs` | dist | 转换的暂停/续传（无需实例）—— 含 **§4.5 那处已知缺陷**的取证与 `KNOWN-DEFECT` 锁 |
| `specs/file-protocol.e2e.cjs` | dist | `file://` 双击形态的**边界登记**（模块被 CORS 拒）+ 那层「可照做的说明」确实出现 |
| `specs/targets.e2e.cjs` | dist | **四目标兼容矩阵**（ST/L/TT/PT 落位规则，取自 `tavern-datapack-formats.md` 的〔仓内〕条）+ **扩展模式两态**（默认轻量清单 vs 完整）+ **包选择预设两态**（精简 vs 完整，含密钥/世界书/设置的取舍） |

当前断言总数：**170 项**（2026-09-28 实测全绿：workbench 42 · targets 51 · flows 16 ·
chat-store-module 17 · perf 12 · split 10 · pause-resume 16 · file-protocol 6）。

未覆盖（登记，勿当成已覆盖）：`file://` 双击形态、插件模态态、Authority 增强层降级、
多页签并发、超大批次（GB 级）、**宿主拉取路径的注入接线**（需真拉 1.5 GB 实例数据，代价过高）。

## 6 运行

```bash
npm run e2e:web                    # 需要时自动构建 → 挂 /st-zip-converter/ → 跑全部
npm run e2e:web -- --no-build      # 用现有 dist（会做新鲜度告警）
npm run e2e:web -- --only split    # 只跑某个 spec
npm run e2e:web -- --prefix /      # 对照：根路径形态
```

端口被占用时**报错退出**（strictPort 语义）：不自动换端口 —— 换端口等于换目标，
读数会变得不可解释（与实例侧 `guard.cjs` 同一条纪律）。
