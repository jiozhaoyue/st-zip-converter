# Datapack Storage & Streaming Archive Guidelines

> Data persistence, archive layouts, streaming IO contracts, and secret preservation.

---

## Overview

This project does not use a relational database or SQL/NoSQL engine. The primary "storage" entities are zip backup packages exported by four tavern platforms:
1. **SillyTavern (ST)**: Root-flattened directory layout with no manifest.
2. **Luker (L)**: ST-compatible flattened layout with an auxiliary `manifest.json` (`schemaVersion: 1`).
3. **TauriTavern (TT)**: Hierarchical `data/` root, user files in `data/default-user/`, system files in `data/_tauritavern/`.
4. **PureTavern (PT)**: Expects TT-compatible layout (`data/default-user/`) or proprietary module archives. Cannot import flattened archives.

---

## Streaming IO & Memory Budget

### 1. Lazy Stream Writing
- **Never buffer the entire zip in memory**: Zip packages often exceed 1 GiB.
- **Avoid `yazl.addBuffer` during batch conversion**: In Node.js, `yazl.addBuffer` dispatches asynchronous `deflateRaw` requests without backpressure, queuing buffers in memory and blowing heap limits (previously peaked at 884 MiB).
- **Rule**: Always use `yazl.addReadStreamLazy` with deferred stream acquisition:
  ```javascript
  zipfile.addReadStreamLazy(entryName, {
    mtime: entry.mtime,
    mode: entry.mode,
  }, (cb) => {
    // Open lazy read stream only when yazl is ready to consume
    cb(null, entry.openReadStream());
  });
  ```
- **Heap Guarantee**: Maintains a working memory footprint of 74–250 MiB on multi-gigabyte archives. Must run cleanly under a 192 MiB V8 heap limit (verified by `test/termux.test.js`).

### 2. Cursor Restrictions in `yauzl`
- `yauzl` streams through the zip Central Directory sequentially.
- **Rule**: Central Directory cursors cannot be rewound. Therefore:
  - Format detection (`detectLayout`) and main conversion (`convert`) must open the zip file in separate independent passes.
  - Never attempt to read entries while scanning directory metadata in the same pass.

---

## Storage & Persistence Policies

### 1. Secrets Preservation (Non-negotiable)
- `secrets.json` containing API keys (OpenAI, Claude, NovelAI, etc.) MUST NEVER be discarded, filtered, or altered in any conversion direction.
- Bit-level identity is strictly verified in test suite (`test/verify-secrets.mjs`).

### 2. Derived Cache Discard Rules
- To save space and avoid cross-platform stale cache corruption, derived caches are stripped by default:
  - `thumbnails/`, `backups/`, `vectors/`
  - `data/_cache/`, `data/_css/`, `data/_errors/`
  - `content.log`, `user/cache/`
- When `--keep-all` is passed, these entries are preserved.

### 3. Extension Migration
- **PT Target**: PureTavern strictly drops user-level `extensions/`. The converter transforms `extensions/<name>/` into `data/extensions/third-party/<name>/` and generates synthetic `data/_tauritavern/extension-sources/<name>.json`.
- Root-level loose files in `third-party/` or orphaned metadata are dropped to prevent crash loops.

---

## Common Pitfalls & Anti-patterns

- **Forbidden**: `fs.readFileSync(zipPath)` or loading complete archives into memory.
- **Forbidden**: Modifying entry CRC32 or byte contents during non-transform passes.
- **Forbidden**: Amending manifest timestamps dynamically (use constant epoch `2020-01-01T00:00:00.000Z` for bit-for-bit reproducibility).
