# CH4 审计报告：DOM 高频路径 + `innerHTML` 注入面（`src/ui/**`）

- **任务**：`.trellis/tasks/09-23-perf-security-audit`
- **审计对象**：链路④「DOM 高频路径 + `innerHTML` 注入面」
- **审计时间**：2026-09-23
- **审计方式**：只读源码审计（**未运行** `npm test` / `npm run build`，**未连接**任何酒馆实例 8001–8004；**未**构造恶意包做运行时验证，所有注入结论均为**静态可达性推导**）
- **复核方式**：搜索工具全量复核 `innerHTML` / `outerHTML` / `insertAdjacentHTML`（**0 处** `outerHTML`、**0 处** `insertAdjacentHTML`）；另复查 `document.write` / `createContextualFragment` / `eval(` / `new Function` / `dangerouslySet*`（**0 命中**）
- **命中总数**：**57 处**（其中 **1 处仅为注释提及**：`export-queue.js:384`；**实际赋值 56 处**）。分布：`src/ui/**` 共 **52 处（51 赋值 + 1 注释）/ 10 文件**；根 `index.js` 另有 **5 处**，属范围外相邻发现
- **发现条数**：**9 条**（**高 1** / 中 2 / 低 4 / 信息 2）——清单表覆盖全部 57 处，逐条明细只列非平凡者
- **最高严重度**：**高**

---

## 结论摘要

> **一句话结论：存在完整的「包内容 → `innerHTML`」污染路径**——攻击者分发一个数据包，包内 `_convert/extensions-manifest.json`（或扩展的 `manifest.json` 的 `display_name`）携带 HTML 片段，受害者在插件内点「写回宿主 / 恢复」成功后，`host-bridge.js:702` 用**未转义的字符串模板**渲染扩展安装面板 → 在酒馆页面（同源、可读 `/csrf-token`、可读全部聊天）执行任意脚本。

补充要点：

| 维度 | 结论 |
| --- | --- |
| 注入面规模 | **56 处赋值**中：**1 处高危**（`host-bridge.js:702`）、**6 处文件名为用户可影响**（`export-queue.js:332`、`file-drop.js:78/136`、`stash-list.js:155`、`index.js:604/1021`）、**1 处来自宿主响应正文**（`host-bridge.js:831`）、**1 处参数化但当前仅传常量**（`host-bridge.js:1132`）、**1 处已转义**（`log-console.js:138`），其余 **46 处为静态串/空串/数字/枚举** |
| 唯一转义点 | `src/ui/log-console.js:8` 的 `escapeHtml`（转义 `& < >`），仅用于**日志正文**；其余模块**零转义** |
| 文件名路径 | 上传包名**未净化**（`index.js:1091` 原样写库），经 `stash-list.js:155` / `export-queue.js:332` / `file-drop.js:78,136` / `index.js:604,1021` 进入 `innerHTML` → 「用户可影响」级（注意：同模块的 `archive-manager.js:101-102` 用的是安全写法 `textContent`） |
| 模板文件名路径 | `resolveFilename` 已过 `sanitizeFilename`（剥 `<>:"/\|?*` 与控制符，`src/core/filename-template.js:19-22`），故 `part.partName` / 生成名**不可注入** → 降级为「信息」 |
| 高频路径 | **三处高频路径全部已 rAF 合帧**（进度 `view.js:44-61`、待导出区整表 `export-queue.js:384-397`、日志 `log-console.js:296-304`）→ 与 L1-MR-9 一致，**无回归** |
| 未合帧的同源风险 | `archive-manager` / `stash-list` / `usage-dashboard` 是**异步全量重建**（每次触发跑一遍 IndexedDB `listStoredFiles()`），由 `updateWorkspaceUI()` 串起；批量转换时逐个 `enqueue` 只走已合帧的 `export-queue`，但用户连续点击/批量入库会多次全量重建（**低**） |

---

## 审计范围与判定口径

- **「用户可控」分三档**（本报告的核心判定尺度）：
  1. **攻击者可控** = 攻击者可远程构造该字符串并让受害者导入（包内 JSON、包内文件名、HTTP 响应正文）→ **高**
  2. **用户可影响** = 字符串来自受害者本机文件名 / 自身宿主账号名，命名不受本插件约束（本机文件名可由下载方 `Content-Disposition` 指定）→ **中**
  3. **不可控** = 内部常量、枚举、数字、自生成 ID、已由 `sanitizeFilename` 净化 → **低 / 信息**
