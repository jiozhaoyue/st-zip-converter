# Directory Structure (Tavern In-App Plugins)

> How in-app browser plugins for SillyTavern and Luker are organized and built.

---

## Overview

The "frontend" layer consists of browser extensions injected directly into SillyTavern and Luker web interfaces. They provide in-app export buttons allowing users to download backups transformed on-the-fly to another platform's format without using the CLI.

Key principles:
- **Shared Codebase**: Both SillyTavern and Luker plugins share `src/plugins/plugin.js`. Platform specifics are injected at build-time via esbuild `define`.
- **Zero External Dependencies**: Bundles are standalone IIFEs (~158 KiB) with all `@zip.js/zip.js` code and deflater WASM base64-inlined. No internet access or CDN imports needed.
- **Isomorphic Core**: The plugin executes the identical transformation rules (`src/core/transform.js`) used by the CLI, swapped only with `src/io/zipjs-io.js`.

---

## Directory Layout

```
tavern-convert/
├── src/
│   ├── plugins/
│   │   ├── build.mjs       # esbuild build script for ST & Luker targets
│   │   └── plugin.js       # Shared browser plugin source logic & UI mounting
│   └── io/
│       └── zipjs-io.js     # Universal IO adapter backed by @zip.js/zip.js
└── dist/
    └── plugins/
        ├── st/             # Built plugin for SillyTavern
        │   ├── index.js    # Self-contained IIFE bundle
        │   └── manifest.json
        └── luker/          # Built plugin for Luker
            ├── index.js    # Self-contained IIFE bundle
            └── manifest.json
```

---

## Module Organization & Build Pipeline

### 1. Source Logic (`src/plugins/plugin.js`)
- Handles DOM detection, UI injection into `#extensionsMenu`, fallback floating action button, status display, and triggering file downloads via `URL.createObjectURL(blob)`.
- Calls platform backup endpoints (`POST /api/users/backup`) with appropriate CSRF headers.

### 2. Build Pipeline (`src/plugins/build.mjs`)
- Run with `npm run build:plugins`.
- Uses `esbuild` to compile two targets:
  - Target 1: `dist/plugins/st/index.js` with `__TAVERN_CONVERT_PLATFORM__ = 'st'`
  - Target 2: `dist/plugins/luker/index.js` with `__TAVERN_CONVERT_PLATFORM__ = 'luker'`
- Copies and formats `manifest.json` for each respective platform.

---

## Naming & Artifact Conventions

- **Entrypoints**: Every plugin distribution folder must contain an `index.js` and a valid `manifest.json`.
- **Platform Identifiers**: `'st'` for SillyTavern, `'luker'` for Luker.
- **Exported File Names**: Follows `${platform}-to-${target}-${YYYY-MM-DD-HH-mm-ss}.zip`.
