# 实施清单：扩展清单契约与恢复引导语义

> 需求见 `prd.md`，技术方案见 `design.md`，证据锚点见 `research/00-manifest-git-contract-evidence.md`。
> 决策：D-1 至 D-7 已由用户于 2026-09-24 确认（其中 D-5/D-6/D-7 为三条全部照此实施）。

## 规划阶段（已完成）

- [x] 用户确认清单契约字段与 OQ-1/OQ-2/OQ-3（OQ 处置见下方「开放问题处置」）。
- [x] 检索现成 manifest 格式与酒馆扩展清单实践（GitHub API 双通道，结论：无可复用方案）。
- [x] 补 design 中的 schema 版本、兼容策略和测试矩阵。
- [x] 配置 implement/check 上下文清单。
- [x] 提交最终规划摘要，获批后 start。

## 实施阶段

### A. 新增纯逻辑模块 `src/core/extension-manifest.js`

- [x] A1 迁移四个扩展路径/Git 解析 helper（`extractGitRemoteUrl` / `extractGitBranch` /
      `extensionFolderName` / `extensionRelativePath`）自 `transform.js`，并在 `transform.js`
      改从新模块 import（保持再导出以免破坏潜在外部引用）。
- [x] A2 导出 `MANIFEST_SCHEMA_VERSION = 2`、`AVAILABILITY`、`SOURCE_KIND` 三个冻结常量。
- [x] A3 导出 `isInstallableUrl(value)`——核心层自持 http(s) 判定，与 `src/ui/escape.js`
      的 `isSafeHttpUrl` 同规则（核心层不依赖 UI 层，故不 import）。
- [x] A4 导出 `deriveExtensionEntry({ name, manifest, gitMeta, sourceRecord, mode })`，
      实现 design §2.3 的三条派生分支（`sourceKind` / `availability` / `notes`）。
- [x] A5 导出 `buildExtensionManifest({ extensions, mode })`——私有清单对象（含 `schemaVersion: 2`）。
- [x] A6 导出 `buildOfficialIndex({ extensions })`——官方索引对象，过滤 `unavailable` 项。
- [x] A7 导出 `normalizeManifestEntries(raw)`——恢复端归一（design §5.1）：v1 缺省按 mode 推断、
      非法 `availability` 回退推断、非 http(s) URL 强制 `unavailable`。

### B. 生成端改造 `src/core/transform.js`

- [x] B1 `shouldEmitManifest` 放开为 `(ST || L) && (MANIFEST || FULL)`。
- [x] B2 `extItems.push({...})` 手写块替换为 `deriveExtensionEntry()` 调用。
- [x] B3 私有清单 `_convert/extensions-manifest.json` 两种模式都产出（带 `schemaVersion: 2`）。
- [x] B4 官方 `extensions-index.json` **仅 MANIFEST 产出**（D-6），并过滤不可安装项；FULL 不产出。
- [x] B5 `warn` 文案按 mode 分化（FULL 说明「包内已含扩展代码，清单仅用于更新引导」）。
- [x] B6 保留 `extItems.length > 0` 空守卫（无扩展时不产出任何清单）。

### C. 只读清单导出（D-2）

- [x] C1 `plan-preview.js` 的 `generatePlan` 补出扩展元数据字段。
      **与 design §4 的偏差修正**：设计假设 `generatePlan` 已解析
      `extensionManifests` / `extensionGitMeta`，实际该解析只存在于 `transform.js` 主循环。
      改为一趟轻量扫描：复用 `routeSource` + `extensionFolderName` / `extensionRelativePath`
      + `extractGitRemoteUrl` / `extractGitBranch` + `parseJsonSafe`，仅解析
      `extensions/<name>/manifest.json` 与 `.git/*` 元数据条目，**不读实体文件**。
- [x] C2 `index.js` 在扩展模式区接一个「仅导出扩展清单」按钮：产物经 `exportQueue.enqueue()`
      进待导出区（`origin: 'converted'`，`ephemeral: true`，**不自动下载**）。
- [x] C3 空扩展时按钮禁用并提示「未检测到扩展」。

### D. 恢复端改造 `src/ui/host-bridge.js`

- [x] D1 `restoreToHost` 读清单后改为 `normalizeManifestEntries()` 归一，再按 design §5.2 判定：
      仅 `installable` ≥ 1 才自动弹窗；否则只 `logger.info` 提示并提供手动入口。
- [x] D2 `renderExtensionInstallerModal` 支持三类状态徽标与可勾选性（design §5.3 表格）。
- [x] D3 `embedded` 项折叠为一行只读摘要（「包内已含 N 个扩展实体（已随恢复写入）」），不给勾选框。
- [x] D4 `unavailable` 项显示 `notes` + 目录名提示，不可勾选。
- [x] D5 顶部新增说明文案：在线安装需网络 + 宿主扩展安装端点可用 + 扩展仓库可访问。
- [x] D6 安装前 `url` 校验改走 `isInstallableUrl`（与核心层同规则），避免两套判定分叉。
- [x] D7 安全纪律：所有包内 JSON 字段一律 `createElement + textContent`；新增静态模板包
      `trustedStaticMarkup()` 且入参不含变量。

