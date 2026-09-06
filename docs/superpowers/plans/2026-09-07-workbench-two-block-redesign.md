# 工作台两块式重构 + 宿主导出修复 + 主题配色 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复宿主导出 `convert: target 必须是 st|l|tt|pt 之一` 报错，把工作台重构为两块式（状态+数据包区 / 统一选项+执行区），配色完全继承酒馆主题并根除写死色值。

**Architecture:** 三个独立提交。①纯函数 `hostLayoutCode` 归一宿主平台→转换器布局代码；②重写 `workbench-template.js` 骨架为两块式，新增 `stash-list.js` 源包列表，改造 `export-queue.js`（多选+拖出+选位置导出）、`usage-dashboard.js`（两行配额条），`index.js` 控制器适配；③删除 CSS 变量硬编码覆盖、金色系自造变量改指主题变量、内联色值收敛为 CSS 类。

**Tech Stack:** 原生 ES Module + Vite 7 + Vitest 3；浏览器 API：`navigator.storage.estimate`、`showSaveFilePicker`（FS Access，特性检测回退）、HTML5 `DownloadURL` drag-out（Chromium，特性检测回退）。

**规格:** `docs/superpowers/specs/2026-09-07-workbench-two-block-redesign.md`

**验证命令:**
- 全量测试：`cd /d/Repo/Tavern-repo/My-repo/ST-zip-converter && npm test`（预期 137+ 全绿）
- 构建检查：`npm run build`（预期无报错）
- 手动：`npm run dev` 后浏览器打开独立页面

---

## Task 1: hostLayoutCode 纯函数（TDD）

**Files:**
- Modify: `src/ui/host-bridge.js`（文件头部 FULL_SELECTION 之前插入）
- Test: `test/detect-host.test.js`（文件末尾追加 describe 块）

- [ ] **Step 1.1: 写失败测试**

在 `test/detect-host.test.js` 的 import 行加入 `hostLayoutCode`：

```js
import { detectHost, verifyHostPlatform, hostLayoutCode } from '../src/ui/host-bridge.js';
```

文件末尾追加：

```js
describe('hostLayoutCode 宿主平台→转换器布局代码映射', () => {
  it('luker → l (Luker 清单布局代码)', () => {
    expect(hostLayoutCode('luker')).toBe('l');
  });

  it('st → st (ST 摊平布局代码，同名直通)', () => {
    expect(hostLayoutCode('st')).toBe('st');
  });

  it('standalone 原样透传 (调用方负责兜底)', () => {
    expect(hostLayoutCode('standalone')).toBe('standalone');
  });

  it('未知值原样透传 (不抛错，纯映射)', () => {
    expect(hostLayoutCode('tt')).toBe('tt');
    expect(hostLayoutCode('pt')).toBe('pt');
    expect(hostLayoutCode('')).toBe('');
  });
});
```

- [ ] **Step 1.2: 运行测试确认失败**

Run: `cd /d/Repo/Tavern-repo/My-repo/ST-zip-converter && npx vitest run test/detect-host.test.js`
Expected: FAIL —— `hostLayoutCode` 未导出（`SyntaxError: The requested module ... does not provide an export named 'hostLayoutCode'`）

- [ ] **Step 1.3: 最小实现**

在 `src/ui/host-bridge.js` 中，`export const FULL_SELECTION = ...` 之前插入：

```js
/**
 * 宿主平台代码 → 转换器布局代码映射。
 * convert() 只接受 st|l|tt|pt (src/core/transform.js TARGETS)，
 * 而 detectHost() 返回 st|luker|standalone —— 'luker' 必须映射为 'l'，
 * 否则宿主导出直出路径把 'luker' 传给 convert() 会抛
 * "convert: target 必须是 st|l|tt|pt 之一"。
 * @param {'st'|'luker'|'standalone'|string} platform detectHost() 平台代码
 * @returns {string} 转换器布局代码 (st|l) 或原样透传
 */
export function hostLayoutCode(platform) {
  if (platform === 'luker') return 'l';
  return platform;
}
```

- [ ] **Step 1.4: 运行测试确认通过**

Run: `npx vitest run test/detect-host.test.js`
Expected: PASS（原有用例 + 新增 4 项全绿）

- [ ] **Step 1.5: 提交**

```bash
cd /d/Repo/Tavern-repo/My-repo/ST-zip-converter
git add src/ui/host-bridge.js test/detect-host.test.js
git commit -m "fix(core): add hostLayoutCode mapping luker->l for converter target"
```

---

## Task 2: 宿主导出与文件名预览接入映射（修复报错）

**Files:**
- Modify: `index.js:646-839`（handleHostExport）、`index.js:88-120`（updateFilenamePreview）、`index.js:476-478`（applyPluginUi 的 targetSelect 预设）、`index.js:47`（import）

- [ ] **Step 2.1: index.js 导入 hostLayoutCode**

`index.js` 第 37-47 行的 host-bridge import 块中加入 `hostLayoutCode`：

```js
import {
  detectHost,
  verifyHostPlatform,
  fetchHostBackup,
  restoreToHost,
  getHandle,
  registerMenuButton,
  mountSettingsDrawer,
  setupDrawerToggles,
  hostLayoutCode,
  FULL_SELECTION,
} from './src/ui/host-bridge.js';
```

- [ ] **Step 2.2: updateFilenamePreview 归一**

`index.js` updateFilenamePreview 内（约 :110）：

```js
// 原:
const effectiveTarget = selectedTarget === 'native' ? (host.platform || 'st') : selectedTarget;
// 改为:
const effectiveTarget = selectedTarget === 'native'
  ? hostLayoutCode(host.platform || 'st')
  : selectedTarget;
```

- [ ] **Step 2.3: handleHostExport 双处归一**

`index.js` handleHostExport 内（约 :703 与 :733）：

```js
// 原 (:703):
const effectiveTarget = selectedTarget === 'native' ? host.platform : selectedTarget;
// 改为:
const effectiveTarget = selectedTarget === 'native'
  ? hostLayoutCode(host.platform)
  : selectedTarget;
```

```js
// 原 (:733):
targetLayout = selectedTarget === 'native' ? host.platform : selectedTarget;
// 改为:
targetLayout = selectedTarget === 'native'
  ? hostLayoutCode(host.platform)
  : selectedTarget;
```

- [ ] **Step 2.4: applyPluginUi 目标预设归一**

`index.js` applyPluginUi 内（约 :476-478）：

```js
// 原:
if (targetSelect) {
  targetSelect.value = platform === 'luker' ? 'l' : 'st';
}
// 改为 (预设为跨平台目标选择器当前值，native 直出时由 hostLayoutCode 兜底):
if (targetSelect) {
  targetSelect.value = hostLayoutCode(platform);
}
```

> 说明：`target-select` 无 `value="l"` 之外的 luker 项，`hostLayoutCode('luker')==='l'` 与原行为一致；`'st'` 不变。

- [ ] **Step 2.5: 全量测试 + 回归审计**

Run: `npm test`
Expected: 全绿（Task 1 新增用例在内）。

审计确认：`grep -n "host.platform" index.js` 逐处核对——宿主导出三处已归一（670/703/733 附近）、`fetchHostBackup(host.platform, ...)` 与 `restoreToHost(..., { platform: host.platform })` 传的是宿主端点平台代码（非转换器 target，**不需要**归一）、`applyHostBadge`/`applyPluginUi` 是 UI 文案（不需要）。

- [ ] **Step 2.6: 提交**

```bash
cd /d/Repo/Tavern-repo/My-repo/ST-zip-converter
git add index.js
git commit -m "fix(ui): normalize host export target via hostLayoutCode - fixes convert target error"
```

---

## Task 3: workbench-template.js 两块式骨架重写

**Files:**
- Modify: `src/ui/workbench-template.js`（全文重写 `getWorkbenchHtml` 返回值；文件职责不变）

- [ ] **Step 3.1: 重写模板**

新结构（保留现有 class 命名体系，删除抽屉外壳）。完整返回值：

