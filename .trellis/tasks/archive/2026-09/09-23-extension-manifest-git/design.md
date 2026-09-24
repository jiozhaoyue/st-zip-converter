# 设计：扩展清单契约与恢复引导语义

> 前置证据见 `research/00-manifest-git-contract-evidence.md`（含全部代码锚点与检索结论）。
> 本文件定义技术方案；需求与验收标准见 `prd.md`；执行步骤见 `implement.md`。

## 1. 目标与非目标

**目标**：让「扩展清单」成为一条**有明确契约、两种模式共用、恢复端可判定状态**的元数据通道。

**非目标**：
- 不实现 `gitMode`（keep/strip/minimal）——属 `09-22-extension-git-slim`。
- 不做浏览器端 Git repack / shallow shrink。
- 不修改宿主安装端点、不写实例目录。
- 不修 `index.html` 与插件模板的整体结构分歧（属 `09-24-dual-entry-sync-standalone`）。

## 2. 数据契约（schema v2）

### 2.1 私有清单 `_convert/extensions-manifest.json`

顶层：

```jsonc
{
  "converter": "st-zip-converter",
  "schemaVersion": 2,          // 新增（v1 为缺省，读取端须兼容）
  "generatedAt": "<FIXED_TIMESTAMP>",
  "mode": "manifest" | "full", // 现有；full 为新增取值
  "total": 3,
  "extensions": [ /* 见 2.2 */ ]
}
```

> `schemaVersion` 与 `mode` 组合表达完整语义：缺省 `schemaVersion` 等价于旧版、仅 manifest 模式、无状态字段。

### 2.2 条目字段

| 字段 | 类型 | 来源 | 说明 |
| --- | --- | --- | --- |
| `id` / `name` | string | 现有 | 宿主目录名（稳定标识），二者同值 |
| `displayName` | string | `manifest.display_name \|\| name` | 展示名 |
| `description` | string | `manifest.description` | 描述 |
| `url` | string | `gitMeta.remoteUrl \|\| srcRecord.remote_url \|\| manifest.homePage` | 可为空串 |
| `branch` | string | `gitMeta.branch \|\| srcRecord.reference \|\| 'main'` | 默认分支 |
| `commit` | string | `gitMeta.commit \|\| srcRecord.installed_commit` | 可为空 |
| `version` | string | `manifest.version \|\| '1.0.0'` | 展示用 |
| `type` | string | 恒 `'extension'` | 官方索引兼容 |
| **`sourceKind`** | `'git' \| 'homepage' \| 'unknown'` | **新增**，派生 | 见 2.3 |
| **`availability`** | `'embedded' \| 'installable' \| 'unavailable'` | **新增**，派生 | 见 2.3 |
| **`notes`** | string | **新增**，派生 | 用户可见提示（空则不输出） |
| `manifest` | object | 现有 | 原始 `manifest.json`，**仅私有清单保留**（官方索引不输出） |

### 2.3 派生规则（唯一权威实现点）

```
hasUrl(ext) = isInstallableUrl(ext.url)   // 核心层自持的 http(s) 判定，与 src/ui/escape.js 同规则

sourceKind:
  url 来自 gitMeta.remoteUrl            → 'git'
  url 来自 srcRecord.remote_url         → 'git'
  url 来自 manifest.homePage            → 'homepage'
  否则                                   → 'unknown'

availability:
  mode === 'full'                                   → 'embedded'
  mode === 'manifest' && hasUrl                     → 'installable'
  mode === 'manifest' && !hasUrl                    → 'unavailable'

notes（仅在有值时输出）:
  availability === 'unavailable' → '清单未记录可用的 Git URL，无法在线安装；请手动获取该扩展。'
  sourceKind === 'homepage'      → '来源为扩展主页而非 Git 仓库，安装可能失败。'
```

**关键约束**：`availability` 与 `sourceKind` **必须由纯函数从原始输入派生**，不得由调用方传入——保证 FULL / MANIFEST 两条产出路径同源。

