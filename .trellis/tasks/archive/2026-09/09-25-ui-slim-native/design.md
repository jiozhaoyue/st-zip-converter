# 技术设计：UI 精简与原生化

## 1. 边界

**改动面**：`src/ui/workbench-template.js`、`src/ui/@{view,stash-list,export-queue,category-filter,log-console}.js` 的渲染部分、`index.js` 的绑定与状态求值、`style.css`、`index.html`、`scripts/`（新增一个守卫）。
**不动**：`src/core/**`（转换/打包/分卷/任务管理逻辑）、`src/storage/**`、`src/vendor/**`。
**不引入**：新依赖、UI 框架、外部 CDN。

## 2. 单一模板源（R8）

### 现状

| 入口 | 机制 | 结构来源 |
| --- | --- | --- |
| 独立 Web | `index.html` 静态 markup（441 行旧多抽屉） | **独立副本**（已分歧） |
| 插件抽屉 | `mountSettingsDrawer()` → `panel.innerHTML = getWorkbenchHtml({isDrawer:true})` | `workbench-template.js` |
| 模态 | `openConverterModal()` → `appContainer.innerHTML = getWorkbenchHtml({isModal:true})` | 同上 |

### 目标

```
index.html（骨架，约 20 行）
  └─ <div id="app" class="app-container"></div>   ← 空容器，无任何业务节点
        ↑ bootstrap() 检测到 #app 存在且为空时注入
     getWorkbenchHtml({ isStandalone: true })
```

- `getWorkbenchHtml(opts)` 扩展为三态：`{ isStandalone }` / `{ isDrawer }` / `{ isModal }`。
  三者共用同一份内部结构片段，仅在「页头/页脚是否渲染」「徽标位置」上分支（沿用既有 `isDrawer` 分支思路）。
- `bootstrap()`（`index.js:1487`）独立态分支改为：若 `#app` 无子节点 → `innerHTML = trustedStaticMarkup(getWorkbenchHtml({ isStandalone: true }))`，再 `main(app)`。
- **风险**：`index.html` 由 Vite 处理，`dist/` 产物为 GitHub Pages 站点。骨架化后构建仍正常（`index.js` 是 ESM 入口，`base=./` 不变）。
- **回归防线（R8.3）**：新增 `scripts/single-template-source.js` 守卫——扫描 `index.html`，若出现业务节点 id（白名单外）即退出码 1 并输出 `文件:行号`；同时断言 `workbench-template.js` 含全部关键 id。挂到 `npm run check:template-source`。

## 3. 信息架构与 DOM 骨架

渲染顺序按**操作流**（配置 → 执行 → 反馈），非用户表格的字母序：

```
<div class="st-converter-drawer-app">          ← 插件态容器（独立态为 .app-container）
 ├─ [A] .status-row           徽标 + 存储入口按钮
 ├─ [B] .zone-card            拖放区 + #stash-list + #stash-batch-bar
 ├─ [C] .zone-card            #export-queue-panel
 ├─ [G] .category-panel       类目选择（常驻）
 ├─ [F] .output-row           目标平台 / 压缩率 / 分包数值
 ├─ [H] .inline-drawer.wb-fold 垃圾清理（默认全启用 + 摘要）
 ├─ [I] .inline-drawer.wb-fold 扩展打包（两个紧凑选项）
 ├─ [J] .inline-drawer.wb-fold 增量与差量
 ├─ [K] .inline-drawer.wb-fold 包名
 ├─ [E] .action-row           三枚动作按钮
 ├─ [D] .progress-container   进度条 + #task-controls
 ├─ [D] #report-panel         8 格统计（空状态 hidden）+ 详情折叠
 └─     #log-console-mount    日志
```

## 4. 折叠机制（R1.1）

**复用，不新造**：

```html
<div class="inline-drawer wb-fold">
  <div class="inline-drawer-toggle inline-drawer-header">
    <b><i class="fa-solid fa-broom"></i> 垃圾清理</b>
    <span class="wb-fold-summary" id="fold-summary-cleanup">已启用 5 项</span>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content" style="display: none;">…</div>
</div>
```

- 开关行为：`setupDrawerToggles(panel)`（`host-bridge.js:1168`）已支持，`mountSettingsDrawer` 已调用，**零新增 JS**。
- 样式：`style.css:2020-2058` 已有作用域化的 `.inline-drawer*` 规则；只需补 `.wb-fold-summary`（继承 `--SmartThemeEmColor`），仍双前缀。
- 摘要更新：各区在状态变化时写 `#fold-summary-*` 的 `textContent`（纯状态读数，非说明文案，符合 R4.2）。

## 5. 按钮契约解耦（R7）

### 现状（散落点）

| 按钮 | 可见性写点 | 可用性写点 |
| --- | --- | --- |
| `#btn-convert` | 模板 `disabled` | `index.js` 多处 `btnConvert.disabled = …` |
| `#btn-host-fetch` | 模板 `style="display:none"` + `index.js` 分支 | `index.js:1075` 附近 `btnHostFetch.disabled` |
| `#btn-restore-luker` | 模板 `display:none` | `lastConvertedBlob` 判空散落 |

### 目标：单一求值函数