```js
/**
 * 酒馆数据包互转工坊 - HTML 模板生成器（两块式）
 * 块一：状态头 + 数据包区（上传暂存 / 待导出）
 * 块二：进度条(sticky) + 报告 + 统一选项 + 执行按钮 + 日志挂载点
 */
export function getWorkbenchHtml({ isModal = false, isDrawer = false } = {}) {
  return `
    ${!isDrawer ? `
    <header class="app-header">
      <div class="title-group">
        <h1><i class="fa-solid fa-file-zipper"></i> 酒馆数据包互转工坊 <span class="header-version">v1.0.0</span></h1>
        <p>SillyTavern · Luker · TauriTavern · PureTavern 互转 · 细粒度导出 · 增量恢复</p>
      </div>
      <div class="header-badges">
        <div class="badge" id="env-badge">检测中...</div>
        <div class="badge badge-user" id="host-user-badge" style="display: none;">用户: 未登录</div>
        ${isModal ? '<button type="button" class="st-converter-modal-close-btn" id="btn-close-converter-modal" title="关闭工作台">&times;</button>' : ''}
      </div>
    </header>
    ` : `
    <!-- 抽屉模式：状态徽标并入块一状态行 -->
    <div class="status-row" id="status-row">
      <span class="badge" id="env-badge">检测中...</span>
      <span class="badge badge-user" id="host-user-badge" style="display: none;">用户: 未登录</span>
      <span class="host-tag-platform" id="host-tag-platform" style="display: none;">宿主环境: 检测中</span>
    </div>
    `}

    <!-- ═══ 块一：状态头 + 数据包区 ═══ -->
    <div class="wb-block wb-block-status">
      ${!isDrawer ? `
      <div class="status-row" id="status-row">
        <span class="host-tag-platform" id="host-tag-platform" style="display: none;">宿主环境: 检测中</span>
      </div>
      ` : ''}
      <div class="quota-bars" id="usage-dashboard"><!-- 两行配额条 (usage-dashboard.js) --></div>

      <div class="zone-card">
        <div class="zone-title"><i class="fa-solid fa-inbox"></i> 上传暂存区</div>
        <div class="dropzone dropzone-inline" id="dropzone">
          <input type="file" id="file-input" accept=".zip" multiple style="display: none;">
          <p class="main-text" id="drop-main-text"><i class="fa-solid fa-cloud-arrow-up"></i> 将酒馆 Zip 数据包拖到此处，或点击选择（可多份）</p>
          <p class="sub-text" id="drop-sub-text">拖入或上传的包自动入库到下方列表</p>
        </div>
        <div id="stash-list"><!-- 源包列表 (stash-list.js) --></div>
        <div id="stash-batch-bar" hidden></div>
      </div>

      <div class="zone-card">
        <div class="zone-title"><i class="fa-solid fa-file-export"></i> 待导出区 <small class="zone-hint">产物统一出口：可拖文件出 / 选位置导出 / 多选批处理</small></div>
        <div id="export-queue-panel"></div>
      </div>
    </div>

    <!-- ═══ 块二：进度 + 统一选项 + 执行 ═══ -->
    <div class="wb-block wb-block-controls">
      <div class="progress-container" id="progress-container">
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" id="progress-bar-fill"></div>
        </div>
        <div class="progress-text">
          <span id="status-label">准备就绪</span>
          <span id="progress-percent">0%</span>
        </div>
      </div>

      <div class="report-panel" id="report-panel">
        <div class="module-grid" id="module-grid">
          <div class="module-item"><span class="count" id="count-chars">0</span><span class="label">角色卡</span></div>
          <div class="module-item"><span class="count" id="count-chats">0</span><span class="label">聊天记录</span></div>
          <div class="module-item"><span class="count" id="count-lorebooks">0</span><span class="label">世界书</span></div>
          <div class="module-item"><span class="count" id="count-presets">0</span><span class="label">预设配置</span></div>
          <div class="module-item"><span class="count" id="count-assets">0</span><span class="label">资产与头像</span></div>
          <div class="module-item"><span class="count" id="count-extensions">0</span><span class="label">扩展</span></div>
          <div class="module-item"><span class="count" id="count-settings">0</span><span class="label">系统设置</span></div>
          <div class="module-item"><span class="count" id="count-secrets">0</span><span class="label">密钥(已保护)</span></div>
        </div>

        <details class="log-accordion" id="discards-accordion" style="display: none;">
          <summary id="discards-summary">丢弃项清单 (0 条)</summary>
          <pre id="discards-log"></pre>
        </details>

        <details class="log-accordion" id="filtered-accordion" style="display: none;">
          <summary id="filtered-summary">脱敏与排除清单 (0 条)</summary>
          <pre id="filtered-log"></pre>
        </details>

        <details class="log-accordion" id="warnings-accordion" style="display: none;">
          <summary id="warnings-summary">警告与适配提示 (0 条)</summary>
          <pre id="warnings-log"></pre>
        </details>
      </div>

      <div class="category-panel" id="category-panel" style="display: none;">
        <div class="flex-container justifySpaceBetween alignItemsCenter" style="margin-bottom: 6px;">
          <span class="category-title" style="font-weight: bold; font-size: 0.85rem;"><i class="fa-solid fa-list-check"></i> 类目选择 (对齐 ST / Luker 原生规范)</span>
          <span class="category-sub-summary" id="category-summary-badge" style="font-size: 0.75rem;"></span>
        </div>
        <div class="flex-container" style="gap: 4px; flex-wrap: wrap; margin-bottom: 8px;">
          <button type="button" class="menu_button btn-tool" id="btn-select-all" title="勾选所有有效类目">全选</button>
          <button type="button" class="menu_button btn-tool" id="btn-deselect-all" title="取消所有勾选">全不选</button>
          <button type="button" class="menu_button btn-tool" id="btn-invert-select" title="反转当前可用类目的勾选">反选</button>
          <button type="button" class="menu_button btn-tool btn-quick" data-preset="chars" title="仅勾选角色卡与素材">仅角色卡</button>
          <button type="button" class="menu_button btn-tool btn-quick" data-preset="chats" title="仅勾选聊天记录">仅聊天记录</button>
          <button type="button" class="menu_button btn-tool btn-quick" data-preset="safe" title="脱敏导出：排除密钥与聊天记录">安全脱敏</button>
        </div>
        <div class="link-option-row" style="margin-bottom: 8px;">
          <label class="checkbox_label flex-container" title="开启后，选择角色或聊天时自动联动对方，确保头像与对话上下文完整">
            <input type="checkbox" id="link-char-chats-check" checked>
            <span>角色与聊天智能联动</span>
          </label>
        </div>
        <div class="plan-summary-bar" id="plan-summary-bar" style="display: none; margin-bottom: 8px;">
          <div class="action-badges" id="action-stats-badges"></div>
          <div class="output-estimate" id="output-estimate-text"></div>
        </div>
        <div class="category-grid" id="category-checkboxes"></div>
      </div>

      <div class="unified-options">
        <div class="flex-container flexFlowColumn" style="gap: 8px; margin-bottom: 10px;">
          <div class="flex-container alignItemsCenter" style="gap: 8px;">
            <small style="white-space: nowrap;">目标平台:</small>
            <select id="target-select" class="text_pole flex1">
              <option value="st">SillyTavern (ST 摊平)</option>
              <option value="l">Luker (带清单)</option>
              <option value="tt">TauriTavern (TT 布局)</option>
              <option value="pt" selected>PureTavern (PT 兼容)</option>
            </select>
          </div>
          <div class="flex-container alignItemsCenter" style="gap: 8px;">
            <small style="white-space: nowrap;">Zip 压缩率:</small>
            <select id="compression-select" class="text_pole flex1">
              <option value="5" selected>标准均衡 (Deflate 5)</option>
              <option value="0">极速存储 (Store 0 / 秒级导出)</option>
              <option value="1">快速轻度 (Deflate 1)</option>
              <option value="9">极限压缩 (Deflate 9 / 最小体积)</option>
            </select>
          </div>
          <div class="flex-container alignItemsCenter" style="gap: 8px;">
            <small style="white-space: nowrap;">智能分包:</small>
            <select id="split-select" class="text_pole flex1">
              <option value="none" selected>不分卷 (单包导出)</option>
              <option value="100">100 MB</option>
              <option value="50">50 MB</option>
              <option value="200">200 MB</option>
            </select>
          </div>
          <div class="flex-container flexFlowColumn" style="gap: 4px;">
            <div class="flex-container justifySpaceBetween alignItemsCenter">
              <small>自定义包名:</small>
              <div class="placeholder-chips" id="placeholder-chips">
                <button type="button" class="btn-chip" data-insert="{part}" title="插入分卷序号 (如 part1, part2)">+ {part}</button>
                <button type="button" class="btn-chip" data-insert="{user}" title="插入用户名">+ {user}</button>
                <button type="button" class="btn-chip" data-insert="{date}" title="插入年月日">+ {date}</button>
                <button type="button" class="btn-chip" data-insert="{category}" title="插入类目标识">+ {category}</button>
                <button type="button" class="btn-chip" data-insert="{mode}" title="插入打包模式">+ {mode}</button>
                <button type="button" class="btn-chip" data-insert="{target}" title="插入目标平台代码">+ {target}</button>
              </div>
            </div>
            <input type="text" id="filename-template-input" class="text_pole" placeholder="{target}_{user}_{part}_{date}.zip" value="{target}_{user}_{part}_{date}.zip">
            <div style="display: flex; gap: 8px; align-items: center; margin-top: 3px; font-size: 0.76rem; opacity: 0.85;">
              <span>预设模板:</span>
              <button type="button" class="btn-tpl-preset" data-tpl="{target}_{user}_{part}_{date}.zip">分卷标准</button> |
              <button type="button" class="btn-tpl-preset" data-tpl="{target}_core_{user}_{date}.zip">核心备份</button> |
              <button type="button" class="btn-tpl-preset" data-tpl="{target}_full_{user}_{date}.zip">全量备份</button>
            </div>
            <div class="filename-preview-box" id="filename-preview-box" style="margin-top: 5px; font-size: 0.78rem;">
              <span class="preview-label"><i class="fa-solid fa-tag"></i> 实时生成预览:</span>
              <code class="preview-code" id="filename-preview">pt_default-user_part1.zip</code>
            </div>
          </div>

          <div class="extension-mode-section" style="width: 100%; margin: 8px 0 0 0;">
            <small style="font-weight: bold; margin-bottom: 6px; display: flex; align-items: center; gap: 6px;">
              <i class="fa-solid fa-puzzle-piece"></i> 扩展打包模式:
            </small>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px;">
              <label class="ext-mode-card">
                <input type="radio" name="extension-mode" value="manifest" checked>
                <div>
                  <strong class="ext-mode-title"><i class="fa-solid fa-bolt"></i> 轻量清单模式 (推荐)</strong>
                  <p class="ext-mode-desc">体积缩减 99%，杜绝 408 超时。仅存清单，导入时 depth:1 浅克隆。</p>
                </div>
              </label>
              <label class="ext-mode-card">
                <input type="radio" name="extension-mode" value="full">
                <div>
                  <strong class="ext-mode-title"><i class="fa-solid fa-box-archive"></i> 完整离线包</strong>
                  <p class="ext-mode-desc">打包扩展实体与浅层 Git 结构，已过滤构建冗余，适合无网络离线环境。</p>
                </div>
              </label>
            </div>
            <div style="margin-top: 6px;">
              <label class="checkbox_label flex-container" title="保留构建配置文件（如 webpack.config.js, vite.config.js, tsconfig.json 等）">
                <input type="checkbox" id="keep-dev-files-check">
                <span>保留构建配置 (webpack / vite / tsconfig 等)</span>
              </label>
            </div>
          </div>

          <div class="flex-container flexFlowColumn" style="gap: 6px; margin-top: 8px;">
            <label class="checkbox_label flex-container" title="包含 backups/ 历史快照目录与各角色聊天中的备份文件 (默认不包含)">
              <input type="checkbox" id="include-backups-check">
              <i class="fa-solid fa-clock-rotate-left"></i>
              <span>备份聊天记录与快照 (backups/)</span>
            </label>
            <label class="checkbox_label flex-container" title="包含缩略图与派生缓存 (thumbnails/, _cache/)">
              <input type="checkbox" id="include-cache-check">
              <span>派生缓存</span>
            </label>
            <label class="checkbox_label flex-container" title="包含应用私有设置与引擎状态">
              <input type="checkbox" id="include-private-check">
              <span>私有配置</span>
            </label>
            <label class="checkbox_label flex-container" title="增量合并模式：当包内存在相同文件时仅更新较新文件">
              <input type="checkbox" id="incremental-mode-check">
              <span>增量合并模式</span>
            </label>
            <label class="checkbox_label flex-container" title="差量补丁模式：与外部基准 ZIP 比对，仅导出新增或修改的文件 (宿主拉取与外部转换均生效)">
              <input type="checkbox" id="host-incremental-export">
              <i class="fa-solid fa-code-compare"></i>
              <span>差量补丁模式 (基于基准 ZIP)</span>
            </label>
            <div id="host-base-zip-section" class="base-zip-section" style="display: none;">
              <div class="base-zip-title"><i class="fa-solid fa-file-zipper"></i> 指定基准 ZIP 数据包 (Base Archive)</div>
              <div class="flex-container" style="gap: 6px; flex-wrap: wrap; margin-bottom: 6px;">
                <input type="file" id="host-base-zip-input" accept=".zip" style="display: none;">
                <button type="button" class="menu_button" id="btn-select-base-zip" style="font-size: 0.8rem; padding: 4px 10px;">
                  <i class="fa-solid fa-folder-open"></i> 选择本地基准 ZIP
                </button>
                <select id="host-base-archive-select" class="text_pole" style="font-size: 0.8rem; padding: 3px 8px; max-width: 220px;">
                  <option value="">或从上传暂存区选取...</option>
                </select>
              </div>
              <div id="host-base-zip-status" class="base-zip-status">
                <i class="fa-solid fa-triangle-exclamation"></i> 请先选择基准包，否则无法生成差量补丁
              </div>
            </div>
            <label class="checkbox_label flex-container" title="自动识别并剔除酒馆系统自带的默认背景图、默认主题等静态资源，仅保留个人资产">
              <input type="checkbox" id="prune-builtin-check" checked>
              <span>剔除酒馆原生重复资产</span>
            </label>
          </div>
        </div>

        <div class="action-row">
          <button type="button" class="menu_button menu_button_icon flex1 btn-accent" id="btn-convert" disabled>
            <i class="fa-solid fa-play"></i> <span>开始转换</span>
          </button>
          <button type="button" class="menu_button menu_button_icon flex1 btn-accent" id="btn-host-fetch" style="display: none;">
            <i class="fa-solid fa-server"></i> <span>从宿主拉取</span>
          </button>
          <button type="button" class="menu_button menu_button_icon" id="btn-restore-luker" style="display: none;" disabled>
            <i class="fa-solid fa-file-import"></i> <span>恢复到当前用户</span>
          </button>
        </div>
      </div>

      <!-- 日志控制台挂载点 (setupLogConsole appendChild 到 root，此处仅为占位说明；日志渲染后位于块二底部) -->
      <div id="log-console-mount"></div>
    </div>

    <div class="restore-modal-overlay" id="restore-modal-overlay" style="display: none;">
      <div class="restore-modal-card">
        <h3 class="modal-title">
          <i class="fa-solid fa-triangle-exclamation"></i> 确认写入/恢复至当前宿主酒馆
        </h3>
        <p class="modal-desc" id="restore-modal-desc">即将把数据包恢复到当前宿主酒馆当前登录用户，请选择恢复模式：</p>
        <div class="restore-mode-group">
          <label class="checkbox_label flex-container">
            <input type="radio" name="restore-mode" value="merge" checked>
            <div class="radio-text">
              <strong>增量合并 (推荐)</strong>
              <span>保留酒馆已有数据，仅新增缺失数据或覆盖同名冲突文件</span>
            </div>
          </label>
          <label class="checkbox_label flex-container">
            <input type="radio" name="restore-mode" value="overwrite">
            <div class="radio-text">
              <strong>全量覆盖</strong>
              <span>重置当前用户数据，完全替换为该数据包内容</span>
            </div>
          </label>
        </div>
        <div class="flex-container" style="justify-content: flex-end; gap: 8px;">
          <button type="button" class="menu_button" id="btn-cancel-restore">取消</button>
          <button type="button" class="menu_button menu_button_icon btn-accent" id="btn-confirm-restore">
            <i class="fa-solid fa-rotate"></i> <span>确认恢复写入</span>
          </button>
        </div>
      </div>
    </div>

    ${!isDrawer ? `
    <footer class="app-footer">
      <p>st-zip-converter · 遵循 SillyTavern 扩展规范 · <a href="https://github.com/jiozhaoyue/st-zip-converter" target="_blank" rel="noopener">GitHub 仓库</a> · <a href="https://github.com/jiozhaoyue/st-zip-converter/fork" target="_blank" rel="noopener">Fork 并部署专属 Pages</a></p>
    </footer>
    ` : ''}
  `;
}
```