### 2.4 官方索引 `extensions-index.json`（仅 MANIFEST 生成）

保持现有字段集（`id/name/description/url/branch/commit/type`）+ **过滤**：`availability === 'unavailable'` 的条目不写入（官方格式无该语义，写入空 URL 会让宿主 Content Downloader 报错）。

**FULL 模式下不生成此文件**（决策 D-6）：该索引的语义是「按 URL 在线下载」，而 FULL 包内已有实体，宿主若按索引再装一遍会造成重复安装与潜在覆盖。清单仍写入私有文件，恢复端据此提供「更新引导」。

## 3. 生成端改造

新增纯逻辑模块 **`src/core/extension-manifest.js`**（`transform.js` 已 911 行，不再膨胀）：

```js
export const MANIFEST_SCHEMA_VERSION = 2;
export const AVAILABILITY = { EMBEDDED, INSTALLABLE, UNAVAILABLE };
export const SOURCE_KIND = { GIT, HOMEPAGE, UNKNOWN };

export function isInstallableUrl(value)                        // 核心层自持的 http(s) 判定
export function deriveExtensionEntry({ name, manifest, gitMeta, sourceRecord, mode })
export function buildExtensionManifest({ extensions, mode })   // → 私有清单对象
export function buildOfficialIndex({ extensions })             // → 官方索引对象（过滤不可安装项）
```

`transform.js` 的 `emitSynthesized()` 改动点：

| 现在 | 改为 |
| --- | --- |
| `shouldEmitManifest = (ST \|\| L) && mode === MANIFEST` | `shouldEmitManifest = (ST \|\| L) && (mode === MANIFEST \|\| mode === FULL)` |
| 手写 `extItems.push({...})` | 调 `deriveExtensionEntry()` |
| 无条件生成两份产物 | 私有清单两种模式都生成；官方索引仅 MANIFEST 生成 |
| `warn` 文案只说轻量清单 | 按 mode 分化文案（FULL 说明「包内已含扩展代码，清单仅用于更新引导」；MANIFEST 保持现有 408 说明） |

**兼容性**：`extensions` 为空时不产出（保持现有 `extItems.length > 0` 守卫）。

## 4. 新增只读清单导出（决策 D-2）

**形态**：清单卡片旁一个按钮，点击即产出一份**只读清单文件**，不写入包、不触发安装面板。

- 触发点：工作台「扩展」相关区域（与 `extension-mode` 选择器同区）。
- 产物：`extensions-manifest-<时间戳>.json`，进**待导出区**（现有统一出口 `export-queue.js`，不自动下载——遵守既有约定）。
- 内容：与私有清单同 schema，`mode` 取当前选择器值。
- 空扩展时按钮禁用并提示「未检测到扩展」。

**纯逻辑载体**：来源为当前已选源包。实现走 `buildExtensionManifest`，扩展信息从一次 `plan-preview` 扫描（`generatePlan` 已解析 `extensionManifests` / `extensionGitMeta`）获取，避免重复实现解析。

## 5. 恢复端改造（`host-bridge.js`）

### 5.1 读取与归一

```
读取 _convert/extensions-manifest.json
  → JSON.parse 失败 / 非对象 / extensions 非数组  ⇒ 忽略并 warn（现有行为，保留）
  → 逐条归一：
      缺省 schemaVersion(v1)  ⇒ availability 按 mode 推断（MANIFEST ⇒ 有 url 则 installable 否则 unavailable）
      availability 非法值     ⇒ 回退按同一规则推断
      url 非 http(s)          ⇒ 强制 unavailable
```

归一函数独立可测：`normalizeManifestEntries(raw)`（导出以便单测）。

### 5.2 触发语义（决策 D-4）

| 包内清单状态 | 恢复后行为 |
| --- | --- |
| 存在 `installable` 条目 ≥ 1 | 自动弹出安装器，**只列 `installable` 项** |
| 仅 `embedded` / `unavailable` | **不自动弹出**；日志提示「本包含 N 个扩展，其中 0 个可在线安装」，UI 提供手动入口 |
| 无清单（旧包 / 非 ST·L 目标） | 完全维持现状（不弹窗） |