- **「是否转义」**：赋值处若经 `escapeHtml`/`textContent`/`createTextNode` 判「是」，否则「否」。
- 未做运行时验证的结论一律标 **「待验证」** 并给出验证方法（依任务约束禁连实例）。

---

# 一、完整清单表（`src/ui/**`，52 处）

> 严重度取「高 / 中 / 低 / 信息」。`—` 表示该处无插值。

## 1.1 `src/ui/archive-manager.js`（4 处）

| 文件:行号 | 插值内容 | 是否用户可控 | 是否转义 | 严重度 |
| --- | --- | --- | --- | --- |
| `archive-manager.js:66` | 空串（清空容器） | 否 | — | 信息 |
| `archive-manager.js:77` | `${f.icon}` `${f.label}` `${count}`（`FILTERS` 内部常量 + 计数） | 否 | 否 | 信息 |
| `archive-manager.js:115` | `${label.text}`（枚举映射）`${(file.layout \|\| '未知').toUpperCase()}`（`detect()` 枚举）`${formatBytes(file.size)}` `${formatDate(file.createdAt)}` | 否（枚举/数字） | 否 | 信息 |
| `archive-manager.js:171` | 静态串 `<i class="fa-solid fa-rotate"></i> 写回宿主` | 否 | — | 信息 |

> 注：同一文件 `:101-102` 渲染文件名用的是 **`textContent`**（安全），与 `:115` 的 `innerHTML` 形成对比——**同一模块内已有安全写法可复用**。

## 1.2 `src/ui/category-filter.js`（4 处）

| 文件:行号 | 插值内容 | 是否用户可控 | 是否转义 | 严重度 |
| --- | --- | --- | --- | --- |
| `category-filter.js:127` | 空串 | 否 | — | 信息 |
| `category-filter.js:163` | 静态串 `重置动作筛选` | 否 | — | 信息 |
| `category-filter.js:180` | 空串 | 否 | — | 信息 |
| `category-filter.js:454` | 空串（`resetCategoryFilter`） | 否 | — | 信息 |

> 注：本模块所有**包内路径**都走 `textContent`（`:236-237` `badge.textContent`、`:266` `text.textContent`），**无注入面**——可作为整仓的正面样板。

## 1.3 `src/ui/export-queue.js`（7 处）

| 文件:行号 | 插值内容 | 是否用户可控 | 是否转义 | 严重度 |
| --- | --- | --- | --- | --- |
| `export-queue.js:235` | 空串 | 否 | — | 信息 |
| `export-queue.js:239` | `${queue.items.length}`（数字） | 否 | 否 | 信息 |
| `export-queue.js:248` | `b.innerHTML = html`（调用方 `mkBtn` 传静态串） | 否 | — | 信息 |
| `export-queue.js:277` | 空串 | 否 | — | 信息 |
| `export-queue.js:283` | `b.innerHTML = html`（同上静态） | 否 | — | 信息 |
| **`export-queue.js:332`** | `${item.name}`（**产物文件名，含未净化上传名**）`${item.id}`（自生成 `eq_<ts>_<seq>`）`${originLabel.cls/text}`（枚举）`${String(item.targetLayout).toUpperCase()}`（枚举）`${formatBytes(item.blob.size)}` | **是（用户可影响）** | **否** | **中** |
| `export-queue.js:352` | `b.innerHTML = html`（同上静态） | 否 | — | 信息 |

## 1.4 `src/ui/file-drop.js`（3 处）

| 文件:行号 | 插值内容 | 是否用户可控 | 是否转义 | 严重度 |
| --- | --- | --- | --- | --- |
| **`file-drop.js:78`** | `${file.name}`（**本机原始文件名，未净化**）`${sizeMb}`（数字） | **是（用户可影响）** | **否** | **中** |
| `file-drop.js:103` | `${zipFiles.length}`（数字） | 否 | 否 | 信息 |
| **`file-drop.js:136`** | `${name}`（`setFilename` 入参：上传原名或模板生成名） | **是（用户可影响）** | **否** | **中** |

## 1.5 `src/ui/file-tree-picker.js`（4 处）

| 文件:行号 | 插值内容 | 是否用户可控 | 是否转义 | 严重度 |
| --- | --- | --- | --- | --- |
| `file-tree-picker.js:50` | 静态 `<option>` 列表 | 否 | — | 信息 |
| `file-tree-picker.js:67` | 空串 | 否 | — | 信息 |
| `file-tree-picker.js:166` | 静态串 `>5MB` | 否 | — | 信息 |
| `file-tree-picker.js:172` | 静态串 `>1MB` | 否 | — | 信息 |