关键 id 保持不变（index.js 零改动即可继续绑定）：`env-badge`、`host-user-badge`、`host-tag-platform`、`workspace-status-text`（见 Step 3.2）、`dropzone`/`file-input`/`drop-main-text`/`drop-sub-text`、`category-panel` 系、`target-select`、`compression-select`、`split-select`、`placeholder-chips`、`filename-template-input`、`filename-preview`、`include-*`、`incremental-mode-check`、`prune-builtin-check`、`keep-dev-files-check`、`host-incremental-export`、`host-base-zip-*`、`btn-convert`、`btn-restore-luker`、`progress-container` 系、`report-panel` 系、`restore-modal-overlay` 系、`usage-dashboard`、`export-queue-panel`。

变更新增 id：`btn-host-fetch`（新宿主拉取按钮）、`stash-list`、`stash-batch-bar`、`status-row`、`log-console-mount`。变更删除 id：`host-export-card`、`host-category-grid`、`host-cat`、`host-target-select`、`host-split-select`、`host-filename-preview(-row)`、`workspace-panel-drawer`、`workspace-bar`、`btn-host-export-download`、`btn-host-export-workspace`、`btn-clear-workspace`、`workspace-status-text`、`export-queue-drawer`、`report-panel-drawer`、`host-link-char-chats`（并入 `link-char-chats-check`）、`host-selection-mode-hint`（移入 JS 动态提示）、`host-category-summary`。

