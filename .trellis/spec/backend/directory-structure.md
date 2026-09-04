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
├── index.html              # Trinity web entry point (SillyTavern modal / Standalone / GitHub Pages)
├── index.js                # Top-level ESM controller & lifecycle coordinator
├── style.css               # Responsive SillyTavern dark/light style sheet
├── manifest.json           # Standard SillyTavern third-party extension manifest
├── src/
│   ├── core/               # Platform-agnostic conversion & transform engine
│   │   ├── detect.js       # Format layout detection (ST, L, TT, PT)
│   │   ├── inspect.js      # Zero-copy central directory preflight & category aggregation
│   │   ├── null-writer.js  # Null writer for dry-run inspection without disk writes
│   │   ├── report.js       # Transformation report and structured statistics
│   │   ├── transform.js    # Core conversion pipeline (hub normalization + target adapter + selection filter)
│   │   ├── zip-io.js       # Universal standard zip IO adapter (@zip.js/zip.js)
│   │   ├── converter-worker.js # Dedicated Web Worker background compression thread
│   │   └── worker-client.js# Client worker manager with transparent Node fallback
│   └── ui/                 # UI components and host bridge
│       ├── host-bridge.js  # Host sniffing (SillyTavern extension vs standalone web)
│       ├── file-drop.js    # Drag-and-drop file upload & format detection card
│       ├── category-filter.js # Category checkboxes & desensitization preset controls
│       └── view.js         # Progress bar, report display accordion, and download trigger
├── fixtures/               # Generated test fixture packages for all 4 layouts
│   └── gen.js              # Fixture generator script
├── test/                   # Vitest unit, integration, mirror, and web engine tests
│   ├── convert.test.js     # Transformation rules & matrix unit tests
│   ├── detect.test.js      # Format detection unit tests
│   ├── mirror.test.js      # Platform import router mirroring tests
│   ├── plugin.test.js      # Plugin manifest & web assets structure tests
│   ├── read-write.test.js  # Zip read/write roundtrip tests
│   ├── real-samples.test.js# Real dataset routing verification
│   ├── roundtrip.test.js   # CRC32 roundtrip integrity tests
│   ├── verify-secrets.mjs  # Cryptographic secret preservation verification
│   └── web-converter.test.js # Pure web Blob-to-Blob conversion tests
└── out/                    # Converted artifacts and dry-run execution reports
```

---

## Module Organization

### 1. `src/core/`
- **Zero Node.js runtime bindings**: Relies purely on Web APIs (`Blob`, `Uint8Array`, `TransformStream`, `TextDecoder`) and `@zip.js/zip.js`.
- **Pure contract**: Accepts generic `io` adapter adhering to `{ openReader, createWriter }`, defaulting to `zipIo`.
- **Determinism**: Synthetic entries (e.g. `manifest.json`, `_tauritavern/extension-sources/`) must be sorted deterministically and placed at the tail of the archive with fixed timestamps (`2020-01-01T00:00:00.000Z`).

### 2. `src/core/zip-io.js`
- Encapsulates universal zip IO:
  - Supports browser `Blob` / `File` as input and `zip.BlobWriter` as output.
  - Supports Node.js file path strings transparently for test suites and headless benchmarks.
  - Implements an internal sequential Promise queue to prevent concurrent stream write contention on the same zip file.
  - Automatically deduplicates duplicate entries to ensure archive integrity.

### 3. `src/ui/`
- `host-bridge.js`: Detects whether running inside SillyTavern / Luker iframe/parent environment or standalone web. Manages CSRF tokens and automated `/api/users/backup` export triggers.
- `file-drop.js`: Drag-and-drop file target and dynamic layout detection card.
- `view.js`: Progress bars, live state management, report details, and blob download dispatching.

---

## Naming Conventions

- **Files & Folders**: Lowercase kebab-case for multi-word filenames (e.g., `node-io.js`, `null-writer.js`, `read-write.test.js`).
- **Constants**: Screaming snake case (`TARGETS`, `LAYOUTS`, `FULL_SELECTION`, `FIXED_TIMESTAMP`).
- **Zip Archive Paths**: Always forward slashes `/`, never Windows backslashes `\`. Always strip leading slashes.