**FULL + embedded 项处理**：弹窗中折叠为一行只读摘要「包内已含 N 个扩展实体（已随恢复写入）」，不提供勾选框——它们不需要安装。

### 5.3 三类状态 UI

| 状态 | 徽标 | 可勾选 | 说明文案 |
| --- | --- | --- | --- |
| `installable` + 未安装 | 「待安装」（现有蓝） | ✅ 默认勾选 | — |
| `installable` + 已安装 | 「本地已安装」（现有灰） | ✅ 默认不勾选 | — |
| `embedded` | 「包内已含」（绿） | ❌ | 折叠摘要行 |
| `unavailable` | 「无法在线安装」（红） | ❌ | 显示 `notes` + 目录名提示 |

**顶部说明文案**（新增一行）：在线安装需要**网络连通**、**宿主扩展安装端点可用**（部分部署/权限配置会禁用）、以及**扩展仓库可访问**（私有仓需手动处理）。

### 5.4 安全纪律（不可回归）

- 所有来自包内 JSON 的字段**一律 `createElement + textContent`**（现有纪律，见 `src/ui/escape.js` 头部注释）。
- 新增的任何 `innerHTML` 静态模板必须包裹 `trustedStaticMarkup()`，且入参不得含变量。
- `npm run check:dom-injection` 必须保持通过。

## 6. UI 双入口同源同改（L1-MR-10）

新增/修改的 DOM 节点：

| 位置 | 节点 |
| --- | --- |
| `index.html:277-296` | 只读清单导出按钮 + 在线安装说明文案 |
| `src/ui/workbench-template.js:193-210` | 同上（**同一次提交内同步**） |

**自查**：`grep -c "btn-export-ext-manifest" index.html src/ui/workbench-template.js` 两处均须 ≥ 1。
（该自查并入 `implement.md` 的验证命令，不新建守卫脚本——避免与 `09-24-dual-entry-sync-standalone` 的守卫重复。）

## 7. 测试矩阵

| 文件 | 覆盖点 |
| --- | --- |
| `test/extension-manifest.test.js`（新） | schema 版本、`sourceKind` 三条派生分支、`availability` 三态、`notes` 生成、官方索引过滤不可安装项、`isInstallableUrl` 拒绝 `javascript:` / `data:` |
| `test/convert.test.js`（扩展） | FULL 模式产出私有清单且条目标 `embedded` 且**不产出** `extensions-index.json`；MANIFEST 模式回归（现有断言不变 + 新字段）；`schemaVersion === 2`；无 URL 扩展标 `unavailable` |
| `test/restore-manifest.test.js`（新） | `normalizeManifestEntries` 对 v1 / 非法值 / 非 http URL 的归一；三态分类计数；「全部 embedded ⇒ 不弹窗」判定 |
| 现有 226 项 | 必须零退化（`mode: 'manifest'` 断言仍成立） |

## 8. 兼容与回滚

- **向后兼容**：v1 清单可读（归一兜底）；旧包恢复行为不变；旧产物不变（除清单多两个字段）。
- **向前兼容**：`schemaVersion` 递增留出扩展位；未知字段读取端忽略。
- **回滚**：改动集中在 3 个模块 + 2 处模板 + README，无数据迁移，`git revert` 即可完全回滚。

## 9. 开放风险

| 风险 | 处理 |
| --- | --- |
| FULL 包内清单会让部分宿主/工具误判为「需在线安装」 | 仅私有清单（`_convert/` 前缀非官方路径）、不生成官方索引、文案明确「包内已含」 |
| 「已安装」判定依赖宿主 `discoverHostExtensions()`，独立模式不可用 | 独立模式下安装器本就不可用（无宿主端点），归类为 `installable` 并提示需在宿主内操作 |
| `homePage` 作为 URL 时实际不可安装 | `sourceKind='homepage'` + `notes` 提示；不臆断为可安装 |