- [ ] **Step 3.2: 工作区状态行迁移**

`workspace-status-text`/`btn-clear-workspace` 随 `workspace-bar` 删除。`index.js` 中 `updateWorkspaceUI` 的状态汇总改写到上传暂存区标题（Task 5 Step 5.4 处理 index.js；本任务只删 DOM）。`btn-clear-workspace` 逻辑移入 stash-list 批操作条（Task 5）。

- [ ] **Step 3.3: 抽屉挂载点适配**

`src/ui/host-bridge.js` mountSettingsDrawer 内 `getWorkbenchHtml({ isDrawer: true })` 调用不变；日志挂载点：`index.js:75` `setupLogConsole(root)` 改为 `setupLogConsole(document.getElementById('log-console-mount') || root)`（Task 5 Step 5.4 一并改）。

- [ ] **Step 3.4: 构建冒烟**

Run: `npm run build`
Expected: 构建成功（此时尚有 index.js 引用已删 id，运行时报错属预期，Task 5 修复；构建只验证语法）。

- [ ] **Step 3.5: 提交**

```bash
cd /d/Repo/Tavern-repo/My-repo/ST-zip-converter
git add src/ui/workbench-template.js
git commit -m "refactor(ui): rewrite workbench template as two-block layout"
```

---

## Task 4: export-queue 多选 + 拖出 + 选位置导出

**Files:**
- Modify: `src/ui/export-queue.js`（renderExportQueue 重写渲染部分；ExportQueue 类不动）

- [ ] **Step 4.1: 新增导出辅助函数**

`src/ui/export-queue.js` 顶部 `triggerBlobDownload` 之后加：

```js
/**
 * 通过 File System Access API 选择位置写出文件；不支持或用户取消时回退普通下载。
 * @param {Blob} blob
 * @param {string} name
 */
export async function exportToLocation(blob, name) {
  if (typeof window === 'undefined' || !window.showSaveFilePicker) {
    triggerBlobDownload(blob, name);
    return;
  }
  try {
    const handle = await window.showSaveFilePicker({ suggestedName: name });
    const writable = await handle.createWritable();
    await blob.stream().pipeTo(writable);
  } catch (err) {
    if (err && err.name === 'AbortError') return; // 用户取消
    triggerBlobDownload(blob, name); // FS Access 写入异常兜底
  }
}

/**
 * 供拖出 (drag-out) 使用：Chromium 支持 DownloadURL 数据类型。
 * @returns {boolean} 是否注册成功
 */
export function setDragOutPayload(dataTransfer, blob, name) {
  if (typeof DataTransfer === 'undefined' || typeof URL === 'undefined') return false;
  try {
    const probe = new DataTransfer();
    if (!probe.types || !probe.types.includes('DownloadURL')) return false;
  } catch {
    return false;
  }
  const url = URL.createObjectURL(blob);
  dataTransfer.setData('DownloadURL', `application/zip:${name}:${url}`);
  setTimeout(() => URL.revokeObjectURL(url), 120_000); // 拖放过程可能很长
  return true;
}
```

- [ ] **Step 4.2: 重写 renderExportQueue 渲染（多选 + 批操作 + 拖出行）**

替换 `renderExportQueue` 函数体（ExportQueue 类与 ORIGIN_LABELS/formatBytes/triggerBlobDownload 不动）：

```js
export function renderExportQueue({ containerEl, queue, isHostAvailable = false, onRestoreToHost, onWorkspaceChanged }) {
  if (!containerEl) return;
  const selected = new Set();

  const render = () => {
    containerEl.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'export-queue-header';
    header.innerHTML = `<span class="eq-title"><i class="fa-solid fa-file-export"></i> 待导出 (${queue.items.length})</span>`;

    if (queue.items.length > 0) {
      const batchBar = document.createElement('div');
      batchBar.className = 'eq-batch-bar';
      const mkBtn = (html, title, onClick) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'menu_button btn-tool';
        b.innerHTML = html;
        if (title) b.title = title;
        b.addEventListener('click', onClick);
        return b;
      };
      batchBar.appendChild(mkBtn('<i class="fa-solid fa-download"></i> 全部下载', '', () => queue.downloadAll()));
      batchBar.appendChild(mkBtn('<i class="fa-solid fa-box-archive"></i> 全部存入工作区', '', async () => {
        await queue.stashAll();
        if (typeof onWorkspaceChanged === 'function') onWorkspaceChanged();
      }));
      batchBar.appendChild(mkBtn('<i class="fa-solid fa-trash"></i> 清空', '', () => {
        if (confirm('确定清空待导出区吗？临时产物将一并丢弃。')) queue.clear();
      }));
      header.appendChild(batchBar);
    }
    containerEl.appendChild(header);

    if (queue.items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'export-queue-empty';
      empty.textContent = '暂无待导出产物：完成宿主拉取或转换后，产物会出现在这里统一处置';
      containerEl.appendChild(empty);
      return;
    }

    // 选中批操作条（勾选 ≥1 时出现）
    const selBar = document.createElement('div');
    selBar.className = 'eq-batch-bar eq-selected-bar';
    const refreshSelBar = () => {
      selBar.innerHTML = '';
      if (selected.size === 0) return;
      const label = document.createElement('span');
      label.className = 'eq-selected-label';
      label.textContent = `已选 ${selected.size} 项:`;
      selBar.appendChild(label);
      selBar.appendChild(mkBtn('<i class="fa-solid fa-download"></i> 下载', '', () => {
        for (const id of selected) queue.download(id);
      }));
      selBar.appendChild(mkBtn('<i class="fa-solid fa-folder-open"></i> 选位置导出', '逐个弹出保存位置 (浏览器不支持时普通下载)', async () => {
        for (const id of selected) {
          const item = queue.items.find((it) => it.id === id);
          if (item) await exportToLocation(item.blob, item.name);
        }
      }));
      selBar.appendChild(mkBtn('<i class="fa-solid fa-box-archive"></i> 存工作区', '', async () => {
        for (const id of selected) await queue.stash(id);
        if (typeof onWorkspaceChanged === 'function') onWorkspaceChanged();
      }));
      if (isHostAvailable && typeof onRestoreToHost === 'function') {
        selBar.appendChild(mkBtn('<i class="fa-solid fa-rotate"></i> 写回宿主', '', () => {
          const first = [...selected][0];
          const item = queue.items.find((it) => it.id === first);
          if (item) onRestoreToHost(item);
        }));
      }
      selBar.appendChild(mkBtn('<i class="fa-solid fa-trash"></i> 移除', '', () => {
        for (const id of [...selected]) { selected.delete(id); queue.remove(id); }
      }));
    };
    refreshSelBar();
    containerEl.appendChild(selBar);

    const list = document.createElement('div');
    list.className = 'export-queue-list';
    for (const item of queue.items) {
      const row = document.createElement('div');
      row.className = 'export-queue-item';
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        setDragOutPayload(e.dataTransfer, item.blob, item.name);
      });

      const info = document.createElement('div');
      info.className = 'eq-info';
      const originLabel = ORIGIN_LABELS[item.origin] || ORIGIN_LABELS[ORIGINS.CONVERTED];
      info.innerHTML = `
        <div class="eq-name-row">
          <input type="checkbox" class="eq-select-box" data-id="${item.id}" ${selected.has(item.id) ? 'checked' : ''}>
          <span class="eq-name">${item.name}</span>
        </div>
        <div class="eq-meta">
          <span class="origin-badge ${originLabel.cls}">${originLabel.text}</span>
          ${item.targetLayout ? `<span class="meta-badge">${String(item.targetLayout).toUpperCase()}</span>` : ''}
          <span>${formatBytes(item.blob.size)}</span>
          ${item.storedId ? '<span class="eq-stored">已入库</span>' : '<span class="eq-ephemeral">临时</span>'}
        </div>
      `;
      row.appendChild(info);

      const btns = document.createElement('div');
      btns.className = 'eq-buttons';
      const mkBtn = (cls, html, title, onClick) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `btn-archive-action ${cls}`;
        b.innerHTML = html;
        if (title) b.title = title;
        b.addEventListener('click', onClick);
        return b;
      };
      btns.appendChild(mkBtn('download', '下载', '', () => queue.download(item.id)));
      btns.appendChild(mkBtn('load-source', '选位置导出', '选择保存位置写出该文件', () => exportToLocation(item.blob, item.name)));
      const btnStash = mkBtn('load-source', '存工作区', '', async () => {
        await queue.stash(item.id);
        if (typeof onWorkspaceChanged === 'function') onWorkspaceChanged();
      });
      btnStash.disabled = Boolean(item.storedId);
      btns.appendChild(btnStash);
      if (isHostAvailable && typeof onRestoreToHost === 'function') {
        btns.appendChild(mkBtn('restore', '<i class="fa-solid fa-rotate"></i> 写回宿主', '', () => onRestoreToHost(item)));
      }
      btns.appendChild(mkBtn('delete', '移除', '', () => { selected.delete(item.id); queue.remove(item.id); }));
      row.appendChild(btns);
      list.appendChild(row);
    }
    containerEl.appendChild(list);

    // 复选框事件委托（列表重渲染后仍生效）
    list.addEventListener('change', (e) => {
      const box = e.target.closest('.eq-select-box');
      if (!box) return;
      if (box.checked) selected.add(box.dataset.id);
      else selected.delete(box.dataset.id);
      refreshSelBar();
    });
  };

  queue.subscribe(render);
  render();
}
```