> 注：**包内条目的 `sourcePath` / `targetPath` / `reason` 全部走 `textContent`**（`:148-149`、`:158-159`、`:170`）→ 本模块**无注入面**，是正面样板。

## 1.6 `src/ui/host-bridge.js`（11 处）

| 文件:行号 | 插值内容 | 是否用户可控 | 是否转义 | 严重度 |
| --- | --- | --- | --- | --- |
| `host-bridge.js:630` | 静态模板 + `${anomaly.hasAnomaly ? ... : ''}`（布尔分支，静态串） | 否 | — | 信息 |
| **`host-bridge.js:702`** | `${ext.displayName \|\| ext.name \|\| folder}`、`${folder}`、**`${ext.url}`**、`${ext.branch}`、`${idx}` —— **全部来自包内 `_convert/extensions-manifest.json`** | **是（攻击者可控）** | **否** | **高** |
| `host-bridge.js:758` | 静态串 | 否 | — | 信息 |
| `host-bridge.js:815` | 静态串 `克隆中...` | 否 | — | 信息 |
| `host-bridge.js:827` | 静态串 `已安装` | 否 | — | 信息 |
| **`host-bridge.js:831`** | `${err.message}`（含**宿主 HTTP 响应正文**回显） | **是（宿主回显，间接）** | **否** | **中** |
| `host-bridge.js:852` | `${successCount}`（数字） | 否 | 否 | 信息 |
| `host-bridge.js:1029` | 静态模板 + `${getWorkbenchHtml({ isDrawer: true })}`（静态模板函数） | 否 | — | 信息 |
| `host-bridge.js:1094` | 静态串 | 否 | — | 信息 |
| `host-bridge.js:1132` | `${icon}` `${label}`（`mountNativeBackupButton` 内部常量实参） | 否 | 否 | 信息 |
| `host-bridge.js:1189` | 静态串 | 否 | — | 信息 |

> **注**：`:1132` 的 `${label}` 目前仅由常量调用（`'数据包互转'`、`'一键拉取'`），但 `mountNativeBackupButton` 是**导出 API**，未来传入用户数据即变成注入点 → 记为「信息 + 隐患」。另 `:1029` 的模板中间插入 `${getWorkbenchHtml({ isDrawer: true })}`（`src/ui/workbench-template.js:8`，内部只用布尔开关，无用户数据）。

## 1.7 `src/ui/log-console.js`（6 处）

| 文件:行号 | 插值内容 | 是否用户可控 | 是否转义 | 严重度 |
| --- | --- | --- | --- | --- |
| `log-console.js:27` | 静态模板 | 否 | — | 信息 |
| `log-console.js:138` | `${entry.timestamp}` `${entry.level}`（内部）`${escapeHtml(entry.message)}`、`detailHtml`（内部已 `escapeHtml`） | 是（日志内容含文件名） | **是** | 信息 |
| `log-console.js:149` | 空串 | 否 | — | 信息 |
| `log-console.js:209` | 读取旧 innerHTML（回填） | 否 | — | 信息 |
| `log-console.js:210` | 静态串 `已复制!` | 否 | — | 信息 |
| `log-console.js:211` | 回填 `origHtml`（自产） | 否 | — | 信息 |

> **本模块是全仓唯一的转义样板**：

