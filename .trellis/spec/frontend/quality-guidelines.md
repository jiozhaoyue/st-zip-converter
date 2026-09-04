# Quality Guidelines (Browser Plugins)

> Quality standards, bundle verification, IO parity testing, and build constraints.

---

## Overview

The browser plugins run within untrusted third-party host environments (SillyTavern and Luker) on user machines. They must be robust, lightweight, self-contained, and bit-compatible with the CLI.

---

## Verification Matrix

| Check | Command / File | Standard |
|---|---|---|
| Plugin Build | `npm run build:plugins` | Bundles `dist/plugins/{st,luker}/{index.js,manifest.json}` without errors. |
| Smoke Tests | `vitest run test/plugin.test.js` | Validates bundle IIFE execution, platform variable injection, and manifest schema. |
| Engine Parity | `vitest run test/zipjs-io.test.js` | Confirms that `@zip.js/zip.js` produces entry-for-entry identical MD5 outputs to Node `yauzl`/`yazl`. |
| Bundle Budget | Inspection of `dist/plugins/*/index.js` | File size must remain strictly under 200 KiB (current size ~158 KiB). |

---

## Forbidden Patterns

1. **Dynamic External Loading**:
   - ❌ Fetching scripts, stylesheets, or WASM binaries from external CDNs (e.g. unpkg, cdnjs).
   - ✅ Inlining all dependencies (including zip.js base64 WASM) directly inside the bundle.
2. **Polluting Host Global Namespace**:
   - ❌ Leaking intermediate helper functions into `window`.
   - ✅ Confining globals strictly to `globalThis.__tavernConvert` and wrapping in an IIFE.
3. **Unprotected DOM Access**:
   - ❌ Running DOM queries or mutations unconditionally at the module top level.
   - ✅ Guarding with `if (typeof document !== 'undefined')`.

---

## Pre-Development Checklist

Before modifying `src/plugins/`:
- [ ] Ensure any new DOM elements use the `tavern-convert-` namespace.
- [ ] Confirm no new external npm runtime dependencies are introduced that inflate bundle size past 200 KiB.
- [ ] Verify that UI changes work gracefully when `#extensionsMenu` is absent.

---

## Quality Check

After plugin code changes:
- [ ] Run `npm run build:plugins`.
- [ ] Run `npm test` (all 58 tests must pass, especially `plugin.test.js` and `zipjs-io.test.js`).
- [ ] Check bundle sizes in `dist/plugins/` to ensure no sudden size regressions.
