# 设计：扩展 Git 历史瘦身（gitMode 策略分流）

> 依据：`prd.md`（含本轮 git 层实测取证）+ 现场读码结论。
> 边界原则：本设计**不引入任何新依赖**，不碰 vendor 副本，不改 Worker 管线（选项本就 `...options` 透传）。

## 1. 契约

### 1.1 新选项 `gitMode`

```js
export const GIT_MODES = Object.freeze({
  KEEP: 'keep',       // 原样保留全部 .git 条目（默认，零行为变化）
  STRIP: 'strip',     // 剔除整个 .git/（接收方失去在线更新，需重新 clone）
  MINIMAL: 'minimal', // 仅保留识别与更新所需最小集 + 合成占位文件
});
```

- 入口：`transform(options.gitMode)`、`generatePlan(options.gitMode)`，默认 `GIT_MODES.KEEP`。
- **未知取值一律回落 `KEEP`**（防御式归一，不抛错——与现有 `extensionMode` 的宽松处理一致）。
- `worker-client.js` / `converter-worker.js` 无需改动：选项经 `...options` 展开透传，无白名单（已现场核实）。

### 1.2 `minimal` 的确切保留集

| 保留 | 说明 |
| --- | --- |
| `.git/config` | remote URL 解析（`extensionGitMeta.remoteUrl`）+ `git pull` 需要 origin |
| `.git/HEAD` | 分支指针（`extensionGitMeta.branch`） |
| `.git/index` | 使首次 `pull` 后 `git status` 干净（实测：不留则残留 `D`/`??` 噪声） |
| `.git/refs/heads/**` | 当前分支引用（`extensionGitMeta.commit`），同时保证 `refs/` 目录存在 |
| `.git/objects/.keep` | **合成**条目，保证 `.git/objects` 目录在解压后存在 |

其余 `.git/**`（含 `objects/pack/*.pack`、`objects/xx/yyy…`、`logs/`、`hooks/`、`packed-refs`、`description`、`info/`）全部剔除。

**为何必须有 `.keep`**：git 的 `is_git_directory()` 要求 `.git/objects` 与 `.git/refs` 是真实目录；而本项目管线**丢弃空目录条目**（`zip-io.js:101/111`），故不能靠目录条目。用一个普通文件把目录「撑」住，是本方案能在自家管线里成立的关键。

**`.keep` 内容**：写入一段 ASCII 注释（非 0 字节）。实测 0 字节与有内容两种都被 git 判为正常（`fsck` rc=0），取非空是为了避免个别解压实现跳过 0 字节条目。

## 2. 分流落点（`src/core/transform.js`）

### 2.1 新增两个纯函数（可单测）

```js
export function isGitEntry(relPath)        // relPath === '.git' || startsWith('.git/')
export function isGitMinimalKept(relPath)  // .git/config | .git/HEAD | .git/index | .git/refs/heads/**
```

### 2.2 主循环顺序（关键：元数据解析在三种模式下都必须照常发生）

在 `routed.kind === 'extension-pkg'` 分支内，紧接 `extFolder` / `relPath` 计算之后：

```js
const gitEntry = isGitEntry(relPath);
const gitKeep = gitEntry
  && (gitMode === GIT_MODES.KEEP
      || (gitMode === GIT_MODES.MINIMAL && isGitMinimalKept(relPath)));
```

三个既有元数据处理器（`.git/config` → `:466`、`.git/HEAD` → `:486`、`.git/refs/heads/*` → `:506`）的写出条件由

```js
if (extensionMode !== EXTENSION_MODES.MANIFEST) { …写… } else { …dropped… }
```

改为三分支：

```js
if (extensionMode === EXTENSION_MODES.MANIFEST) { …原 dropped 文案不变… }
else if (!gitKeep)                              { report.dropped(hubPath, gitDropReason(gitMode), entry.uncompressedSize) }
else                                            { …原写出逻辑不变… }
```

**解析段（`entry.read()` + `extensionGitMeta.set`）在三模式下全部保留**——满足 AC「extensionGitMeta 三种模式下均正确」。

随后、在「3. 轻量清单模式跳过其他代码文件」之前，补一道兜底闸：

```js
if (gitEntry && !gitKeep) { entry.skip(); report.dropped(routed.hubPath, gitDropReason(gitMode), entry.uncompressedSize); continue; }
```

效果：`keep` 下非元数据 `.git` 条目继续走原第 4 步直通（零变化）；`strip` 下全剔；`minimal` 下只剔白名单外的。

`gitDropReason(mode)` 文案：
- `strip` → `gitMode=strip：剔除扩展 Git 历史（接收方需重新 git clone 才能在线更新）`
- `minimal` → `gitMode=minimal：仅保留 Git 识别与更新所需最小集，剔除对象存储`

### 2.3 合成 `.keep`

- `context.gitMinimalRoots: Set<string>`（新增，纳入 `createContext()` 的返回对象），元素是**hub 侧扩展根路径**（如 `extensions/third-party/foo`）。
- 注册时机：`gitMode === MINIMAL && extensionMode !== MANIFEST` 且遇到任一 `isGitEntry(relPath)` 时，加入 `routed.hubPath.slice(0, -relPath.length)`（即去掉 `.git/...` 后缀的扩展根）。**在最小模式下**「见过 `.git/`」就等于「这个扩展是 git 仓库」，比只认 `.git/config` 更稳。
- 写出位置：`emitSynthesized()`（`:710`）尾部，与既有合成条目同区：

```js
for (const root of [...context.gitMinimalRoots].sort()) {
  const target = `${targetEntryPath(root, target)}/.git/objects/.keep`;
  if (!dryRun) await writer.add(target, GIT_KEEP_PLACEHOLDER);
  report.synthesized(target);
}
```

