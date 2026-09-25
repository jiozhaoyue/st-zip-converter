# Code Reuse Thinking Guide

> **Purpose**: Stop and think before creating new code - does it already exist?

---

## The Problem

**Duplicated code is the #1 source of inconsistency bugs.**

When you copy-paste or rewrite existing logic:
- Bug fixes don't propagate
- Behavior diverges over time
- Codebase becomes harder to understand

---

## Before Writing New Code

### Step 1: Search First

```bash
# Search for similar function names
grep -r "functionName" .

# Search for similar logic
grep -r "keyword" .
```

### Step 2: Ask These Questions

| Question | If Yes... |
|----------|-----------|
| Does a similar function exist? | Use or extend it |
| Is this pattern used elsewhere? | Follow the existing pattern |
| Could this be a shared utility? | Create it in the right place |
| Am I copying code from another file? | **STOP** - extract to shared |

---

## Common Duplication Patterns

### Pattern 1: Copy-Paste Functions

**Bad**: Copying a validation function to another file

**Good**: Extract to shared utilities, import where needed

### Pattern 2: Similar Components

**Bad**: Creating a new component that's 80% similar to existing

**Good**: Extend existing component with props/variants

### Pattern 3: Repeated Constants

**Bad**: Defining the same constant in multiple files

**Good**: Single source of truth, import everywhere

### Pattern 4: Repeated Payload Field Extraction

**Bad**: Multiple consumers cast the same JSON/event fields locally:

```typescript
const description = (ev as { description?: string }).description;
const context = (ev as { context?: ContextEntry[] }).context;
```

This is duplicated contract logic even when the code is only two lines. Each
consumer now has its own definition of what a valid payload means.

**Good**: Put the decoder, type guard, or projection next to the data owner:

```typescript
if (isThreadEvent(ev)) {
  renderThreadEvent(ev);
}
```

**Rule**: If the same untyped payload field is read in 2+ places, create a
shared type guard / normalizer / projection before adding a third reader.

---

## When to Abstract

**Abstract when**:
- Same code appears 3+ times
- Logic is complex enough to have bugs
- Multiple people might need this

**Don't abstract when**:
- Only used once
- Trivial one-liner
- Abstraction would be more complex than duplication

---

## After Batch Modifications

When you've made similar changes to multiple files:

1. **Review**: Did you catch all instances?
2. **Search**: Run grep to find any missed
3. **Consider**: Should this be abstracted?

### Reducers Should Use Exhaustive Structure

When state is derived from action-like values (`action`, `kind`, `status`,
`phase`), prefer a reducer with one `switch` over scattered `if/else` updates.

```typescript
// BAD - action-specific state transitions are hard to audit
if (action === "opened") { ... }
else if (action === "comment") { ... }
else if (action === "status") { ... }

// GOOD - one reducer owns the transition table
switch (event.action) {
  case "opened":
    ...
    return;
  case "comment":
    ...
    return;
}
```

This matters when the event log is the source of truth. A reducer is the
documented replay model; display code and commands should not duplicate pieces
of that replay model.

---

## Checklist Before Commit

- [ ] Searched for existing similar code
- [ ] No copy-pasted logic that should be shared
- [ ] No repeated untyped payload field extraction outside a shared decoder
- [ ] Constants defined in one place
- [ ] Similar patterns follow same structure
- [ ] Reducer/action transitions live in one reducer or command dispatcher

---

## Gotcha: Python if/elif/else Exhaustive Check

**Problem**: Python's if/elif/else chains have no compile-time exhaustive check. When you add a new value to a `Literal` type (e.g., `Platform`), existing if/elif/else chains silently fall through to `else` with wrong defaults.

**Symptom**: New platform works partially — some methods return Claude defaults instead of platform-specific values. No error is raised.

**Example** (`cli_adapter.py`):
```python
# BAD: "gemini" falls through to else, returns "claude"
@property
def cli_name(self) -> str:
    if self.platform == "opencode":
        return "opencode"
    else:
        return "claude"  # gemini silently gets "claude"!

# GOOD: explicit branch for every platform
@property
def cli_name(self) -> str:
    if self.platform == "opencode":
        return "opencode"
    elif self.platform == "gemini":
        return "gemini"
    else:
        return "claude"
```

**Prevention**: When adding a new value to a Python `Literal` type, search for ALL if/elif/else chains that switch on that type and add explicit branches. Don't rely on `else` being correct for new values.

---

## Gotcha: Asymmetric Mechanisms Producing Same Output

**Problem**: When two different mechanisms must produce the same file set (e.g., recursive directory copy for init vs. manual `files.set()` for update), structural changes (renaming, moving, adding subdirectories) only propagate through the automatic mechanism. The manual one silently drifts.

**Symptom**: Init works perfectly, but update creates files at wrong paths or misses files entirely.

**Prevention**:
- **Best**: Eliminate the asymmetry — have the manual path call the automatic one (e.g., `collectTemplateFiles()` calls `getAllScripts()` instead of maintaining its own list)
- **If asymmetry is unavoidable**: Add a regression test that compares outputs from both mechanisms
- When migrating directory structures, search for ALL code paths that reference the old structure

**Real example**: `trellis update` had a manual `files.set()` list for 11 scripts that `getAllScripts()` already tracked. Fix: replaced the manual list with a `for..of getAllScripts()` loop. See `update.ts` refactor in v0.4.0-beta.3.

---

## Template File Registration (Trellis-specific)

When adding new files to `src/templates/trellis/scripts/`:

**Single registration point**: `src/templates/trellis/index.ts`

1. Add `export const xxxScript = readTemplate("scripts/path/file.py");`
2. Add to `getAllScripts()` Map

