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