```js
// src/ui/log-console.js:8-12
function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

> 该函数**不转义引号**，但因只用于**文本上下文**（非属性值）而足够；若将来复用到属性插值处会失效 → 见 D-06。

## 1.8 `src/ui/split-deliver-modal.js`（3 处）

| 文件:行号 | 插值内容 | 是否用户可控 | 是否转义 | 严重度 |
| --- | --- | --- | --- | --- |
| `split-deliver-modal.js:65` | `${totalParts}` `${totalFiles}` `${formatBytes(totalBytes)}`（数字） | 否 | 否 | 信息 |
| `split-deliver-modal.js:113` | `${part.partIndex}`（数字）`${part.partName}`（**已经 `sanitizeFilename` 净化**）`${formatBytes(part.sizeBytes)}` `${part.fileCount}` `${idx}` | **否（已净化）** | 否 | 信息 |
| `split-deliver-modal.js:167` | `${parts.length}`（数字） | 否 | 否 | 信息 |

> **补充事实（与链路③报告 S-09 一致）**：`renderSplitDeliveryModal` 在 `index.js:60` 被 import 但**全仓无调用点** → 本文件当前为死代码，其注入面**当前不可触发**。`part.partName` 由 `resolveFilename`（`splitter.js:126-133`）生成，经 `sanitizeFilename` 剥除 `<>` 等字符，**即使接回也不可注入**。

## 1.9 `src/ui/stash-list.js`（5 处）

| 文件:行号 | 插值内容 | 是否用户可控 | 是否转义 | 严重度 |
| --- | --- | --- | --- | --- |
| `stash-list.js:86` | 空串 | 否 | — | 信息 |
| `stash-list.js:87` | 空串 | 否 | — | 信息 |
| `stash-list.js:102` | 空串 | 否 | — | 信息 |
| `stash-list.js:114` | `b.innerHTML = html`（`mkBtn` 传静态串） | 否 | — | 信息 |
| **`stash-list.js:155`** | `${file.id}`（自生成 `source_<ts>_<rand>`）`${file.name}`（**未净化上传名**）`${label.text/cls}`（枚举）`${(file.layout \|\| '未知').toUpperCase()}` `${formatBytes(file.size)}` | **是（用户可影响）** | **否** | **中** |

## 1.10 `src/ui/usage-dashboard.js`（4 处）

| 文件:行号 | 插值内容 | 是否用户可控 | 是否转义 | 严重度 |
| --- | --- | --- | --- | --- |
| `usage-dashboard.js:47` | 空串 | 否 | — | 信息 |
| `usage-dashboard.js:57` | `${formatBytes(est.usage \|\| 0)}` `${formatBytes(est.quota)}` `${pct.toFixed(1)}`（数字） | 否 | 否 | 信息 |
| `usage-dashboard.js:74` | 静态模板 | 否 | — | 信息 |
| `usage-dashboard.js:91` | `${detail}`（由 `formatBytes` 数字拼装）`${over ? ... : ...}`（布尔） | 否 | 否 | 信息 |

> 注：本模块数据源为 `navigator.storage.estimate()`（数字）与宿主 `/api/users/storage/inspect` 的**数值字段**（`:66-70` 显式校验 `usedBytes == null`）→ 不可控。

## 1.11 范围外相邻发现：根 `index.js`（5 处）

> 不在任务 B 规定的 `src/ui/` 范围内，但**同属注入面且与高危链路串联**，一并列出。

| 文件:行号 | 插值内容 | 是否用户可控 | 是否转义 | 严重度 |
| --- | --- | --- | --- | --- |
| `index.js:586` | 静态串 | 否 | — | 信息 |
| **`index.js:604`** | `${currentBaseZip.name}`（**未净化上传名**）+ `${formatBytes(...)}` | **是（用户可影响）** | **否** | **中** |
| `index.js:607` | 静态串 | 否 | — | 信息 |
| **`index.js:1021`** | `${archiveFile.name}`（**未净化上传名**）+ `${formatBytes(archiveFile.size)}` + `${host.platform.toUpperCase()}`（枚举） | **是（用户可影响）** | **否** | **中** |
| `index.js:1348` | `${getWorkbenchHtml({ isModal: true })}`（静态） | 否 | — | 信息 |

---

# 二、高危逐条明细

## D-01 · 严重度：高 · 包内扩展清单字段直接拼进宿主页面 → 存储型 XSS（攻击者可控 + 未转义）

- **锚点**：`src/ui/host-bridge.js:702-733`（渲染）、`src/ui/host-bridge.js:464-478`（取数）
- **证据（渲染端，未转义字符串模板）**：

```js
// src/ui/host-bridge.js:702-733
itemEl.innerHTML = `
  <input type="checkbox" id="ext-chk-${idx}" ${!isInstalled ? 'checked' : ''} style="cursor: pointer;" />
  <div style="flex: 1; min-width: 0;">
    <div style="display: flex; align-items: center; gap: 8px;">
      <strong style="...">${ext.displayName || ext.name || folder}</strong>      <!-- ← 注入点 1 -->
      <span style="...">(${folder})</span>                                       <!-- ← 注入点 2 -->
      ...
    </div>
    <div style="...">
      <span>${ext.url || '无远程 URL'}</span>                                     <!-- ← 注入点 3 -->
      ${ext.branch ? `<span style="...">分支: ${ext.branch}</span>` : ''}         <!-- ← 注入点 4 -->
    </div>
  </div>
  <span id="ext-item-status-${idx}" ...></span>
`;
```

- **证据（取数端，来源是**包内文件**，无任何校验/白名单）**：

```js
// src/ui/host-bridge.js:464-478（restoreToHost 内）
const reader = await zipIo.openReader(zipBlob);
for await (const entry of reader.entries()) {
  if (entry.fileName === '_convert/extensions-manifest.json') {
    const text = new TextDecoder().decode(await entry.read());
    const manifest = JSON.parse(text);
    if (Array.isArray(manifest.extensions) && manifest.extensions.length > 0) {
      renderExtensionInstallerModal(manifest.extensions);      // ← 直接把包内数组交给 innerHTML 渲染
    }
    break;
  }
}
```

- **该清单从何而来**：本工具自己生成时取自**源包内各扩展的 `manifest.json`**——`src/core/transform.js:758`（`const displayName = manifest.display_name || name;`）→ `transform.js:795`（写出 `_convert/extensions-manifest.json`）。`url` 字段取自 `gitMeta.remoteUrl || srcRecord.remote_url || manifest.homePage`（`transform.js:756`），同样是**包内可控字符串**。
- **危害放大因素**：
  1. 触发入口是插件的**主推功能**（「写回宿主」→ 恢复成功即自动弹面板），受害者无需任何"越界"操作。
  2. 执行上下文是**酒馆页面本体**（同源）：可直接 `fetch('/csrf-token')`、读 `localStorage`（含聊天/角色数据）、以已登录身份调用 `/api/**`。
  3. 载荷载体是**任意 JSON 字符串**，不受文件系统文件名字符限制（对比文件名路径 D-02）。
  4. 木马包可以伪装成"某个热门扩展的备份"直接分发。
- **待验证**：`ext.displayName` 含 `<img src=x onerror=...>` 时是否在真实宿主页面触发脚本（静态推导已足够确认无转义；运行时验证需构造合成包 + Dev 实例，**本审计未做**）。**验证方法**：在 `Instance/Dev/**` 侧装入插件，构造含 `_convert/extensions-manifest.json`（`extensions:[{displayName:"<img src=x onerror=document.title='XSS'>"}]`）的合成 zip，点「写回宿主」，观察标题是否被改写。
- **修复方向（按优先级）**：
  1. **改 DOM 构造**：为每个字段建 `document.createElement` + `textContent`（与 `category-filter.js:266`、`file-tree-picker.js:148` 的既有安全写法一致）；
  2. 若保留模板串，则在拼接前对**每个** `ext.*` 字段调用**统一转义函数**（建议把 `log-console.js:8` 的 `escapeHtml` 提升到共享模块，并补 `"` `'` 转义）；
  3. 加**字段级白名单校验**：`url` 必须匹配 `/^https?:\/\//i`（安装时已有该校验，`host-bridge.js:820`，但**渲染时没有**）；`branch` 匹配 `/^[A-Za-z0-9._\/-]{1,100}$/`；`displayName`/`folder` 长度与字符集限制。

## D-02 · 严重度：中 · 文件名（未净化）→ 列表项 HTML

- **锚点**：`file-drop.js:78`、`file-drop.js:136`、`export-queue.js:332`、`stash-list.js:155`、`index.js:604`、`index.js:1021`（**对照安全写法**：`archive-manager.js:101-102` 渲染同名文件用的是 `nameEl.textContent = file.name`）
- **证据（入库侧：原样保存，无净化）**：

```js
// index.js:1086-1098（handleFiles → onFilesReady 批量入库）
const id = await saveFile({
  name: item.file.name,              // ← 完全原始的本机文件名（:1091）
  size: item.file.size,
  blob: item.file,
  layout: item.detection.layout,
  handle: itemHandle,
  role: 'source',
});
```

```js
// src/storage/db.js:187-200（saveFile 原样入库，仅 id 自生成）
const fileId = id || `${role}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const record = { id: fileId, name, size: ..., blob, layout: layout || 'unknown', ... };
```

- **证据（渲染侧，未转义）**：

```js
// src/ui/export-queue.js:332-345
info.innerHTML = `
  <div class="eq-name-row">
    <input type="checkbox" class="eq-select-box" data-id="${item.id}" ${selected.has(item.id) ? 'checked' : ''}>
    <span class="eq-name">${item.name}</span>              <!-- ← 文件名直插 HTML -->
  </div>
  ...
`;
```

```js
// src/ui/stash-list.js:155-165
info.innerHTML = `
  <div class="eq-name-row">
    <input type="checkbox" class="stash-select-box" data-id="${file.id}" title="加入选择">
    <span class="archive-name">${file.name}</span>         <!-- ← 文件名直插 HTML -->
    ...
`;

// index.js:1021（恢复确认弹窗）
restoreModalDesc.innerHTML = `即将把数据包 <strong>「${archiveFile.name}」</strong> (...) 恢复写入到当前酒馆宿主 ...`;
```

- **可控性论证**：本机文件名本身可被第三方指定（HTTP `Content-Disposition: attachment; filename="<img src=x onerror=...>.zip"`），Linux/macOS 允许 `<>` 出现在文件名中；Windows 下载后保存名可能被浏览器改写，但**跨平台不可依赖**。故判定「用户可影响」而非「攻击者可控」——需要受害者主动把该 zip 拖进工具。
- **为什么不是「高」**：触发需要受害者**导入**攻击者命名的文件；纯粹的自注入（自己给自己命名）无收益。对比 D-01（无需任何命名技巧、载荷为 JSON）低一档。
- **修复方向**：文件名一律 `textContent`；或统一走 `escapeHtml`。**优先修 `stash-list.js:155`、`export-queue.js:332`、`index.js:1021`**（同源数据、同一批次可一起改）。

## D-03 · 严重度：中 · 宿主 HTTP 响应正文 → `innerHTML`

- **锚点**：`src/ui/host-bridge.js:831`
- **证据**：

```js
// src/ui/host-bridge.js:518-540（错误构造：把响应正文原样拼进 message）
try {
  detail = await response.text();
} catch { /* 忽略 */ }
throw new Error(`安装失败 (${response.status})${detail ? `: ${detail}` : ''}`);
```

```js
// src/ui/host-bridge.js:831
statusEl.innerHTML = `<i class="fa-solid fa-circle-xmark" ...></i> ${err.message || '安装失败'}`;
```

- **可控性论证**：`detail` 是**宿主自身返回的正文**。宿主在克隆失败时通常回显被请求的 URL；而该 URL 来自 D-01 的同一条攻击者可控链（`ext.url`）→ 形成「攻击者 URL → 宿主回显 → `err.message` → `innerHTML`」的**二级注入**。
- **待验证**：宿主 `/api/extensions/install` 失败响应是否回显 URL 原文（不同宿主/版本不同）。**验证方法**：Dev 实例发起一次 `install` 请求携带含 `<b>` 的 url，抓取响应正文；或参考 `docs/research/` 下宿主机制报告。
- **修复方向**：`statusEl.textContent = \`…\`` 并拆出图标元素；`installExtensionViaHost` 的错误信息做 `escapeHtml` 或截断 + 字符白名单。

