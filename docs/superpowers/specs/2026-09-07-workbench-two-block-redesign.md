# 技术设计：工作台两块式重构 + 宿主导出报错修复 + 酒馆主题配色

> 2026-09-07 · brainstorming 产出 · 用户已逐节确认
> 前置任务：`09-07-ui-unify`（已完成，本设计在其产物上继续演进）

## 0. 背景与根因

### 0.1 宿主导出报错（P0）

Luker 宿主下点"导出并立即下载/存入工作区"必报：

```
Error: convert: target 必须是 st|l|tt|pt 之一
    at Worker.handler (worker-client.js:141)
    at handleHostExport (index.js:834)
```

根因链：
- `detectHost()` 返回的平台代码是 `'luker'`；
- `index.js:733`（handleHostExport）：`targetLayout = selectedTarget === 'native' ? host.platform : selectedTarget`
  —— `native` 直出时把 `'luker'` 原样传给 `runConversionTask`；
- `transform.js:202-203` `convert()` 校验 target ∈ {st, l, tt, pt}，`'luker'` 不合法即抛错。
- 触发条件：`needsTransform === true`（跨格式直出 / 剔除原生资产(默认勾选) / 不含备份 / ST 宿主部分类目）——默认配置下必然命中。
- 外部转换路径不受影响（`onFilesReady` 已做 `luker→'l'` 映射）；文件名预览 `index.js:110` 与 `resolveFilename(target=...)` 同样吃进 `'luker'`，产出错误文件名。

### 0.2 UI 问题（用户原话归纳）

1. 四块抽屉（宿主导出/工作区/外部互转/报告）DOM 顺序与心智模型不符，上传入口藏在"外部互转"里；
2. 进度条在页面最底部，任务运行时不可见；
3. "宿主导出"与"外部转换"选项重复分离，应完全合并；
4. 深色主题下出现黑字（不可读）；
5. 配色是插件自造的金色系，不是酒馆主题配色。

黑字与金色根因：`style.css:12-16` 在容器上**硬编码覆盖**了 5 个宿主主题变量
（`--SmartThemeBodyColor/ChatTintColor/BorderColor/QuoteColor/EmColor`），全部金色系；
`workbench-template.js` 内联大量硬编码色值（`color:#11111b`、`#fbbf24`、蓝色 rgba 卡片底等）。
按钮采用"强调色实底 + 写死深色文字"，宿主主题按钮底变暗时文字即不可读。

### 0.3 已验证的事实依据

- Luker 原生"存储查看"实现 = `public/scripts/browser-storage-inspector.js`：
  `navigator.storage.estimate()` + `indexedDB.databases()`，纯浏览器标准 API，
  无 Luker 专属端点 → 本插件可直接复用同款，ST/独立模式同样可用。
- `navigator.storage.estimate()` 返回 `{ usage, quota }`（整个页面源级别）。
- File System Access API `showSaveFilePicker`：Chrome/Edge 支持，需特性检测回退。
- HTML5 drag-out（`DataTransfer.setData('DownloadURL', ...)`）：Chromium 支持，需特性检测回退。

## 1. 设计总览（用户确认的两块式）

```
┌─ 块一：状态头 + 数据包区 ──────────────────────────┐
│ 状态行: [宿主徽标][用户徽标][平台标识]                │
│ 配额条 ×2: ①插件 IndexedDB 用量/配额                 │
│            ②页面整体存储 usage/quota                │
│ ┌ 上传暂存区 ─────────────────────────────────┐   │
│ │ 拖入/点击上传(多份) · 源包列表(复选框点选多选)     │   │
│ │ 选中批操作: 载入为源/下载/写回宿主/删除           │   │
│ └─────────────────────────────────────────────┘   │
│ ┌ 待导出区 ───────────────────────────────────┐   │
│ │ 产物列表(复选框点选多选)                        │   │
│ │ 拖文件出(Chromium) / 选位置导出(FS Access)     │   │
│ │ 选中批操作: 下载/存工作区/写回宿主/移除           │   │
│ └─────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────┘
┌─ 块二：统一选项 + 执行区 ───────────────────────────┐
│ ▓ 进度条 (DOM 在块二顶部 + position:sticky 吸顶)     │
│ 类目勾选 (唯一一套: category-filter 组件)            │
│ 目标格式(插件模式含"宿主原生") / 压缩率 / 智能分包      │
│ 文件名模板 + 占位符芯片 + 预设                       │
│ 扩展打包模式 (轻量清单/完整离线) + 保留构建配置         │
│ 开关组: 备份快照/派生缓存/私有配置/增量合并/差量补丁/剔原生资产 │
│   └ 差量补丁子区(基准包选择) 仅勾选时展开              │
│ [从宿主拉取](仅插件)  [开始转换]                      │
│ ── 日志控制台 (块二底部) ──                          │
└────────────────────────────────────────────────────┘
```

