# Component Guidelines (Plugin DOM & UI Injection)

> Conventions for UI injection, DOM isolation, and event handling within host Tavern environments.

---

## Overview

The in-app export plugin runs inside third-party web apps (SillyTavern and Luker). To avoid dependency conflicts, style pollution, or bundler bloat:
- **No Heavy UI Frameworks**: Do NOT use React, Vue, or Svelte inside plugins. Use lightweight vanilla DOM manipulation.
- **Strict Scope Isolation**: All DOM elements created by the plugin must use the `tavern-convert-` prefix on IDs and classes.

---

## UI Mounting & Graceful Degradation

Plugins must dynamically adapt to different themes and UI layouts of host apps:

```javascript
function mountUi() {
  const targets = Object.keys(TARGET_LABELS);
  const menu = document.querySelector('#extensionsMenu .list-group');
  const container = document.createElement(menu ? 'a' : 'div');

  if (menu) {
    // Standard host extension menu injection
    container.className = 'list-group-item flexify-horizontal';
    container.innerHTML = '<h4>跨平台导出</h4>';
  } else {
    // Fallback floating action button if host menu is missing or delayed
    container.id = 'tavern-convert-fab';
    container.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99999;background:#333;color:#fff;padding:8px;border-radius:8px;';
    container.textContent = '跨平台导出';
  }

  const panel = document.createElement('div');
  panel.id = 'tavern-convert-status';
  panel.style.cssText = 'white-space:pre-wrap;font-size:0.9em;margin-top:4px;';
  // Render target export action buttons...
}
```

---

## Event Handling & Host Coexistence

1. **Stop Event Propagation**:
   Clicking export buttons inside the menu must not cause the host platform's dropdown or modal to close unexpectedly:
   ```javascript
   button.addEventListener('click', (event) => {
     event.preventDefault();
     event.stopPropagation();
     exportAs(target);
   });
   ```
2. **Download Lifecycle & Memory Cleanup**:
   When triggering file download via an invisible `<a download>` tag, schedule URL revocation to avoid leaking Blob memory:
   ```javascript
   function download(blob, filename) {
     const url = URL.createObjectURL(blob);
     const anchor = document.createElement('a');
     anchor.href = url;
     anchor.download = filename;
     document.body.appendChild(anchor);
     anchor.click();
     anchor.remove();
     // Revoke after 60 seconds once download has started
     setTimeout(() => URL.revokeObjectURL(url), 60_000);
   }
   ```

---

## Platform-Specific Notices in UI

- **SillyTavern Backup Caveat**: ST's `/api/users/backup` endpoint by design does not bundle `secrets.json`. The UI must explicitly inform users:
  ```
  已导出为 Luker 数据包。
  注意: SillyTavern 的备份端点不包含 secrets.json (API 密钥)，请用 tavern-convert CLI 处理含密钥的完整包。
  ```
- **Warnings Truncation**: Display the first 10 conversion warnings directly in the panel, with a count for any remainder.

---

## CSS Scoping Mandate (Luker UI 异常教训 · 2026-09-07)

**严禁全局选择器泄漏到宿主页面。** 插件 CSS 在宿主环境注入时，`*`、`body`、`:root`、页面级 `::-webkit-scrollbar` 会覆盖宿主主题与布局——实测曾把 Luker 的浅色主题变量 `--SmartThemeBodyColor` 覆盖为黑曜底色并把宿主 body 强制改为 flex 布局（即"Luker UI 变得很奇怪"的根因）。

约定：

1. **变量定义域**：所有 CSS 变量定义在双容器选择器上：
   ```css
   .app-container,            /* 独立 Web 模式挂载点 */
   .st-converter-drawer-app { /* 宿主插件模式挂载点 */
     --tavern-gold: #f59e0b;
     /* ... */
   }
   ```
2. **reset 范围**：通配 reset 只允许容器内前缀形式 `.app-container *, .st-converter-drawer-app *`。
3. **body 骨架**：独立模式页面背景/布局用 `body:has(> .app-container)`，插件模式绝不触碰宿主 body。
4. **滚动条**：页面级 `::-webkit-scrollbar` 必须写成容器后代选择器。
5. **新增样式自查**：任何新规则的选择器必须以 `.app-container` 或 `.st-converter-drawer-app` 开头（或两者组合），PR 前用 `grep -n "^body\|^:root\|^\*" style.css` 自查应为空。

