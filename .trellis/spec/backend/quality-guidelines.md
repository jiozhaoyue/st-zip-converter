# Quality Guidelines (Core & CLI)

> Verification standards, testing matrix, memory limits, and forbidden patterns.

---

## Overview

Because `tavern-convert` operates on critical user data (chat histories, character cards, persona images, API secrets), code correctness, data preservation, and memory safety are paramount.

---

## Testing Matrix

All changes touching `src/core/`, `src/io/`, or `cli.js` must pass the full verification matrix:

| Test Category | Command / File | Purpose |
|---|---|---|
| Unit & Integration | `npm test` | All 58 Vitest tests across read/write, convert, detect, mirror, termux, zipjs-io. |
| Secrets Integrity | `node test/verify-secrets.mjs` | Verifies cryptographic byte-equality for `secrets.json` across all converted outputs. |
| Parity Assurance | `vitest run test/zipjs-io.test.js` | Guarantees that Node.js IO (`yauzl`/`yazl`) and Browser IO (`zip.js`) produce identical output entries. |
| Heap Budget | `vitest run test/termux.test.js` | Enforces execution within 192 MiB V8 max old space (Termux / low-end environments). |

---

## Forbidden Patterns

1. **Direct Node Imports in `src/core/`**:
   - ❌ `import fs from 'node:fs'` inside `src/core/`
   - ✅ Inject filesystem and zip handlers via `options.io`.
2. **Buffer Accumulation**:
   - ❌ `yazl.addBuffer` during streaming batch conversions.
   - ❌ Reading whole zip archives into `ArrayBuffer` or `Buffer`.
   - ✅ `zipfile.addReadStreamLazy` with sequential deferred pulling.
3. **Platform Path Separators in Zip Entries**:
   - ❌ Using `path.join(...)` on Windows which yields `\` in zip paths.
   - ✅ Always normalize to forward slashes `/`. Strip leading slashes.
4. **Altering User Secrets**:
   - ❌ Filtering, masking, or stripping `secrets.json`.
   - ✅ Unconditionally preserve `secrets.json` byte-for-byte.

---

## Required Patterns

1. **POSIX Path Normalization**:
   ```javascript
   const normalized = entryPath.replace(/\\/g, '/').replace(/^\/+/, '');
   ```
2. **Deterministic Synthetic Metadata**:
   All synthesized entries (such as `manifest.json`, `extension-sources/`) must use fixed timestamps and alphabetical sorting so identical inputs yield identical archive hashes.
3. **Safe Central Directory Scanning**:
   Always close and re-open `yauzl` when switching from layout detection to file transformation.

---

## Pre-Development Checklist

Before modifying `src/core/` or `cli.js`:
- [ ] Read `.trellis/spec/guides/tavern-datapack-formats.md` to review layout contracts.
- [ ] Ensure any new target or transformation rule handles user secrets without modification.
- [ ] Confirm no Node-specific APIs are introduced into `src/core/`.

---

## Quality Check

After code changes:
- [ ] Run `npm test` and verify zero failures.
- [ ] Check peak memory consumption with `--json`.
- [ ] Verify `node test/verify-secrets.mjs` exits 0.

---

## Zip IO Concurrency Mandate (2026-09-07)

**zip-io.js 写入管线禁止重新引入串行队列。** 实测结论（见 tasks/archive/2026-09/09-07-perf-overhaul/research/）：

1. vendor zip.js `ZipWriter.add` 原生支持并发调用（内部自带互斥），并发 50 条目字节级校验一致。旧的 `queue.then(task)` 串行链是"一个一个文件处理"的根因（浏览器实测 2.8x 提速来自移除它）。
2. 并发度 = `min(8, max(2, hardwareConcurrency))`，`waitForSlot()` 背压：在飞条目达上限时 `Promise.race(inflight)` 等任一完成。
3. 首条目保序：第一个 add/addLazy 独占写入完成后才放开并发（恢复端 manifest 处理依赖包首条目）。
4. **禁止预压缩注入**：手动 `deflate-raw` 后以 `compressionMethod:8 + level:0` 传入会产生损坏包；vendor 写端 `passThrough` 需要调用方提供 `uncompressedSize`+`crc32`，内存场景不值得。
5. 大 Blob IndexedDB 写入（≥16MB）走 `saveFile` 内部串行队列，与转换热路径解耦。
6. Node/Vitest 环境 Worker 不生效（基准不反映浏览器收益），性能验证必须用 Playwright 浏览器基准。