That's it. `commands/update.ts` uses `getAllScripts()` directly — no manual sync needed.

**Why this matters**: Without registration in `getAllScripts()`, `trellis update` won't sync the file to user projects. Bug fixes and features won't propagate.

**History**: Before v0.4.0-beta.3, `update.ts` had its own hand-maintained file list that frequently fell out of sync with `getAllScripts()`. This caused 11 Python files to be silently skipped during `trellis update`. The fix was to eliminate the duplicate list and use `getAllScripts()` as the single source of truth.

### Quick Checklist for New Scripts

```bash
# After adding a new .py file, verify it's in getAllScripts():
grep -l "newFileName" src/templates/trellis/index.ts  # Should match
```

### Template Sync Convention

`.trellis/scripts/` (dogfooded) and `packages/cli/src/templates/trellis/scripts/` (template) must stay identical. After editing `.trellis/scripts/`, always sync:

```bash
rsync -av --delete --exclude='__pycache__' .trellis/scripts/ packages/cli/src/templates/trellis/scripts/
```

**Gotcha**: Running rsync with wrong source/destination paths can create nested garbage directories (e.g., `.trellis/scripts/packages/cli/...`). Always double-check paths before running.

---

## 本仓复用契约（ST-zip-converter）

下面是本项目已收敛出的「单一来源」清单——新增代码前先对照，**不要另起一份实现**。
`src/ui/escape.js` 的模块注释即引用本文件作为「全仓只此一处实现」的依据，故本节随代码变动同步维护。

| 关注点 | 唯一来源 | 自查方法 |
| --- | --- | --- |
| HTML 转义 / URL 校验 | `src/ui/escape.js`（`escapeHtml` 覆盖 `& < > " '`、`isSafeHttpUrl`、`trustedStaticMarkup`） | `grep -rn "trustedStaticMarkup(" src/ index.js` 列出全部豁免点；`log-console.js` 曾自带只转 `& < >` 的私有实现（缺引号转义）→ 已统一 |
| zip **读** | `src/core/zip-io.js` 的 `zipIo.openReader()`（封装 `src/vendor/zip.js` + `src/vendor/fzstd.js`） | `new zip.ZipReader` / `new zip.BlobReader` 只应出现在 `src/core/zip-io.js` |
| zip **写** | `zipIo.createWriter(target, { level })`（`ZipWriter` 只在它内部构造） | 调用方可自建 `zip.BlobWriter` 仅作**内存目的地**（`delta.js` / `splitter.js` / `worker-client.js` / `converter-worker.js` / `host-bridge.js` 均如此），随后仍须交给 `zipIo.createWriter` |
| 目标布局枚举 | `src/core/transform.js` 的 `TARGETS` | UI 里不应硬编码 `'st' \| 'l' \| 'tt' \| 'pt'` 字面量 |
| 宿主平台码 → 布局码 | `src/ui/host-bridge.js` 的 `hostLayoutCode()`（`luker → l`） | 宿主导出直出路径传参处必须见到它 |
| 宿主环境嗅探 | `src/ui/host-bridge.js`（`detectHost` / `verifyHostPlatform` / 各端点封装） | `lukerContext` / `SillyTavern` 全局对象与 `/version` 的判定只应在桥接层；`src/core/` 只按**布局码**分支（`transform.js` 里的 `_compat/luker/` 是**产物路径名**，不是宿主嗅探） |
| 备份类目判定 | `src/core/inspect.js`（`categoryOfHubPath` / `categoryOfEntry` / `isBackupChatOrSnapshot`） | 不要在多处重写类目字符串表 |
| 备份内清单合成 | `src/core/transform.js` 的 `emitSynthesized` | 合成条目只允许出现在尾部合成块，且用固定时间戳 `FIXED_TIMESTAMP` |
| 产物出口 | `src/ui/export-queue.js` 的 `ExportQueue` | 产物**生成**路径（转换 / 宿主拉取 / 增量 / 分卷）不得自动下载；下载动作只能由用户在待导出区或工作区列表显式触发 |
| 宿主 UI 注入 | `src/ui/host-bridge.js` 的 `watchHostDom`（MutationObserver，200ms 去抖）+ `dataset.stZipInjected` | 不得各模块自开 `setInterval` 轮询 |
| 宿主注入按钮构造 | `src/ui/host-bridge.js` 的 `makeHostButton({ id, icon, label, title, onClick })` | `menu_button menu_button_icon` 形态的按钮一律经此工厂；不得就地手搓 DOM（`registerMenuButton` 的菜单项与工作台模板按钮形态不同，有意不纳入） |
| 确认对话框 | `src/ui/host-bridge.js` 的 `confirmDialog()`（官方文档路径 `getContext().Popup.show.confirm`，不可用时降级） | 组件层不得裸用 `confirm()`／直接调宿主；经 `confirmFn` 参数注入，缺省时组件自行降级 |
| HTML 工作台模板 | `src/ui/workbench-template.js` 的 `getWorkbenchHtml()` | **唯一来源**（`index.html` 自 2026-09-25 起仅为空骨架）；结构改动只改这一处，并同步 `REQUIRED_TEMPLATE_IDS` |

命令与阈值同样只许有一处定义：`package.json` 的 `scripts`（`test` / `build` / `check:css-scope` /
`check:dom-injection` / `check:template-source` / `gen-fixtures`）与其对应的 `scripts/*.js` 守卫脚本。

> `src/vendor/` 是**第三方本地副本**：只调用其现有 API，**不得**升级或就地改造
> （用户通过酒馆「扩展管理器 Git URL 一键克隆」安装，不能要求跑 `npm install` / `npm run build`）。