- [ ] **Step 4.3: 测试更新**

`test/export-queue.test.js` 无 autoDownload 断言需改（已确认注释）。追加渲染层不需要单测（JS-DOM 未配置），状态机沿用现有类测试。运行：

Run: `npm test`
Expected: 全绿。

- [ ] **Step 4.4: 提交**

```bash
cd /d/Repo/Tavern-repo/My-repo/ST-zip-converter
git add src/ui/export-queue.js
git commit -m "feat(ui): export queue multi-select, drag-out and save-to-location"
```

---

## Task 5: stash-list 源包列表组件 + index.js 控制器适配

**Files:**
- Create: `src/ui/stash-list.js`
- Test: `test/stash-list.test.js`
- Modify: `index.js`

- [ ] **Step 5.1: 纯函数抽取（TDD）**

`src/ui/stash-list.js` 先写可测的纯逻辑（无 DOM 依赖部分）：

```js
/**
 * 上传暂存区源包列表组件。
 * 渲染 origin ∈ {upload, host-export} 的 IndexedDB 源包，支持复选框多选与批操作。
 * 纯逻辑（过滤/分组）与 DOM 渲染分离以便单测。
 */
import { listStoredFiles, getFile, deleteFile } from '../storage/db.js';

export const STASH_ORIGINS = Object.freeze(['upload', 'host-export']);

/**
 * 从全部文件记录中筛出暂存区源包（纯函数）
 * @param {Array<{origin?: string}>} files
 * @returns {Array} origin ∈ upload|host-export 的记录
 */
export function filterStashFiles(files) {
  const set = new Set(STASH_ORIGINS);
  return (files || []).filter((f) => set.has(f.origin));
}

/**
 * 计算批操作可用性（纯函数）
 * @param {Set<string>} selectedIds
 * @returns {{ canLoad: boolean, canDownload: boolean, canRestore: boolean, canDelete: boolean }}
 */
export function stashBatchCapability(selectedIds, isHostAvailable = false) {
  const n = selectedIds ? selectedIds.size : 0;
  return {
    canLoad: n === 1,               // 载入为源：单选语义
    canDownload: n > 0,
    canRestore: n > 0 && isHostAvailable,
    canDelete: n > 0,
  };
}
```

- [ ] **Step 5.2: 写失败测试**

`test/stash-list.test.js`：

```js
import { describe, expect, it } from 'vitest';
import { filterStashFiles, stashBatchCapability } from '../src/ui/stash-list.js';

describe('filterStashFiles', () => {
  it('仅保留 upload 与 host-export 来源', () => {
    const files = [
      { id: '1', origin: 'upload' },
      { id: '2', origin: 'host-export' },
      { id: '3', origin: 'converted' },
      { id: '4', origin: 'delta' },
      { id: '5', origin: 'split-part' },
      { id: '6' }, // 无 origin 视为旧数据，不显示
    ];
    const out = filterStashFiles(files);
    expect(out.map((f) => f.id)).toEqual(['1', '2']);
  });

  it('空输入返回空数组', () => {
    expect(filterStashFiles([])).toEqual([]);
    expect(filterStashFiles(null)).toEqual([]);
  });
});

describe('stashBatchCapability', () => {
  it('未选中时全部不可用', () => {
    const cap = stashBatchCapability(new Set());
    expect(cap).toEqual({ canLoad: false, canDownload: false, canRestore: false, canDelete: false });
  });
  it('单选时允许载入为源', () => {
    const cap = stashBatchCapability(new Set(['a']));
    expect(cap.canLoad).toBe(true);
  });
  it('多选时禁止载入为源，允许下载/删除', () => {
    const cap = stashBatchCapability(new Set(['a', 'b']));
    expect(cap.canLoad).toBe(false);
    expect(cap.canDownload).toBe(true);
    expect(cap.canDelete).toBe(true);
  });
  it('宿主不可用时禁止写回', () => {
    const cap = stashBatchCapability(new Set(['a']), false);
    expect(cap.canRestore).toBe(false);
    const cap2 = stashBatchCapability(new Set(['a']), true);
    expect(cap2.canRestore).toBe(true);
  });
});
```

- [ ] **Step 5.3: 运行测试确认通过（纯函数已实现，直接验证）**

Run: `npx vitest run test/stash-list.test.js`
Expected: PASS（纯函数随 Step 5.1 一起写入，此步验证其正确性；DOM 渲染部分下一步补）

- [ ] **Step 5.4: 补 DOM 渲染与组件入口**

`src/ui/stash-list.js` 末尾追加渲染函数（同文件）：

