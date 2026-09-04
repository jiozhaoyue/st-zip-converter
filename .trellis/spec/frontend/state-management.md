# State & Memory Management (Browser Plugins)

> In-memory blob lifecycle, conversion state progression, and memory leak prevention.

---

## Overview

The browser plugin is stateless across page reloads. Its runtime state consists entirely of:
1. **Ephemeral UI State**: Button click status, progress text, warning readout.
2. **In-Flight Stream & Blob State**: The lifecycle of the input backup blob and output target blob during `convertBackup`.

---

## State Lifecycle of an Export Operation

```
Idle -> Fetching (/api/users/backup) -> Converting (zip.js) -> Downloading (anchor.click) -> Revocation (60s) -> Idle
```

1. **Idle**: UI buttons enabled, status panel empty.
2. **Busy / In-Flight**:
   - Status updated: `setStatus('正在导出为${label}…')`
   - User interactions guarded against double-clicking during conversion.
3. **Completion**:
   - Download triggered via `URL.createObjectURL(blob)`.
   - Status updated with summary, secrets warnings, and platform notices.
4. **Cleanup**:
   - `URL.revokeObjectURL(url)` scheduled via timeout.
   - Reader and Writer resources released.

---

## Memory Leak Prevention in Long-Running Tabs

Users often keep SillyTavern or Luker browser tabs open for days. Accumulating zip blobs in memory can trigger browser tab crashes:

### 1. No Global Blob Retention
- ❌ Do NOT store `Blob` or `ArrayBuffer` in global variables:
  ```javascript
  // FORBIDDEN
  window.lastExportedBlob = blob;
  ```
- ✅ Scope Blobs strictly within the `exportAs` async function scope.

### 2. Timed Object URL Revocation
Object URLs hold references to the underlying Blobs in browser memory until explicitly revoked:
```javascript
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke after 60s allows sufficient time for browser download manager
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
```

### 3. Streamed Reading via `@zip.js/zip.js`
- Use `BlobReader` instead of reading blobs into `ArrayBuffer` via `blob.arrayBuffer()`.
- Use `BlobWriter` to write chunks directly into the browser's blob store without holding intermediate byte arrays in JS heap.