- 原"宿主酒馆数据导出"抽屉、"外部数据包互转"抽屉外壳、报告抽屉外壳（报告内容保留，
  挂块二进度条下方）全部取消独立外壳。
- 保留但合并：`host-link-char-chats`（宿主侧联动）与 `link-char-chats-check`（外部侧联动）
  两个勾选框合一为 `#link-char-chats-check`，置于类目勾选组件旁，两条路径共用。
- 转换报告（module-grid + 丢弃/脱敏/警告手风琴）由 `view.renderReport` 填充，
  DOM 保留，默认隐藏、有报告时显示，位于进度条与选项之间。

## 2. 报错修复（独立提交 ①）

新增纯函数（`src/ui/host-bridge.js`）：

```js
/**
 * 宿主平台代码 → 转换器布局代码映射。
 * convert() 只接受 st|l|tt|pt；宿主检测返回 st|luker|standalone。
 */
export function hostLayoutCode(platform) {
  switch (platform) {
    case 'luker': return 'l';
    case 'st': return 'st';
    default: return platform; // standalone 等原样透传，由调用方兜底
  }
}
```

接入点（全部经此归一）：
- `index.js` handleHostExport：`effectiveTarget`、`targetLayout` 计算处；
- `index.js` updateFilenamePreview（约 :110）`effectiveTarget`；
- `index.js` runBatchConversion / btnConvert 回调中涉及 `host.platform` 作 target 的路径
  （审计一遍，外部包路径现有映射保持不动）。

测试（`test/detect-host.test.js` 追加）：`luker→l`、`st→st`、`standalone→standalone`、
未知值透传。全量测试保持绿（当前 137 项）。

## 3. DOM 结构重构（独立提交 ②）

### 3.1 workbench-template.js 新骨架

```
<div class="wb-block wb-block-status">          ← 块一
  <div class="status-row">徽标×3</div>
  <div class="quota-bars">两条配额条</div>
  <div class="upload-stash-zone" id="upload-stash-zone">
    <div class="drop-inline" id="dropzone">…</div>   ← 复用 setupFileDrop
    <div id="stash-list"></div>                      ← 源包列表(新渲染器)
    <div id="stash-batch-bar" hidden></div>
  </div>
  <div class="export-zone">
    <div id="export-queue-panel"></div>              ← 改造 renderExportQueue
  </div>
</div>
<div class="wb-block wb-block-controls">          ← 块二
  <div class="progress-sticky" id="progress-container">…</div>
  <div id="report-panel">…</div>                  ← 有报告才显示
  <div class="unified-options">…</div>
  <div class="action-row">[从宿主拉取][开始转换]</div>
  <div id="log-console"></div>
</div>
```

删除：`host-export-card` 抽屉、`external-convert-card` 抽屉、`report-panel-drawer` 外壳、
`host-category-grid`+`host-cat` 复选框组、`host-target-select`、`host-split-select`、
`host-filename-preview(-row)`、`workspace-panel-drawer`/`workspace-bar` 外壳
（状态行并入块一）。

### 3.2 统一选项（一套控件，两入口共用）

- 类目：现有 `category-filter` 组件唯一保留（对齐 ST/Luker 类目 + 规划预览）。
  宿主拉取时：Luker → 勾选透传端点；ST → 全量拉取后插件内按同一勾选过滤（现逻辑）。
- 目标格式：唯一 `#target-select`；插件模式 JS 动态插入 `<option value="native">宿主原生格式</option>`
  并默认选中；独立模式无此选项。执行时 `native` → `hostLayoutCode(host.platform)`。
- 压缩率 / 智能分包 / 文件名模板 / 扩展模式 / 开关组：沿用现有控件 id，位置迁入统一选项区。
- 差量基准模式：原 `#incremental-mode-check`（外部路径"增量合并"：包内同名文件仅更新较新者，
  转换器内生效）与 `#host-incremental-export`（差量补丁：与外部基准 ZIP 比对仅保留新增/修改项，
  `generateDeltaArchive` 生成 `_delta_patch.zip`）是**两种不同语义**，不合并：
  两个开关都保留并迁入统一开关组；差量补丁开关勾选后展开基准包子区（本地文件 / 暂存列表
  二选一），宿主拉取与外部转换两条路径都执行差量比对（`generateDeltaArchive` 本就通用）。
- 暂存列表（新 `src/ui/stash-list.js`）：渲染 `origin in {upload, host-export}` 的源包，
  行 = 复选框 + 名称 + 来源徽标 + 布局徽标 + 大小 + [载入为源][下载][写回宿主][删除]；
  批操作条在勾选 ≥1 时出现。载入为源沿用 `onLoadFile` 语义（取选中第一个）。