## Host Detection Protocol (宿主识别协议 · 2026-09-07)

Luker 前端**同时暴露** `globalThis.SillyTavern`（script.js:360 `= lukerApi`）与 `globalThis.lukerContext`（scripts/lukerContext.js）。`window.luker` 与 `#luker-app` 在 Luker 实例中不存在（死信号）。判定协议：

1. **前端判定（detectHost）**：`globalThis.lukerContext` 存在（try/catch 惰性 getter）→ luker；否则 `SillyTavern` 存在或 `#extensionsMenu` → st；否则 standalone。**顺序不可颠倒。**
2. **服务端校验（verifyHostPlatform）**：`GET /version`。Luker 形状 `{agent:"Luker:2.7.0:...", stCompatVersion, pkgVersion}`；ST 形状 `{version}` 或 `{agent:"SillyTavern:..."}`。`agent` 前缀或 `stCompatVersion` 字段存在 → luker。不一致以服务端为准并 logger.warn。
3. **导出后软校验（validateBackupShape）**：Luker 导出含 manifest.json，ST 导出不含；不一致仅告警不阻断。
4. **ST 宿主 selection 限制**：ST `/api/users/backup` 全量 glob 导出忽略 selection 参数——ST 宿主必须请求 `FULL_SELECTION`，类目勾选由插件内 transform 过滤生效；Luker 直接透传 selection。

---

## Dual-Template Sync Mandate (2026-09-07)

The standalone web page (`index.html`) and the plugin drawer template (`src/ui/workbench-template.js`) are **two separately maintained copies** of the same UI structure. `index.html` is static — Vite does not process it through the template module. Any structural change (new element IDs, section reorganization) MUST be applied to **both** files in the same commit, or the standalone mode breaks (verified failure mode: archive-manager renders into a missing `#workspace-archive-list`, workspace drawer keeps the old dual-list markup).

Checklist for template changes:
1. Edit `src/ui/workbench-template.js`
2. Mirror the change in `index.html`
3. Grep both for the touched IDs: `grep -c "<new-id>" index.html src/ui/workbench-template.js` must both be ≥1
4. Playwright-verify standalone mode (`vite preview` + check the new ID exists in DOM)

## Export Queue Pattern (统一待导出区 · 2026-09-07)

All artifacts (host exports, conversions, delta patches, split volumes) flow into the in-memory `ExportQueue` (`src/ui/export-queue.js`) instead of directly saving to IndexedDB or triggering downloads:
- `enqueue({ blob, name, targetLayout, origin, ephemeral, autoDownload })` — ephemeral items only persist when stashed or downloaded (avoids duplicate storage);
- `stash()` writes to files store with the item's `origin` so the unified workspace list can badge it;
- Split-volume paths must enqueue with `origin: 'split-part'` (NOT call `saveFile` directly);
- `renderSplitDeliveryModal` is retained for compatibility but no longer wired to conversion flows.

### Escalation (2026-09-07 第二次诊断): bare native-class selectors are ALSO pollution

The CSS Scoping Mandate above was **incomplete** and the omission shipped to a real instance.
Beyond `:root`/`body`/`*`/scrollbar rules, **bare tavern-native class selectors** pollute the host too:
`.menu_button` (39 native rules), `.inline-drawer` (13), `.text_pole`, `.checkbox_label`, `.flex-container`, `.flex1`, `.badge`...
A plugin `<style>` with unscoped `.menu_button { ... }` restyles EVERY button of the host UI
(top bar included) — verified live: 5 computed-style diffs on host chrome from injected plugin CSS.

**Absolute rule**: EVERY class selector in `style.css` must be prefixed with
`.app-container ` (standalone ancestor) or `.st-converter-drawer-app ` (plugin mount).
No exceptions for "plugin-only-looking" classes — the host uses the same design system.
CI check: `grep '^\.' style.css | grep -vc 'app-container\|st-converter-drawer'` must print `0`.