## D-04 · 严重度：低 · `export-queue` 属性插值 `data-id="${item.id}"` 依赖"ID 一定安全"

- **锚点**：`src/ui/export-queue.js:334`（`data-id="${item.id}"`）、`src/ui/stash-list.js:157`（`data-id="${file.id}"`）
- **证据**：`item.id = \`eq_${Date.now()}_${++seq}\``（`export-queue.js:133`）、`file.id = \`${role}_${Date.now()}_${random36}\``（`db.js:188`）→ 当前仅含 `[a-z0-9_]`，**不可注入**。
- **风险**：这是**隐式契约**（"ID 一定安全"），且 `saveFile` 的 `id` 是**外部可传参**（`saveFile({ id, ... })`，`db.js:187`）。任何未来调用方传入用户数据即立刻变成注入点（属性上下文，`"` 可逃逸）。
- **修复方向**：把 `data-id` 改为 `element.dataset.id = item.id`（属性赋值不解析 HTML），消除契约依赖。

## D-05 · 严重度：低 · `host-bridge.js:1132` 的导出函数用 `innerHTML` 拼参数

- **锚点**：`src/ui/host-bridge.js:1124-1140`
- **证据**：

```js
const makeButton = (id, icon, label, title, onClick) => {
  ...
  btn.innerHTML = `<i class="fa-fw fa-solid ${icon}"></i>${label ? `<span>${label}</span>` : ''}`;
```