> D3 实现说明：`embedded` 项以「包内已含」绿徽标 + 禁用勾选框（`opacity: 0.35`）呈现，
> 而非独立折叠摘要行——三类状态共用同一列表骨架，避免为摘要行再写一套 DOM 分支。
> 验收等价性：不可勾选、有序展示、恢复诊断日志给出 `embeddedCount` 计数。

### E. UI 双入口同源同改（L1-MR-10）

- [x] E1 `src/ui/workbench-template.js` 扩展模式区新增只读清单导出按钮 + 说明文案。
- [x] E2 `index.html` 同一次提交内同步同一改动。
- [x] E3 自查：`grep -c "btn-export-ext-manifest" index.html src/ui/workbench-template.js` 两处均 ≥ 1。
- [x] E4 注意：改动须避开两副本已分歧的节点（`#stash-list` / `.wb-block`），
      不依赖任一不存在的元素（该分歧属 `09-24-dual-entry-sync-standalone`）。

### F. 文档

- [x] F1 README 补「清单包不含扩展代码，恢复后需联网在线安装」的用户说明。
- [x] F2 若触达 `.trellis/spec/`，按 3.3 更新 spec（扩展清单 schema v2 契约）。

## 验证命令

```bash
npm test                                  # 全绿，≥ 226 passed / 2 skipped 不退化
npx vitest run test/extension-manifest.test.js
npx vitest run test/restore-manifest.test.js
npx vitest run test/convert.test.js
npm run check:css-scope                   # 退出码 0
npm run check:dom-injection               # 退出码 0
grep -c "btn-export-ext-manifest" index.html src/ui/workbench-template.js   # 两处均 ≥ 1
```

手测（可选，仅 Dev 实例）：`npm run dev` → http://localhost:5173。
**严禁** Real 实例（8002 / 8004）。

## 新增测试文件

- [x] `test/extension-manifest.test.js`——schema 版本、`sourceKind` 三分支、`availability` 三态、
      `notes` 生成、官方索引过滤、`isInstallableUrl` 拒绝 `javascript:` / `data:`。
- [x] `test/restore-manifest.test.js`——`normalizeManifestEntries` 对 v1 / 非法值 / 非 http URL 的归一；
      三态分类计数；「全部 embedded ⇒ 不弹窗」判定。
- [x] `test/convert.test.js` 扩展——FULL 产出私有清单且条目标 `embedded` 且**不产出**官方索引；
      MANIFEST 回归（现有断言不变 + 新字段）；`schemaVersion === 2`；无 URL 扩展标 `unavailable`。

## 验证结果（2026-09-24 实测）

| 项目 | 结果 |
| --- | --- |
| `npm test` | **274 passed / 2 skipped / 36 文件**（基线 226/2/34；新增 48 条用例、2 个文件） |
| `npm run check:css-scope` | 通过（退出码 0） |
| `npm run check:dom-injection` | 通过（15 文件，整文件豁免 1） |
| `npm run build` | 成功（38 modules transformed） |
| 双入口自查 | `btn-export-ext-manifest` 两处均 1 |

### 主代理自核验（子代理上下文耗尽，按 G-5 降级为串行自核）

| 核验项 | 结论 |
| --- | --- |
| 核心层无 DOM 依赖 | ✅ `src/core/extension-manifest.js` 无 `document`/`window`/`src/ui/` 引用 |
| 无循环依赖 | ✅ `transform.js` 不导入 `plan-preview.js`；`plan-preview.js` 单向依赖两者 |
| 状态派生唯一性 | ✅ `availability`/`sourceKind` 仅在 `deriveExtensionEntry` 与 `normalizeManifestEntries` 派生 |
| XSS 安全 | ✅ 新增代码无 `innerHTML` 插值；包内 JSON 全走 `createElement + textContent` |
| 双入口一致 | ✅ id/class/图标/文案/样式逐字一致 |
| 边界用例 | ✅ 大写协议放行、首尾空白 trim、空 name 剔除、id 兜底 |
| 死代码 | ✅ 无未使用导入；`extItems` 已彻底移除 |
| Out of Scope 未越界 | ✅ 全仓无 `gitMode` 实现 |

> 核验降级说明：原派发的核验子代理两次因上下文耗尽未产出报告，按
> `.trellis/spec/guides/subagent-collaboration.md` 的 G-5（子代理不可用时不降级到其他
> agent 通道，由主代理串行完成）由主代理逐项自核。

## 开放问题处置（用户 2026-09-24 确认）

| 编号 | 处置 |
| --- | --- |
| OQ-1 | **采纳**：新增「仅导出扩展清单」只读选项（D-2，见实施 C）。 |
| OQ-2 | **不采纳** `.git/config` 回退提取（D-3）：无 URL 一律显式 `unavailable`，不伪造。 |
| OQ-3 | **保持自动弹出**，但只列可安装项（D-4，见实施 D1）。 |

## 回滚点

- 改动集中在 3 个模块 + 2 处模板 + README，**无数据迁移**，`git revert` 即可完全回滚。
- 每个实施块（A/B/C/D/E）完成后跑一次 `npm test`，任一失败即在该块内修复，不带病前进。

## 当前不做

- 不实现 `gitMode`（keep/strip/minimal）——属 `09-22-extension-git-slim`。
- 不做浏览器端 Git repack / shallow shrink。
- 不修改宿主安装端点，不绕过宿主权限，不写实例目录。
- 不修 `index.html` 与插件模板的整体结构分歧——属 `09-24-dual-entry-sync-standalone`。