- 待导出区（改造 `renderExportQueue`）：
  - 每行加复选框；批操作条：下载选中（无 FS Access 时逐个普通下载）、选位置导出选中、
    存工作区、写回宿主、移除；原"全部下载/全部存入"按钮保留。
  - 拖出：行元素 `draggable=true`，dragstart 时对 Chromium 走
    `dt.setData('DownloadURL', 'application/zip:<name>:<blobURL>')`（blobURL 需延时 revoke）；
    非 Chromium 无该类型则跳过（按钮路径兜底）。
  - 选位置导出：`showSaveFilePicker({ suggestedName })` → `createWritable` 写 blob；
    `AbortError`（用户取消）静默；不支持时回退 `triggerBlobDownload`。
- 产物**不再 autoDownload**（`enqueue` 的 autoDownload 分支保留但插件内不再传 true），
  统一落待导出区由用户处置。

### 3.3 index.js 控制器适配

- `handleHostExport(targetDestination)` 参数语义变化：原 download/workspace 二选一改为
  统一入待导出区（按钮合并为一个"从宿主拉取"），删除 `btn-host-export-download/workspace` 双按钮。
- `runBatchConversion` 产物同样 enqueue（不再直接 saveFile）。
- 恢复弹窗、扩展安装器、日志控制台、category-filter、file-drop 模块不动（file-drop 仅换挂载点）。
- `view.setProgress` 的进度文案阶段映射保持（宿主打包→传输→转换→差量→分包）。

## 4. 配色重构（独立提交 ③）

### 4.1 变量层

```css
.app-container, .st-converter-drawer-app {
  /* 删除 5 个 --SmartTheme* 硬编码覆盖；宿主环境自动继承主题，独立环境走回退值 */
  --bg-primary: var(--SmartThemeBodyColor, #0d1017);
  --bg-secondary: var(--SmartThemeChatTintColor, #161b26);
  --border-color: var(--SmartThemeBorderColor, rgba(255,255,255,0.14));
  --accent: var(--SmartThemeQuoteColor, #f59e0b);
  --text-em: var(--SmartThemeEmColor, #fbbf24);
  /* 金色系自造变量全部删除，59 处引用改指上述主题变量 */
}
```

- 独立 Web 模式：变量未定义 → 回退值提供现有深色底（基调保留，仅去掉"金色品牌化"）。
- 插件模式：五个变量全部来自宿主主题 → 换主题即跟随。

### 4.2 黑字根除（对比安全模式）

CTA/强调按钮统一改为酒馆惯用式样（**不用实底+深色字**）：

```css
.btn-accent {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  color: var(--accent);
  border: 1px solid var(--accent);
}
@supports not (color: color-mix(in srgb, red, blue)) {
  .btn-accent { background: rgba(245, 158, 11, 0.22); } /* 回退 */
}
```

- `workbench-template.js` 内联硬编码全部收敛为 CSS 类（`btn-accent`、`hint-em` 等），
  删除 `color:#11111b`、`#fbbf24`、蓝色 rgba 卡片底等写死值。
- 文字色一律 `--text-main` / `--text-muted` / `--text-em`（全部主题变量或中性灰），无写死色。
- 注意事项：宿主抽屉内 `.text_pole`/`.menu_button`/`.checkbox_label` 等原生类样式
  已按 `09-07-ui-unify` 结论全量作用域化，本次只改值不改作用域，不回归宿主污染问题。

## 5. 配额条（两行，块一状态行下）

`src/ui/usage-dashboard.js` 重构为 `renderQuotaBars({ containerEl, pluginUsage })`：

- 行①：插件 IndexedDB —— 复用现有 `getStorageUsage()/getStorageQuota()`；
- 行②：页面整体 —— `navigator.storage.estimate()`，不支持则整行隐藏；
- 渲染进块一（脱离原 usage-dashboard 位置）；按来源统计 chips 移到暂存列表头部（轻量、可点筛选）。

## 6. 测试与验证

- 单测追加：`hostLayoutCode` 映射；stash-list 多选状态机（无 DOM 环境逻辑抽取为纯函数）；
  export-queue 批量操作与 FS Access 回退路径（mock API）；配额条渲染（mock estimate）。
- 现有 137 项全绿；`export-queue.test.js` 中 autoDownload 断言更新。
- 手动验证（vite dev 独立模式）：两块布局、拖入多份、点选多选、拖出、选位置导出、
  深色可读性、进度条吸顶。Luker 实例**不手动写入**，Git 更新由实例拉取后真机复核
  （宿主导出不再报错、主题跟随、无黑字）。

## 7. 提交拆分

1. `fix(core): 宿主导出 target 归一为转换器布局代码` —— 第 2 节，可独立上线救急；
2. `refactor(ui): 工作台两块式重构（状态+数据包区 / 统一选项区）` —— 第 3、5 节；
3. `fix(ui): 配色完全继承酒馆主题并根除写死色值` —— 第 4 节。
