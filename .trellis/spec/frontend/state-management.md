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

---

## Long-Task State: TaskManager + OPFS Half-Products (2026-09-07)

Long tasks (host fetch / convert / restore) are managed by `src/core/task-manager.js`
(pure state machine, adapter-injected persistence) with UI controls in
`src/ui/task-controls.js`. State: `running | paused | aborted | done | failed`.

### OPFS half-product lifecycle (fetch tasks)
- Streaming fetch writes to OPFS `fetch-tmp/<taskId>.zip` — never buffer GB-scale
  bodies in memory (`chunks.push` + `new Blob(chunks)` is the old anti-pattern).
- **Pause semantics**: close the writable (do NOT abort) so the half-file survives;
  checkpoint `{ receivedBytes, totalBytes, opfsName }` persists via the adapter.
- **Resume**: try `Range: bytes=<received>-` first; a non-206 response means the
  endpoint does not support ranges → discard the half-file and refetch from zero.
- **Abort/discard**: `removeEntry` the temp file. Success: downstream consumes the
  File via `getFile()` (zip.js natively accepts File), then cleanup.
- Catch-block cleanup must reference variables declared OUTSIDE the `try` — an
  `opfsName` declared inside `try` hits a TDZ ReferenceError in the error path.

### Shared Worker + AbortSignal trap (bit us 2026-09-07)
`worker-client.js` reuses ONE `Worker` instance. On pause/abort we call
`worker.terminate()` — a terminated Worker ignores all future `postMessage`.
**Rule**: after `terminate()`, set `workerInstance = null` so the next task
rebuilds a fresh Worker. Forgetting this hangs every subsequent conversion forever
(no error, just silence). AbortSignal itself cannot be `postMessage`d — strip it
from serialized options and listen on the main thread instead.