- **可控性**：`mountNativeBackupButton` 当前只传常量（`'数据包互转'`、`'一键拉取'`），不可控；但它是**导出函数**，签名接受任意 `label` → 隐患。
- **修复方向**：内部改用 `createElement('span')` + `textContent`。

## D-06 · 严重度：低 · 唯一转义函数的作用域与能力不足

- **锚点**：`src/ui/log-console.js:8-12`
- **证据**：`escapeHtml` 仅转义 `& < >`，**不转义 `"` `'`**，且**函数级私有**（未导出），其他 9 个模块无法复用 → 事实上"每个模块各自为政"是 D-01/D-02 的根因之一。
- **修复方向**：抽到 `src/ui/escape.js`（或 `src/core/`），补齐 `"` → `&quot;`、`'` → `&#39;`，全仓统一引用；配套加一条 grep 自查（类似 L1-MR-3 的 CSS 自查脚本风格）。

---

# 三、高频 DOM 路径（Q3）

## 3.1 结论表

| 高频来源 | 触发频率 | 是否 rAF 合帧 | 锚点 | 判定 |
| --- | --- | --- | --- | --- |
| 转换/拉取进度回调 | 流式 fetch 约 50 次/秒 | **是** | `src/ui/view.js:44-61` | 通过（符合 L1-MR-9） |
| 待导出队列批量入队 | 每产物一次 + 每次状态变更 | **是**（整表重建按帧合并） | `src/ui/export-queue.js:384-397` | 通过 |
| 实时日志写入 | 每 `logger.*` 一次 | **是**（批量 + 单帧上限） | `src/ui/log-console.js:296-304`、`log-console.js:251-282` | 通过 |
| 工作区/暂存/配额三块全量重建 | 每次 `updateWorkspaceUI()` | **否** | `index.js:405-412` | 低风险（非高频） |
| 分卷进度 | — | **无回调** | `index.js:939`、`index.js:1215` 未传 `onProgress` | 见链路③报告 S-07 |