```js
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

const ORIGIN_LABELS = {
  upload: { text: '上传', cls: 'origin-upload' },
  'host-export': { text: '宿主导出', cls: 'origin-host' },
};

/**
 * 渲染上传暂存区列表
 * @param {object} params
 * @param {HTMLElement} params.containerEl #stash-list
 * @param {HTMLElement|null} [params.batchBarEl] #stash-batch-bar
 * @param {string|null} params.activeFileId 当前载入为源的文件 id
 * @param {boolean} [params.isHostAvailable]
 * @param {function(object): void} params.onLoadFile (fileRecord) => void
 * @param {function(): void} [params.onListChanged]
 * @param {function(object): void} [params.onRestoreToHost]
 */
export async function renderStashList({
  containerEl,
  batchBarEl = null,
  activeFileId = null,
  isHostAvailable = false,
  onLoadFile,
  onListChanged,
  onRestoreToHost,
}) {
  if (!containerEl) return;
  const all = await listStoredFiles();
  const files = filterStashFiles(all);
  const selected = new Set();

  containerEl.innerHTML = '';
  if (batchBarEl) batchBarEl.innerHTML = '';

  if (files.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'archive-empty';
    empty.textContent = '暂无源包：拖入或上传 Zip 后出现在这里';
    containerEl.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'archive-item-list stash-list';
  const refreshBatchBar = () => {
    if (!batchBarEl) return;
    batchBarEl.innerHTML = '';
    batchBarEl.hidden = selected.size === 0;
    if (selected.size === 0) return;
    const cap = stashBatchCapability(selected, isHostAvailable);
    const label = document.createElement('span');
    label.className = 'eq-selected-label';
    label.textContent = `已选 ${selected.size} 项:`;
    batchBarEl.appendChild(label);
    const mkBtn = (html, title, enabled, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'menu_button btn-tool';
      b.innerHTML = html;
      if (title) b.title = title;
      b.disabled = !enabled;
      b.addEventListener('click', onClick);
      return b;
    };
    batchBarEl.appendChild(mkBtn('<i class="fa-solid fa-folder-open"></i> 载入为源', '将选中的第一个包设为当前转换源', cap.canLoad, async () => {
      const firstId = [...selected][0];
      const full = await getFile(firstId);
      if (full && typeof onLoadFile === 'function') onLoadFile(full);
    }));
    batchBarEl.appendChild(mkBtn('<i class="fa-solid fa-download"></i> 下载', '', cap.canDownload, async () => {
      for (const id of selected) {
        const full = await getFile(id);
        if (full?.blob) {
          const url = URL.createObjectURL(full.blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = full.name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
        }
      }
    }));
    if (cap.canRestore && typeof onRestoreToHost === 'function') {
      batchBarEl.appendChild(mkBtn('<i class="fa-solid fa-rotate"></i> 写回宿主', '', true, async () => {
        const firstId = [...selected][0];
        const full = await getFile(firstId);
        if (full?.blob) onRestoreToHost(full);
      }));
    }
    batchBarEl.appendChild(mkBtn('<i class="fa-solid fa-trash"></i> 删除', '', cap.canDelete, async () => {
      if (!confirm(`确定删除选中的 ${selected.size} 个源包吗？`)) return;
      for (const id of [...selected]) {
        selected.delete(id);
        await deleteFile(id);
      }
      if (typeof onListChanged === 'function') onListChanged();
    }));
  };

  for (const file of files) {
    const isActive = file.id === activeFileId;
    const item = document.createElement('div');
    item.className = `archive-card ${isActive ? 'active' : ''}`;

    const info = document.createElement('div');
    info.className = 'archive-info';
    const label = ORIGIN_LABELS[file.origin] || { text: file.origin || '上传', cls: 'origin-upload' };
    info.innerHTML = `
      <div class="eq-name-row">
        <input type="checkbox" class="stash-select-box" data-id="${file.id}" title="加入选择">
        <span class="archive-name">${file.name}</span>
        ${isActive ? '<span class="badge-active-file">当前源</span>' : ''}
      </div>
      <div class="archive-meta">
        <span class="origin-badge ${label.cls}">${label.text}</span>
        <span class="meta-badge">${(file.layout || '未知').toUpperCase()}</span>
        <span>${formatBytes(file.size)}</span>
      </div>
    `;
    item.appendChild(info);

    const btns = document.createElement('div');
    btns.className = 'archive-buttons';
    const mkBtn = (cls, text, title, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn-archive-action ${cls}`;
      b.textContent = text;
      if (title) b.title = title;
      b.addEventListener('click', onClick);
      return b;
    };
    if (!isActive) {
      btns.appendChild(mkBtn('load', '载入', '载入为当前转换源', async () => {
        const full = await getFile(file.id);
        if (full && typeof onLoadFile === 'function') onLoadFile(full);
      }));
    }
    btns.appendChild(mkBtn('download', '下载', '', async () => {
      const full = await getFile(file.id);
      if (full?.blob) {
        const url = URL.createObjectURL(full.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = full.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    }));
    if (isHostAvailable && typeof onRestoreToHost === 'function') {
      btns.appendChild(mkBtn('restore', '写回宿主', '', async () => {
        const full = await getFile(file.id);
        if (full?.blob) onRestoreToHost(full);
      }));
    }
    btns.appendChild(mkBtn('delete', '删除', '', async () => {
      if (!confirm(`确定要从暂存区删除「${file.name}」吗？`)) return;
      await deleteFile(file.id);
      if (typeof onListChanged === 'function') onListChanged();
    }));
    item.appendChild(btns);
    list.appendChild(item);
  }
  containerEl.appendChild(list);

  list.addEventListener('change', (e) => {
    const box = e.target.closest('.stash-select-box');
    if (!box) return;
    if (box.checked) selected.add(box.dataset.id);
    else selected.delete(box.dataset.id);
    refreshBatchBar();
  });
}
```

- [ ] **Step 5.5: index.js 控制器适配**

修改 `index.js`（逐处）：

1. import 区新增：

```js
import { renderStashList } from './src/ui/stash-list.js';
```

2. 删除元素引用（约 :131-136）：`workspaceBar`、`workspaceStatusText`、`btnClearWorkspace` 常量及 `index.js:996-1013` 的 `btnClearWorkspace` 清空监听块（清空能力由 stash-list 批操作"删除"承担；`clearAll` 全清入口保留在 `onListChanged` 之外不再使用，直接删除该监听）。

3. `refreshArchiveManagerUI`（约 :254-292）整体替换为：

```js
  // 上传暂存区源包列表（含选中批操作）
  async function refreshArchiveManagerUI() {
    const stashListEl = document.getElementById('stash-list');
    const stashBatchBar = document.getElementById('stash-batch-bar');
    if (!stashListEl) return;
    await renderStashList({
      containerEl: stashListEl,
      batchBarEl: stashBatchBar,
      activeFileId: currentFileId,
      isHostAvailable: host.isPlugin,
      onLoadFile: async (fileRecord) => {
        if (!fileRecord || !fileRecord.blob) return;
        currentFile = fileRecord.blob;
        currentFile.name = fileRecord.name;
        currentFileId = fileRecord.id;
        currentFileHandle = fileRecord.handle || 'default-user';

        btnConvert.disabled = false;
        if (dropHandler?.setFilename) {
          dropHandler.setFilename(fileRecord.name);
        }
        view.setProgress(0, `已载入数据包：${fileRecord.name} (${formatBytes(fileRecord.size)})`);
        logger.info(`载入数据包作为当前处理源: ${fileRecord.name} (用户: ${currentFileHandle})`);
        updateFilenamePreview();
        await refreshPlan();
        await refreshArchiveManagerUI();
      },
      onListChanged: async () => {
        await updateWorkspaceUI();
      },
      onRestoreToHost: (fileRecord) => {
        openRestoreModal(fileRecord);
      },
    });
  }
```

> 原 `renderArchiveManager` import 与调用移除；`src/ui/archive-manager.js` 文件保留（不再被 index.js 引用，供后续复用或删除）。

4. `updateWorkspaceUI`（约 :374-389）中状态条写入删除，改为：

```js
  async function updateWorkspaceUI() {
    if (!isStorageSupported()) return;
    try {
      await refreshArchiveManagerUI();
      await refreshUsageDashboard();
      refreshExportQueueUI();
    } catch (err) {
      console.warn('刷新工作区 UI 失败:', err);
    }
  }
```

5. `refreshBaseArchiveOptions`（约 :528-546）下拉数据源从 `listStoredFiles()` 改为只列暂存源包（复用 filterStashFiles）：

```js
import { filterStashFiles } from './src/ui/stash-list.js';
// ...
      const storedFiles = filterStashFiles(await listStoredFiles());
```

6. 宿主拉取按钮改绑（约 :841-848）：

```js
  const btnHostFetch = document.getElementById('btn-host-fetch');
  if (btnHostFetch) {
    btnHostFetch.addEventListener('click', () => handleHostExport());
  }
```

7. handleHostExport 内部类目与控件统一（**关键接线**，对应规格 §3.2）：

```js
  // 原 (:517-518 与 :663-667) hostQuickButtons/hostCatBoxes 循环收集勾选 —— 随 host-cat 删除，
  // 改用统一类目组件的唯一勾选状态：
  const selection = getSelectionState();   // 与外部转换路径共用同一份勾选

  // 原 :720 hostIncludeBackupsCheck → 统一开关:
  const hostIncludeBackups = includeBackupsCheck ? includeBackupsCheck.checked : false;
  // 原 :715-717 hostSplitSelect → 统一分包:
  const splitVal = splitSelect ? splitSelect.value : 'none';   // #split-select
  // 原 :718-719 hostPruneBuiltin → 统一开关:
  const pruneBuiltinAssets = pruneBuiltinCheck ? pruneBuiltinCheck.checked : true;  // #prune-builtin-check
```

函数开头 `btnDownload`/`btnWorkspace` 双按钮引用删除，统一 `btnHostFetch.disabled` 控制；
函数签名改 `async function handleHostExport()`（无参）；末尾产物入队一律：

```js
      exportQueue.enqueue({
        name: finalFilename,
        blob: finalBlob,
        targetLayout: targetLayout,
        origin: isDeltaPatch ? 'delta' : 'host-export',
        ephemeral: true,
      });
```

（删除 `autoDownload` 传参与 `targetDestination === 'download'` 分支，成功文案统一为"已进入待导出区"。）

8. 死代码清理（随删除的 DOM id，全部移除对应 index.js 块）：

- `updateFilenamePreview` 内 `hostPreviewEl`/`hostTargetSelect` 整块（约 :106-119，`#host-filename-preview` 已删）；
- `applyPluginUi` 内 `selectionHint`（`#host-selection-mode-hint`）块改为动态注入：

```js
    // ST 宿主端点不支持 selection：在类目面板头部注入"插件内过滤"提示
    const categoryPanel = document.getElementById('category-panel');
    let hint = document.getElementById('host-selection-mode-hint');
    if (platform === 'st' && categoryPanel && !hint) {
      hint = document.createElement('small');
      hint.id = 'host-selection-mode-hint';
      hint.className = 'zone-hint';
      hint.style.display = 'block';
      hint.textContent = 'ST 宿主端点仅支持全量导出：勾选的类目将在导出后由插件内过滤生效';
      categoryPanel.insertBefore(hint, categoryPanel.firstChild);
    } else if (hint) {
      hint.style.display = platform === 'st' ? 'block' : 'none';
    }
```