- `MANIFEST` 模式天然为空集（不注册），故不会合成——满足 AC「MANIFEST 下 gitMode 不产生额外作用」。
- 用 `targetEntryPath` 而非手拼路径，保证 TT/PT 的 `data/extensions/third-party/**` 映射与 ST/L 的平铺映射都正确。

## 3. 统计上报（`src/core/report.js`）

`Report.dropped(hubPath, reason)` → `dropped(hubPath, reason, bytes = 0)`：

- 模块桶新增 `droppedBytes` 累计（`#module()` 初始化 + `dropped()` 累加）。
- `#dropped` 条目带上 `bytes`。
- 序列化输出（`toJSON` / summary 之类，实施时按其现有形状同步）补 `droppedBytes`。
- **向后兼容**：第三参可选，所有既有调用点零改动。

## 4. 预览（`src/core/plan-preview.js`）

- 新增 `gitMode` 选项（同默认值）。
- 动作链中，在既有 MANIFEST 分支**之后**、扩展 `MIGRATE` 分支（`:253`）**之前**插入：

```js
} else if (routed.kind === 'extension-pkg' && isGitEntry(relPath)
           && gitMode !== GIT_MODES.KEEP
           && !(gitMode === GIT_MODES.MINIMAL && isGitMinimalKept(relPath))) {
  action = ACTIONS.DROP;
  reason = gitDropReason(gitMode);
}
```

  放在 MIGRATE 之前，保证 `.git` 条目在 strip/minimal 下不出现「迁移」动作；`keep` 下该分支不生效，行为零变化。白色名单条目（config/HEAD/index/refs）在 minimal 下仍走原 MIGRATE/COPY。

- 目标路径推导用与 transform 相同的手法：记录见过 `.git/config` 的扩展根 hub 路径集合，合成项 `targetPath = targetEntryPath(root, target) + '/.git/objects/.keep'`，`estimatedSizeBytes` 取占位文件实际字节数。
- 体积差异由既有 `expectedOutputBytes` / `categories.extensions` 自动体现（DROP 的条目不计入 `expectedOutputFiles/Bytes`）。

## 5. UI（`src/ui/workbench-template.js` + `index.js`）

- 位置：I 区「扩展打包」抽屉内，`ext-mode-row`（`:174`）下方新增一组同类单选：
  `keep`（默认，标注「原样保留」）/ `minimal`（标注「迁移包推荐」）/ `strip`（标注「最小，失去在线更新」）。
- **复用既有 `.ext-mode-row` / `.ext-mode-opt` 类**——不新增 CSS，规避双前缀铁律风险（`style.css` 每条规则必须带 `.app-container` 或 `.st-converter-drawer-app`）。
- `index.js` 新增 `getGitMode()`（`input[name="git-mode"]:checked` → value，缺省 `keep`），接到全部 `extensionMode` 透传点（`:570/:948/:1029/:1349` 共 4 处）。
- **联动**：`extension-mode=manifest` 时这组单选 `disabled` + 一行说明「轻量清单模式下不打包 `.git`，本项不生效」。变更时调 `refreshPlan()`。
- 控件守卫：在 `scripts/control-consumer-guard.js` 的 `CONTROL_CONSUMERS` 登记 `'name:git-mode'`（该单选组无 id，走 `name:` 键）。

## 6. 取舍与已知局限（必须如实写入 README 与 UI 文案）

| 策略 | 体积 | `checkIsRepo` | `branch()` | `pull()` | 首次更新前 `git status` |
| --- | --- | --- | --- | --- | --- |
| `keep` | 100% | ✅ | ✅ | ✅ | ✅ |
| `minimal` | 仅剩元数据（packfile 全清） | ✅ | ✅ | ✅（自动补齐对象，更新后自愈为完整仓库） | ❌ `fatal: bad object HEAD`（该链路不调用它） |
| `strip` | 0 | ❌ 不认仓库 | — | — | — |

- `minimal` 的前提是**接收方能联网**（`pull` 要从 origin 重新取对象）；完全离线的接收方应选 `strip` 或 `keep`。这条必须写进 UI 说明与 README。
- 不做的：不解析/重写 packfile（纯 JS 无可行路径），不做 `git clone --depth 1` 引导（属接收侧行为），不引入 isomorphic-git 之类的库（L0-3 检索已确认无现成方案，且引入即违背零依赖）。
- R4（Node 侧实例批量瘦身）**Out of Scope**（用户 2026-09-25 裁决）。

## 7. 验证矩阵

| 层 | 手段 | 通过判据 |
| --- | --- | --- |
| 纯函数 | 单测 | `isGitEntry` / `isGitMinimalKept` 边界（`.gitkeep` 不算、`refs/heads/a/b` 算） |
| 转换 | 单测（合成 fixture 包） | keep 全留；strip 零 `.git`；minimal = 白名单 + `.keep`；三模式 `extensionGitMeta` 正确；非 `.git` 条目字节级一致 |
| 预览 | 单测 | 动作/体积差异、合成项出现、MANIFEST 下无合成 |
| 兼容 | 既有 358 项 | 全绿零回归 |
| 静态 | 四条守卫 + build | 退出码 0；`npm run build` 通过 |
| git 层 | 已完成的临时目录实测 | 见 `prd.md`「本轮取证」表 |
| 实例 | **Dev 往返实测**（已授权） | 产出包经宿主原生恢复接口写入 Dev → 界面「检查更新」取证成文 |

## 8. 回滚

- 纯增量改动，`gitMode` 默认 `KEEP`；回滚 = `git revert` 单个提交，无数据迁移、无状态残留。
- `Report.dropped` 第三参为可选扩参，回滚不影响既有调用点。