```js
/** 三枚动作按钮的可见性与可用性的唯一来源 */
function computeActionAvailability(s) {
  // s: { isHost, hasSource, hasArtifact, isTaskRunning, isRestoreInFlight, isHostTreeWaiting }
  return {
    fetch:   { visible: s.isHost,                                  enabled: !s.isTaskRunning },
    convert: { visible: true,                                      enabled: s.hasSource && !s.isTaskRunning },
    restore: { visible: s.isHost && s.hasArtifact,                 enabled: !s.isTaskRunning && !s.isRestoreInFlight },
  };
}

function applyActionAvailability() {   // 唯一写点
  const a = computeActionAvailability(collectActionState());
  apply('#btn-host-fetch', a.fetch);
  apply('#btn-convert', a.convert);
  apply('#btn-restore-luker', a.restore);
}
```

- 所有原先散落的 `disabled = …` / `style.display = …` 改为调用 `applyActionAvailability()`。
- **三枚可同时可见**（R7.1）：`visible` 条件彼此独立，不互斥。
- **按钮工厂复用**（R7.3）：抽出 `makeHostButton({ id, icon, label, title, onClick })`，供工作台按钮与 `mountNativeBackupButton` / `mountLukerBackupManagerButton` 共用（统一 `dataset.stZipInjected`、`preventDefault/stopPropagation`、`menu_button` 类）。

## 6. 分包数值输入（R3）

```html
<input type="number" id="split-input" min="1" step="1" inputmode="numeric" placeholder="不分卷">
```

- 取值：`parseSplitInput()` → `{ mode: 'none' } | { mode: 'size', mb: number }`。
- 校验：`Number.isInteger(n) && n >= MIN_SPLIT_MB(1)`；非法（浮点/负数/0/空）→ 视为不分卷，并对浮点做 `Math.floor` 归一后再判。
- 下游 `src/core/splitter.js` 只接受整数 MB，**不得把浮点传下去**。
- 单测：浮点 `1.5` → 归一为 1；`-5` / `0` → 不分卷；`200` → 200MB。

## 7. 暂存区（R5）

- 行内：`[复选框] 包名 … [载入] [⋯]`。
- `⋯` → `openRowMenu(anchor, file)`：
  - 优先 `callGenericPopup(html, POPUP_TYPE.TEXT)`（宿主可用时）；
  - 不可用 → 降级为锚点旁的绝对定位菜单（`document` 点击外部关闭）。
- 删除确认：`confirmDialog(message)` → 优先 `callGenericPopup(…, POPUP_TYPE.CONFIRM)`，降级 `window.confirm`。
- 批量条保留（多选后的统一动作），与行内不重复：行内**不再**出现 下载/写回/删除。

## 8. 文案清理清单（R4）

**删**（模板内实测存在）：

| 位置 | 内容 |
| --- | --- |
| 页头 | `<p>SillyTavern · Luker · TauriTavern · PureTavern 互转 · 细粒度导出 · 增量恢复</p>` |
| 拖放区 | `<p class="sub-text" id="drop-sub-text">拖入或上传的包自动入库到下方列表</p>`；主文案里的「（可多份）」 |
| 待导出区标题 | `<small class="zone-hint">产物统一出口：可拖文件出 / 选位置导出 / 多选批处理</small>` |
| 类目区标题 | 「(对齐 ST / Luker 原生规范)」 |
| 扩展模式卡 | `<p class="ext-mode-desc">…</p>` 两段 + 「(推荐)」 |
| 保留构建配置 | 标签括号「(webpack / vite / tsconfig 等)」 |
| 仅导出扩展清单 | 旁侧 `<small>只生成 JSON 清单…</small>` |
| 各处 `title=` | 教学性说明句（保留纯功能名，如「暂停任务」） |

**留**：错误/状态/进度文案、`placeholder`、图标悬停名、类目与折叠摘要读数、`confirm` 类对话框文案。

## 9. 兼容性与回滚

| 风险 | 缓解 |
| --- | --- |
| `index.html` 骨架化导致独立态失效 | 实机验证三入口（`npm run dev` + 8004 插件态 + 模态）渲染一致；守卫脚本防回归 |
| 折叠区 id 变更导致 `index.js` 绑定失联 | 保留既有 id（`#include-backups-check` 等）不动，只改**容器与位置**；`grep` 复核每个 id 两处均命中 |
| 宿主无 `callGenericPopup` | 全部走降级分支（`window.confirm` / 自绘菜单） |
| 宿主重渲染后折叠态丢失 | 折叠态是纯 DOM 状态，宿主重渲染后由 `watchHostDom` 重挂载面板 → 回到默认折叠态，可接受（R1 未要求记忆折叠态） |

**回滚点**：改动前提交 `059257e`（分支 `fix/perf-hardening-transfer-memory`）。UI 改动集中在模板 + 样式，回滚即 `git revert` 对应提交。

## 10. 与 T3 的接缝

配额入口按钮（A 区）的**外观**在本任务实现（一枚按钮 + 图标），**行为**（动态 `import()` 宿主 `storage-inspector.js` + 特性检测降级）归 T3。本任务先让按钮在不可用时整块隐藏，避免出现死按钮。