- `applyPluginUi` 内 `hostExportCard.style.display = 'block'` 改为：

```js
    const btnHostFetch = document.getElementById('btn-host-fetch');
    if (btnHostFetch) btnHostFetch.style.display = 'inline-flex';
```

- `applyPluginUi` 内目标预设块替换为 native 选项注入（**规格 §3.2：插件模式默认"宿主原生格式"**）：

```js
    if (targetSelect) {
      let nativeOpt = targetSelect.querySelector('option[value="native"]');
      if (!nativeOpt) {
        nativeOpt = document.createElement('option');
        nativeOpt.value = 'native';
        nativeOpt.textContent = `宿主原生格式 (${hostLayoutCode(platform).toUpperCase()})`;
        targetSelect.insertBefore(nativeOpt, targetSelect.firstChild);
      }
      targetSelect.value = 'native';
    }
```

- 宿主类目块整体删除：`hostQuickButtons`、`hostCatBoxes`、`hostLinkCharChatsCheck`、
  `updateHostCategorySummary` 及其调用（约 :517-643，`#host-cat`/`#host-category-summary` 已删；
  角色聊天联动已并入统一 `#link-char-chats-check`，category-filter 组件内已有同款联动语义）。

> `restoreToHost(..., { platform: host.platform })` / `fetchHostBackup(host.platform, ...)`
> 传宿主端点平台代码，**保持不变**（非转换器 target）。

9. 外部转换产物不自动下载（约 :1113-1120）：`exportQueue.enqueue({ ..., autoDownload: true })` 删除 `autoDownload: true` 行。`runBatchConversion`（约 :232-238）`saveFile` 改为 `exportQueue.enqueue`：

```js
        exportQueue.enqueue({
          name: outputFilename,
          blob: resultBlob,
          targetLayout: target,
          origin: 'converted',
          ephemeral: true,
        });
```

10. 日志挂载（`index.js:75`）：

```js
  const logConsole = setupLogConsole(document.getElementById('log-console-mount') || root);
```

11. 转换完成后的 `btnRestoreLuker.disabled = false`（约 :1124-1126）保持不变。

- [ ] **Step 5.6: 全量测试**

Run: `npm test`
Expected: 全绿（`archive-manager` 相关测试若引用旧渲染入口，改从 `stash-list` 纯函数断言或删除对应 DOM 用例——`test/export-queue.test.js` 只测类状态机，不受影响；`grep -rn "renderArchiveManager" test/` 核对，如有 `plugin.test.js` DOM 断言按新模板 id 更新）。

- [ ] **Step 5.7: 构建 + 手动冒烟**

Run: `npm run build && npm run dev`
Expected: 构建成功；浏览器打开后：状态头+两配额条+上传暂存+待导出为一块，进度条吸顶+选项+日志为一块；拖入 zip 入列表、载入为源、转换产物入待导出区不自动下载。

- [ ] **Step 5.8: 提交**

```bash
cd /d/Repo/Tavern-repo/My-repo/ST-zip-converter
git add src/ui/stash-list.js test/stash-list.test.js index.js src/ui/archive-manager.js
git commit -m "feat(ui): stash list component and controller rewiring for two-block layout"
```

---

## Task 6: usage-dashboard 两行配额条重构

**Files:**
- Modify: `src/ui/usage-dashboard.js`

- [ ] **Step 6.1: 重写 renderUsageDashboard**

替换 `renderUsageDashboard` 全函数（`renderPackageSizeList` 删除——体积信息已由暂存列表与待导出区承载）：

```js
/**
 * 块一顶部两行配额条：
 * ①插件 IndexedDB 用量/配额（getStorageUsage + getStorageQuota）
 * ②页面整体存储 usage/quota（navigator.storage.estimate，与 Luker 原生存储查看同源）
 */
import { getStorageUsage, getStorageQuota } from '../storage/db.js';

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export async function renderUsageDashboard({ containerEl }) {
  if (!containerEl) return;
  containerEl.innerHTML = '';

  const [usage, quota] = await Promise.all([getStorageUsage(), getStorageQuota()]);

  // 行① 插件 IndexedDB
  const pluginSection = document.createElement('div');
  pluginSection.className = 'usage-quota-section';
  const pluginPct = quota.quota > 0 ? Math.min(100, (usage.totalBytes / quota.quota) * 100) : 0;
  pluginSection.innerHTML = `
    <div class="usage-quota-label">
      <span><i class="fa-solid fa-database"></i> 插件 IndexedDB (${usage.count} 包)</span>
      <span>${formatBytes(usage.totalBytes)}${quota.quota > 0 ? ` / ${formatBytes(quota.quota)} (${pluginPct.toFixed(1)}%)` : ''}</span>
    </div>
    <div class="usage-quota-bar"><div class="usage-quota-fill" style="width:${pluginPct.toFixed(1)}%"></div></div>
  `;
  containerEl.appendChild(pluginSection);

  // 行② 页面整体存储（不支持 estimate 的环境整行隐藏）
  if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
    try {
      const est = await navigator.storage.estimate();
      if (est && est.quota > 0) {
        const pct = Math.min(100, ((est.usage || 0) / est.quota) * 100);
        const pageSection = document.createElement('div');
        pageSection.className = 'usage-quota-section';
        pageSection.innerHTML = `
          <div class="usage-quota-label">
            <span><i class="fa-solid fa-hard-drive"></i> 页面整体存储</span>
            <span>${formatBytes(est.usage || 0)} / ${formatBytes(est.quota)} (${pct.toFixed(1)}%)</span>
          </div>
          <div class="usage-quota-bar"><div class="usage-quota-fill usage-quota-fill-page" style="width:${pct.toFixed(1)}%"></div></div>
        `;
        containerEl.appendChild(pageSection);
      }
    } catch {
      // estimate 失败静默跳过第二行
    }
  }
}
```

- [ ] **Step 6.2: 测试**

Run: `npm test`
Expected: 全绿（usage-dashboard 无现有单测；`getStorageUsage/byOrigin` 仍被 db 测试覆盖）。

- [ ] **Step 6.3: 提交**

```bash
cd /d/Repo/Tavern-repo/My-repo/ST-zip-converter
git add src/ui/usage-dashboard.js
git commit -m "feat(ui): dual quota bars (plugin IndexedDB + page-wide storage estimate)"
```

---

## Task 7: 配色继承宿主主题 + 根除写死色值

**Files:**
- Modify: `style.css`（变量层 + 全部金色引用 + sticky 进度条 + 新类）
- Modify: `src/ui/workbench-template.js`（残留内联色值清扫，若 Task 3 模板已全部类化则仅核对）
- Modify: `src/ui/host-bridge.js`（mountSettingsDrawer 抽屉头 icon 内联色）

- [ ] **Step 7.1: 变量层重写**

`style.css:7-70` 容器变量块改为（保留结构与注释头）：

```css
.app-container,
.st-converter-drawer-app {
  /* 宿主主题变量：插件模式直接继承宿主；独立 Web 模式未定义时走回退值。
     严禁在此硬编码 --SmartTheme* 覆盖宿主主题（09-07-ui-unify 教训）。 */
  --bg-primary: var(--SmartThemeBodyColor, #14161c);
  --bg-secondary: var(--SmartThemeChatTintColor, #1b1e27);
  --bg-card: color-mix(in srgb, var(--bg-secondary) 86%, transparent);
  --bg-input: color-mix(in srgb, var(--bg-primary) 80%, transparent);

  --border-color: var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.14));
  --border-subtle: color-mix(in srgb, var(--border-color) 50%, transparent);
  --border-focus: var(--SmartThemeQuoteColor, #f59e0b);

  --text-main: var(--SmartThemeBodyColorInverted, #f2f4f8);
  --text-em: var(--SmartThemeEmColor, #f5c542);
  --text-gold: var(--text-em);
  --text-muted: color-mix(in srgb, var(--text-main) 62%, transparent);
  --text-sub: color-mix(in srgb, var(--text-main) 42%, transparent);

  --accent: var(--SmartThemeQuoteColor, #f59e0b);
  --accent-hover: color-mix(in srgb, var(--accent) 80%, #fff);
  --accent-st: #38bdf8;
  --accent-luker: #c084fc;
  --accent-tt: #fb7185;
  --accent-pt: #34d399;

  --warning: #f59e0b;
  --danger: #ef4444;
  --success: #10b981;

  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;

  --shadow-card: 0 4px 20px -2px rgba(0, 0, 0, 0.4);
  --shadow-glow: 0 0 14px color-mix(in srgb, var(--accent) 25%, transparent);
}
```

- [ ] **Step 7.2: 全文件金色引用替换（机械替换表）**

对 `style.css` 全文执行：