## 3.2 证据（三处合帧实现）

```js
// src/ui/view.js:44-61
let pendingProgress = null;
let progressRafId = 0;
function applyProgress() { progressRafId = 0; ... }
function setProgress(percent, label = '') {
  const clamped = Math.min(100, Math.max(0, Math.round(percent)));
  pendingProgress = { percent: clamped, label: label || pendingProgress?.label || '' };
  if (!progressRafId) { progressRafId = requestAnimationFrame(applyProgress); }
}
```

```js
// src/ui/export-queue.js:384-397
// 渲染合帧：批量转换时 notify 高频触发，整表 innerHTML 重建按帧合并
let renderScheduled = false;
const renderCoalesced = () => {
  if (renderScheduled) return;
  renderScheduled = true;
  const run = () => { renderScheduled = false; render(); };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 0);
};
queue.subscribe(renderCoalesced);
```

```js
// src/ui/log-console.js:296-304
logger.subscribe((entry) => {
  ...
  pendingEntries.push(entry);
  if (!renderScheduled) { renderScheduled = true; requestAnimationFrame(flushPendingEntries); }
});
// :270-282 单帧上限 MAX_LINES_PER_FRAME，超出折叠为一行提示
```

### D-07 · 严重度：信息 · 高频路径无回归，符合 L1-MR-9

- **锚点**：上表三处
- **结论**：所有**高频** DOM 写入均已合帧；`requestAnimationFrame` 全仓仅 3 处调用点，与上表一一对应，无遗漏。**无需修复**。

### D-08 · 严重度：低 · `updateWorkspaceUI()` 串行全量重建三块（含 IndexedDB 读）

- **锚点**：`index.js:405-412`

```js
async function updateWorkspaceUI() {
  if (!isStorageSupported()) return;
  try {
    await refreshArchiveManagerUI();     // → listStoredFiles() 全表读 + 整表重建
    await refreshUsageDashboard();       // → navigator.storage.estimate() + Luker 配额 fetch
    refreshExportQueueUI();
  } catch (err) { console.warn('刷新工作区 UI 失败:', err); }
}
```

- **证据**：`renderArchiveManager` 每次调用 `await listStoredFiles()`（`archive-manager.js:63`）并 `containerEl.innerHTML = ''` 整表重建；`renderStashList` 同理（`stash-list.js:79-87`）。批量入库 N 个文件时 `index.js:1120` 只调一次（好），但 `restoreToHost` 后、每次 `stash` 后、每次删除后都会整轮重建。
- **量化**：单轮 = 1 次 IndexedDB 全表扫 + 2~3 次整块 innerHTML 重建；**非高频**（人为操作驱动），故仅记「低」。
- **修复方向**：把三块刷新也纳入同一个 rAF/微任务合帧调度；`listStoredFiles()` 结果做短 TTL 缓存（同一 tick 内多次 `updateWorkspaceUI` 合并为一次读）。
- **验证方法**：Dev 实例（或独立模式）批量入库 20 个包，用 Performance 面板统计 `updateWorkspaceUI` 调用次数与 long task 分布。

