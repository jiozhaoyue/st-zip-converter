# Directory Structure (Core Engine & CLI)

> How the core conversion engine, stream IO layer, and CLI entrypoint are organized.

---

## Overview

The backend/core of `tavern-convert` is a streaming data transformation pipeline and Node CLI utility designed to convert exported backup zip archives among four tavern-family platforms (SillyTavern, Luker, PureTavern, and TauriTavern).

Key design principles:
- **Streaming & Low Memory**: Avoid loading whole zip archives into memory. Peak memory is bounded by the largest single uncompressed file (approx. 74–250 MiB even on 900+ MiB zip archives).
- **IO Decoupling**: Core business and routing logic (`src/core/`) is decoupled from runtime IO via adapters (`src/io/`).
- **Hub & Spoke Routing**: All four formats map into an internal canonical "hub" layout (flattened SillyTavern structure), and then project out to the target layout.

---

## Directory Layout

```
st-zip-converter/
├── index.html              # Trinity web entry point (SillyTavern in-drawer / Standalone / GitHub Pages)
├── index.js                # Top-level ESM controller & lifecycle coordinator
├── style.css               # 100% SillyTavern native styling & theme variable inheritance
├── manifest.json           # Standard SillyTavern third-party extension manifest
├── src/
│   ├── core/               # Platform-agnostic conversion & transform engine
│   │   ├── builtin-assets.js   # Tavern native duplicate asset cleaner
│   │   ├── converter-worker.js # Dedicated Web Worker background compression thread
│   │   ├── delta.js            # Base-zip comparison & delta patch zip generator
│   │   ├── detect.js           # Format layout detection (ST, L, TT, PT)
│   │   ├── filename-template.js# Dynamic filename template placeholder resolver
│   │   ├── inspect.js          # Zero-copy central directory preflight, category aggregation & backup chat matcher
│   │   ├── logger.js           # Structured logger with level filtering and UI subscriptions
│   │   ├── null-writer.js      # Null writer for dry-run inspection without disk writes
│   │   ├── plan-preview.js     # Deep scan action prediction engine
│   │   ├── report.js           # Transformation report and structured statistics
│   │   ├── splitter.js         # Standalone multi-volume zip chunking engine
│   │   ├── transform.js        # Core conversion pipeline (hub normalization + target adapter + selection filter)
│   │   ├── worker-client.js    # Client worker manager with transparent Node fallback
│   │   └── zip-io.js           # Universal standard zip IO adapter (@zip.js/zip.js & fzstd)
│   ├── storage/            # Client-side persistence
│   │   └── db.js               # IndexedDB storage layer for staging files & workspace state
│   ├── vendor/             # Self-contained zero-install engine dependencies
│   │   ├── fzstd.js            # Pure JS Zstandard decompressor for Method 93
│   │   └── zip.js              # Self-contained @zip.js/zip.js bundle
│   └── ui/                 # 100% Native SillyTavern in-drawer UI components
│       ├── archive-manager.js  # Staged archive workspace manager
│       ├── category-filter.js  # Category checkboxes & desensitization preset controls
│       ├── file-drop.js        # Drag-and-drop file upload & format detection card
│       ├── file-tree-picker.js # Single-item file tree penetration picker
│       ├── host-bridge.js      # Host sniffing, in-drawer mounting, API calls & extension installer
│       ├── log-console.js      # Collapsible bottom real-time diagnostic console drawer
│       ├── split-deliver-modal.js # Multi-part download modal for cloud tavern constraints
│       ├── view.js             # Progress bar, report display accordion, and download trigger
│       └── workbench-template.js # Sub-inline-drawer workbench template (100% native ST styles)
├── fixtures/               # Generated test fixture packages for all 4 layouts
│   └── gen.js              # Fixture generator script
├── test/                   # Vitest unit, integration, mirror, and web engine tests (19 suites, 105 tests)
│   ├── advanced-controls.test.js
│   ├── backup-chats.test.js    # Backup chats & snapshot filtering tests
│   ├── builtin-assets.test.js
│   ├── convert.test.js         # Transformation rules & matrix unit tests
│   ├── delta.test.js           # Base-zip delta comparison & patch generation tests
│   ├── detect.test.js          # Format detection unit tests
│   ├── filename-template.test.js
│   ├── filter.test.js          # Preflight and desensitization tests
│   ├── incremental-merge.test.js
│   ├── logger.test.js
│   ├── mirror.test.js          # Platform import router mirroring tests
│   ├── plan.test.js
│   ├── plugin.test.js          # Plugin manifest & web assets structure tests
│   ├── private-configs.test.js
│   ├── read-write.test.js      # Zip read/write roundtrip tests
│   ├── real-samples.test.js    # Real dataset routing verification
│   ├── roundtrip.test.js       # CRC32 roundtrip integrity tests
│   ├── splitter.test.js
│   ├── web-converter.test.js   # Pure web Blob-to-Blob conversion tests
│   └── zstd-method93.test.js
└── dist/                   # Production Vite build output (for GitHub Pages / distribution)
```

---

## Module Organization

### 1. `src/core/`
- **Zero Node.js runtime bindings**: Relies purely on Web APIs (`Blob`, `Uint8Array`, `TransformStream`, `TextDecoder`) and `@zip.js/zip.js`.
- **Pure contract**: Accepts generic `io` adapter adhering to `{ openReader, createWriter }`, defaulting to `zipIo`.
- **Determinism**: Synthetic entries (e.g. `manifest.json`, `_tauritavern/extension-sources/`, `_delta_manifest.json`) must be sorted deterministically and placed at the tail of the archive with fixed timestamps (`2020-01-01T00:00:00.000Z`).
- **Delta Engine (`delta.js`)**: Compares metadata against an external base ZIP and extracts only added and modified entries into a lightweight delta patch archive.
- **Splitter Engine (`splitter.js`)**: Partitions large archives into multiple standalone valid zip packages under a configurable size threshold (e.g. 100 MB), avoiding corrupted `.z01` slice files.

### 2. `src/core/zip-io.js`
- Encapsulates universal zip IO:
  - Supports browser `Blob` / `File` as input and `zip.BlobWriter` as output.
  - Supports Node.js file path strings transparently for test suites and headless benchmarks.
  - Transparently decompresses 7-Zip ZS / TauriTavern Method 93 (Zstandard in Zip) via pure JS `fzstd`.
  - Implements an internal sequential Promise queue to prevent concurrent stream write contention on the same zip file.
  - Automatically deduplicates duplicate entries to ensure archive integrity.

### 3. `src/ui/`
- `host-bridge.js`: Detects whether running inside SillyTavern / Luker environment or standalone web. Mounts directly into the extension settings drawer (`#extensions_settings2` / `#extensions_settings`) without modal popups. Manages CSRF tokens, shallow git extension installations, and automated `/api/users/backup` export triggers.
- `workbench-template.js`: 100% native SillyTavern design tokens, zero emojis (Font Awesome 6 only), structured into collapsible sub-drawers (`.inline-drawer`).
- `view.js`: Progress bars, live state management, report details, and blob download dispatching.

---

## Naming Conventions

- **Files & Folders**: Lowercase kebab-case for multi-word filenames (e.g., `node-io.js`, `null-writer.js`, `read-write.test.js`).
- **Constants**: Screaming snake case (`TARGETS`, `LAYOUTS`, `FULL_SELECTION`, `FIXED_TIMESTAMP`).
- **Zip Archive Paths**: Always forward slashes `/`, never Windows backslashes `\`. Always strip leading slashes.
