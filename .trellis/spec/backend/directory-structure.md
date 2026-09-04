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
tavern-convert/
├── cli.js                  # CLI entry point (Node.js shebang, parseArgs, exit codes)
├── src/
│   ├── core/               # Platform-agnostic conversion & transform engine
│   │   ├── detect.js       # Format layout detection (ST, L, TT, PT)
│   │   ├── null-writer.js  # Null writer for dry-run inspection without disk writes
│   │   ├── read.js         # Streaming zip reader abstraction
│   │   ├── report.js       # Transformation report and structured statistics
│   │   ├── transform.js    # Core conversion pipeline (hub normalization + target adapter)
│   │   └── write.js        # Streaming zip writer abstraction
│   └── io/                 # Runtime-specific IO adapter implementations
│       ├── node-io.js      # Node.js runtime adapter (yauzl / yazl lazy streams)
│       └── zipjs-io.js     # Universal/Browser runtime adapter (@zip.js/zip.js)
├── fixtures/               # Generated test fixture packages for all 4 layouts
│   └── gen.js              # Fixture generator script
├── test/                   # Vitest unit, integration, mirror, and parity tests
│   ├── convert.test.js     # Transformation rules & matrix unit tests
│   ├── detect.test.js      # Format detection unit tests
│   ├── mirror.test.js      # Platform import router mirroring tests
│   ├── plugin.test.js      # Plugin bundle smoke tests
│   ├── read-write.test.js  # Zip read/write roundtrip tests
│   ├── real-samples.test.js# Real dataset routing verification
│   ├── roundtrip.test.js   # CRC32 roundtrip integrity tests
│   ├── termux.test.js      # Termux compatibility & 192MiB V8 heap tests
│   ├── verify-secrets.mjs  # Cryptographic secret preservation verification
│   └── zipjs-io.test.js    # zip.js vs node.js IO bit-parity tests
└── out/                    # Converted artifacts and dry-run execution reports
```

---

## Module Organization

### 1. `src/core/`
- **Zero runtime bindings**: Must NOT directly import Node `fs`, `path` (use POSIX zip path conventions `/`), or browser globals.
- **Pure contract**: Accepts generic `io` adapter adhering to `{ detectLayout, ZipReader, ZipWriter, NullZipWriter }`.
- **Determinism**: Synthetic entries (e.g. `manifest.json`, `_tauritavern/extension-sources/`) must be sorted deterministically and placed at the tail of the archive with fixed timestamps (`2020-01-01T00:00:00.000Z`).

### 2. `src/io/`
- Encapsulates zip engine specific APIs:
  - `node-io.js`: Uses `yauzl` for reading and `yazl` with `addReadStreamLazy` for writing to prevent thread pool congestion.
  - `zipjs-io.js`: Uses `@zip.js/zip.js` with `BlobReader` and `BlobWriter`.
- Both must produce bit-for-bit or entry-for-entry identical output (verified by `test/zipjs-io.test.js`).

### 3. `cli.js`
- Parses CLI flags via Node.js built-in `util.parseArgs` (zero external CLI framework dependencies).
- Formats reports for human terminal output or machine-readable JSON (`--json`).
- Handles process exit codes: `0` (success), `1` (conversion failure), `2` (CLI usage error).

---

## Naming Conventions

- **Files & Folders**: Lowercase kebab-case for multi-word filenames (e.g., `node-io.js`, `null-writer.js`, `read-write.test.js`).
- **Constants**: Screaming snake case (`TARGETS`, `LAYOUTS`, `FULL_SELECTION`, `FIXED_TIMESTAMP`).
- **Zip Archive Paths**: Always forward slashes `/`, never Windows backslashes `\`. Always strip leading slashes.