| 原 | 新 |
|---|---|
| `var(--tavern-gold)` | `var(--accent)` |
| `var(--tavern-gold-hover)` | `var(--accent-hover)` |
| `var(--tavern-gold-light)` | `var(--text-em)` |
| `var(--tavern-glow)` | `var(--shadow-glow)` |
| `var(--tavern-glow-strong)` | `var(--shadow-glow)` |
| `var(--tavern-parchment)` | `var(--text-em)` |
| `var(--tavern-amber)` / `var(--tavern-amber-dark)` | `var(--accent-hover)` |
| `#f59e0b`（十六进制直写） | `var(--accent, #f59e0b)` |
| `#fbbf24` / `#fef08a` / `#fef3c7` | `var(--text-em)` |
| `linear-gradient(90deg, #b45309, #f59e0b, #fbbf24)`（进度条） | `var(--accent)` |
| `linear-gradient(135deg, #d97706 0%, #b45309 100%)`（btn-primary 底） | `color-mix(in srgb, var(--accent) 24%, transparent)` |
| `rgba(245, 158, 11, X)`（X∈.07~.55 金色透明变体） | `color-mix(in srgb, var(--accent) ${X*100}%, transparent)` |
| `rgba(192, 132, 252, X)`（Luker 紫透明变体） | 保留（平台标识色，非主题色） |
| `color: #11111b` / `color: #000`（实底按钮黑字） | `color: var(--accent)`（配合 7.3 去实底） |

替换后 `grep -n "tavern-gold\|tavern-amber\|tavern-glow\|tavern-parchment\|#f59e0b\|#fbbf24\|#fef08a\|#fef3c7\|#11111b" style.css` 应仅剩回退值出现。

- [ ] **Step 7.3: CTA 按钮对比安全化（黑字根除）**

`style.css` 中 `.btn-primary`、模板内 `btn-accent`（新增）：

```css
/* 强调按钮：强调色半透明底 + 强调色文字（不写死文字色，任何主题下可读） */
.btn-primary,
.app-container .btn-accent, .st-converter-drawer-app .btn-accent {
  background: color-mix(in srgb, var(--accent) 24%, transparent);
  color: var(--accent);
  border: 1px solid var(--accent);
}

.btn-primary:hover:not(:disabled),
.app-container .btn-accent:hover:not(:disabled), .st-converter-drawer-app .btn-accent:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 38%, transparent);
  box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 35%, transparent);
}

@supports not (color: color-mix(in srgb, red, blue)) {
  .btn-primary,
  .app-container .btn-accent, .st-converter-drawer-app .btn-accent {
    background: rgba(245, 158, 11, 0.24);
    color: #f59e0b;
  }
}
```

同时删除模板 HTML 中原 `style="background: var(--SmartThemeQuoteColor, #f59e0b); color: #11111b; font-weight: bold;"` 内联（Task 3 模板已改为 `btn-accent` 类，此处核对 `workbench-template.js` 与 `host-bridge.js` 无残留内联色值：`grep -n "style=\"[^\"]*\(color\|background\)" src/ui/workbench-template.js src/ui/host-bridge.js`，有则改类）。`host-bridge.js` mountSettingsDrawer 抽屉头 `style="color: var(--SmartThemeQuoteColor, #f59e0b);"` 保留（已是变量引用）。

- [ ] **Step 7.4: 进度条 sticky 吸顶 + 新组件类**

`style.css` 末尾追加：

```css
/* ═══ 两块式布局 (two-block) ═══ */
.app-container .wb-block, .st-converter-drawer-app .wb-block {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.app-container .status-row, .st-converter-drawer-app .status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

/* 进度条：块二顶部 sticky 吸顶，任务运行时始终可见 */
.app-container .progress-container, .st-converter-drawer-app .progress-container {
  display: none;
  margin: 0;
}

.app-container .wb-block-controls .progress-container.active, .st-converter-drawer-app .wb-block-controls .progress-container.active {
  display: block;
  position: sticky;
  top: 0;
  z-index: 100;
  background: var(--bg-card);
  padding: 8px 4px;
  margin: -8px -4px;
  border-radius: var(--radius-sm);
}

.app-container .zone-card, .st-converter-drawer-app .zone-card {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  background: color-mix(in srgb, var(--bg-primary) 45%, transparent);
}

.app-container .zone-title, .st-converter-drawer-app .zone-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-em);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.app-container .zone-hint, .st-converter-drawer-app .zone-hint {
  font-size: 0.72rem;
  font-weight: 400;
  color: var(--text-sub);
  margin-left: 6px;
}

.app-container .dropzone-inline, .st-converter-drawer-app .dropzone-inline {
  padding: 16px 12px;
}

.app-container .eq-name-row, .st-converter-drawer-app .eq-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.app-container .eq-selected-bar, .st-converter-drawer-app .eq-selected-bar {
  padding: 6px 8px;
  border: 1px dashed var(--accent);
  border-radius: var(--radius-sm);
  align-items: center;
}

.app-container .eq-selected-label, .st-converter-drawer-app .eq-selected-label {
  font-size: 0.76rem;
  color: var(--text-em);
  font-weight: 600;
  margin-right: 4px;
}

.app-container .base-zip-section, .st-converter-drawer-app .base-zip-section {
  padding: 8px 10px;
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--bg-primary) 40%, transparent);
}

.app-container .base-zip-title, .st-converter-drawer-app .base-zip-title {
  font-size: 0.8rem;
  font-weight: bold;
  margin-bottom: 6px;
  color: var(--accent);
}

.app-container .base-zip-status, .st-converter-drawer-app .base-zip-status {
  font-size: 0.78rem;
  color: var(--danger);
}

.app-container .ext-mode-card, .st-converter-drawer-app .ext-mode-card {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  cursor: pointer;
  align-items: flex-start;
  background: color-mix(in srgb, var(--bg-primary) 40%, transparent);
}

.app-container .ext-mode-card:has(input:checked), .st-converter-drawer-app .ext-mode-card:has(input:checked) {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}

.app-container .ext-mode-title, .st-converter-drawer-app .ext-mode-title {
  color: var(--accent);
  font-size: 0.85rem;
}

.app-container .ext-mode-desc, .st-converter-drawer-app .ext-mode-desc {
  margin: 2px 0 0 0;
  font-size: 0.74rem;
  color: var(--text-muted);
  line-height: 1.35;
}

.app-container .btn-tpl-preset, .st-converter-drawer-app .btn-tpl-preset {
  background: transparent;
  border: none;
  color: var(--accent);
  cursor: pointer;
  text-decoration: underline;
  padding: 0;
}

.app-container .action-row, .st-converter-drawer-app .action-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

/* 页面整体存储配额条用次级色区分 */
.app-container .usage-quota-fill-page, .st-converter-drawer-app .usage-quota-fill-page {
  background: color-mix(in srgb, var(--accent) 45%, transparent);
}
```

- [ ] **Step 7.5: 视觉回归核对**

Run: `npm run dev`
Expected（独立模式）：深色回退主题生效、无金色品牌化残留、按钮文字可读、进度条吸顶。
插件模式核对点（Luker 实例 Git 更新后人工复核，不写入实例目录）：换主题跟随、无宿主样式污染（重点回归 `.menu_button`/`.inline-drawer` 作用域未破坏——本次只改值未动选择器作用域）。

- [ ] **Step 7.6: 全量测试 + 提交**

Run: `npm test && npm run build`
Expected: 全绿 + 构建成功。

```bash
cd /d/Repo/Tavern-repo/My-repo/ST-zip-converter
git add style.css src/ui/workbench-template.js src/ui/host-bridge.js
git commit -m "fix(ui): inherit host theme variables and purge hardcoded gold/black colors"
```

---

## Task 8: 收尾验证

- [ ] **Step 8.1: 全量测试**

Run: `npm test`
Expected: 全绿。

- [ ] **Step 8.2: 构建**

Run: `npm run build`
Expected: 成功。

- [ ] **Step 8.3: 独立模式浏览器冒烟（webapp 级）**

Run: `npm run dev`，浏览器验证：
1. 拖入 2 个 zip → 暂存列表出现 2 条；
2. 复选 2 条 → 批操作条出现，"载入为源"禁用（多选），单选 1 条时可用；
3. 载入为源 → 开始转换 → 产物出现在待导出区且**未**自动下载；
4. 待导出区拖一行到桌面资源管理器（Chromium）→ 文件落盘；
5. "选位置导出"→ 系统保存对话框出现；
6. 进度条转换期间吸顶可见；
7. 两行配额条数值合理。

- [ ] **Step 8.4: 提交收尾（如有零星修复）**

```bash
cd /d/Repo/Tavern-repo/My-repo/ST-zip-converter
git add -A
git commit -m "chore: final polish for two-block workbench"
```