### D-09 · 严重度：信息 · 每处 `innerHTML` 都是"整块销毁重建"

- **证据**：57 处中约 20 处是 `container.innerHTML = ''` / 模板重写整块。这是注入面之外的**另一类**成本（丢弃事件委托之外的全部节点状态），例如 `log-console.js:149`、`export-queue.js:235`、`category-filter.js:180`、`archive-manager.js:66`、`stash-list.js:86`。
- **现状**：`export-queue.js:374-382` 已用**事件委托**（`list.addEventListener('change', …)`）规避重渲染丢事件 → 说明该模式在本仓已成熟，可作为后续增量渲染改造的基础。
- **修复方向（后续）**：对超过 ~200 行的列表改 keyed 增量更新（diff 后再 patch），而非整表重建。

---

## 立即修复建议

| 序 | 动作 | 锚点 | 类型 |
| --- | --- | --- | --- |
| B1 | `renderExtensionInstallerModal` 的扩展字段改 `textContent` / `createElement`，并对 `ext.url` 补 `/^https?:\/\//i` 渲染期校验 | `host-bridge.js:702-733` | 安全（高） |
| B2 | `statusEl.innerHTML` → `textContent`（图标拆成独立节点） | `host-bridge.js:831` | 安全（中） |
| B3 | 文件名类注入点改 `textContent`：`stash-list.js:155`、`export-queue.js:332`、`index.js:604`、`index.js:1021`、`file-drop.js:78/136` | 各锚点 | 安全（中） |
| B4 | `data-id="${…}"` 改 `element.dataset.id = …` | `export-queue.js:334`、`stash-list.js:157` | 安全（低，去隐式契约） |
| B5 | 抽出共享 `escapeHtml`（补 `"` `'`）到 `src/ui/escape.js`，`log-console` 改为引用；新增 grep 自查：`src/ui/**` 中 `innerHTML` 含 `${` 的行必须带 `escapeHtml`/`textContent` 标记 | `log-console.js:8-12` | 安全（低，防复发） |
| B6 | `updateWorkspaceUI` 三块刷新合帧 + `listStoredFiles` 短 TTL 缓存 | `index.js:405-412` | 性能（低） |

> **建议提交顺序**：B1 → B2（同一文件，安全优先）→ B3 → B5 → B4 → B6。B1/B2 属"用户可见注入面止血"，建议单独成 commit 便于回溯。

## 建议纳入后续优化任务

1. **统一转义层 + 机器化守卫**：以 B5 的自查脚本为起点，建立"`innerHTML` 白名单"机制（类似已有的 `npm run check:css-scope`——`scripts/css-scope.js`），把「未转义的 `${` 插值」纳入 CI 门禁。这是**唯一能阻止该问题复发的机制**（本仓已有 CSS 作用域的同类先例，且 `AGENTS.md` 记录了那次真实事故）。
2. **`innerHTML` 模板统一改造**：把余下 ~20 处整块模板串改写为 `createElement` + `textContent`（可参照 `category-filter.js` / `file-tree-picker.js` 两个已完全安全的模块样板）。
3. **列表增量渲染**：`archive-manager` / `stash-list` / `export-queue` 引入 keyed diff，替代整表重建（与链路③的"分卷产物长期驻留"配合，避免每次重渲染 O(n) 模板构建）。
4. **D-08 的 IndexedDB 读缓存**：`listStoredFiles()` 加 tick 级缓存，配合 `updateWorkspaceUI` 合帧。
5. **与链路①报告的交叉引用**：`01-restore-chain.md` 已从"恢复链路"视角记录了 `host-bridge.js:702/706/714` 的注入面；本报告从"全仓 `innerHTML` 面"视角独立确认并补全了调用链与其余 56 处判定。**两份报告在该点上互为独立证据**，修复时以 B1 为同一落点。
6. **`host-bridge.js:1132` 的 API 加固**：既然 `mountNativeBackupButton` 是导出 API，建议其 `label` 参数走 `textContent`，并在 JSDoc 注明"不接受 HTML"。
