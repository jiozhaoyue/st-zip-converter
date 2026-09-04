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
