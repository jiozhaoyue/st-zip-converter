# Hook & Lifecycle Guidelines (Host Integration)

> Host platform lifecycle integration, backup API hooks, and CSRF authentication.

---

## Overview

In the browser plugin context, "hooks" refer to host application integration points, lifecycle event listeners, and API endpoints rather than React hooks.

---

## Host Lifecycle & Bootstrapping

Extensions can be loaded either at initial page boot or dynamically injected at runtime. The initialization hook must handle both scenarios safely:

```javascript
// Check document existence (ensures node-based test environments do not trigger DOM code)
if (typeof document !== 'undefined') {
  const bootstrap = () => mountUi();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    // Host page is already loaded (e.g., dynamic plugin reload)
    bootstrap();
  }
}
```

---

## Host Platform API Hooks

### 1. CSRF Token & User Handle Retrieval
Host endpoints require authenticated sessions and CSRF protection:

```javascript
async function getCsrfToken() {
  const response = await fetch('/csrf-token', { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`获取 CSRF token 失败: ${response.status}`);
  const data = await response.json();
  return data.token;
}

async function getHandle() {
  const response = await fetch('/api/users/me', { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`获取当前用户失败: ${response.status}`);
  const data = await response.json();
  return data.handle;
}
```

### 2. Backup Extraction Hook (`POST /api/users/backup`)
- **Luker Hook**: Accepts a `selection` payload. We explicitly pass `FULL_SELECTION` (including `secrets: true` and `globalExtensions: true`).
- **SillyTavern Hook**: Does not accept selection filtering; sends `{ handle }`. Secrets are excluded by SillyTavern server defaults.

---

## Global Diagnostic & Testing Hook

To enable automation, testing, and debugging in browser devtools, the plugin must register its functions on `globalThis`:

```javascript
globalThis.__tavernConvert = {
  convertBackup,
  fetchBackupBlob,
  PLATFORM,
};
```

This hook enables non-DOM smoke testing (`test/plugin.test.js`) and console-based backup automation.

---

## Forbidden Patterns

- ❌ Assuming `DOMContentLoaded` will fire (fails when extension is loaded asynchronously after page load).
- ❌ Hardcoding user handles (always resolve dynamically via `/api/users/me`).
- ❌ Omitting `{ credentials: 'same-origin' }` on fetch requests.
