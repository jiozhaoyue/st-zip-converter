# Directory Structure (Trinity Web & Extension Architecture)

> How the "Trinity" web application (`st-zip-converter`) is organized: SillyTavern standard extension, local standalone web, and GitHub Pages deployment.

---

## Overview

`st-zip-converter` adopts a **Trinity Architecture**:
1. **SillyTavern / Luker Extension**: Git clone directly into `public/scripts/extensions/third-party/st-zip-converter`. SillyTavern loads `manifest.json` and imports root `index.js`.
2. **Local Standalone Application**: Run `npm start` (Vite dev server) to open `http://localhost:5173` for standalone desktop / browser conversion.
3. **GitHub Pages Web App**: Automated static site deployment via `.github/workflows/deploy.yml` with clean relative assets (`vite build --base=./`).

Key principles:
- **Zero Base64 Inlining**: Strictly avoid monolithic inline HTML. Maintain standard separated web files (`index.html`, `style.css`, `index.js`, `manifest.json`).
- **Standard ESM Modules**: Native browser ES modules loaded directly or bundled cleanly via Vite.
- **Adaptive Host Sniffing**: `src/ui/host-bridge.js` dynamically sniffs if running inside SillyTavern/Luker (mounting quick backup buttons in the host UI) or standalone web (showing file drag-and-drop zone).

---

## Directory Layout

```
st-zip-converter/
├── index.html              # Trinity semantic web interface (Native ST layout & standalone)
├── index.js                # ESM main entry & lifecycle controller
├── style.css               # 100% SillyTavern native controls & theme variables
├── manifest.json           # Standard SillyTavern extension manifest
├── src/
│   ├── core/               # Platform-agnostic conversion & delta engine
│   │   ├── builtin-assets.js   # Tavern native duplicate assets cleaner
│   │   ├── converter-worker.js # Dedicated Web Worker background compression thread
│   │   ├── delta.js            # Base-zip comparison & delta patch zip generator
│   │   ├── detect.js           # Layout detection (ST, L, TT, PT)
│   │   ├── filename-template.js# Dynamic filename template placeholder resolver
│   │   ├── inspect.js          # Zero-copy central directory preflight, category classification & backup chat matcher
│   │   ├── logger.js           # Centralized structured logger with level filtering & broadcast
│   │   ├── null-writer.js      # Null writer for dry-run inspection
│   │   ├── plan-preview.js     # Deep scan action prediction engine
│   │   ├── report.js           # Structured conversion reports
│   │   ├── splitter.js         # Standalone multi-volume zip chunking engine
│   │   ├── transform.js        # Core hub transform, routing rules & selection filtering
│   │   ├── worker-client.js    # Multi-threaded worker dispatcher with transparent fallback
│   │   └── zip-io.js           # Stream IO adapter (@zip.js/zip.js & fzstd Zstandard)
│   ├── storage/            # Client-side persistence
│   │   └── db.js               # IndexedDB storage layer for staging files & workspace state
│   ├── vendor/             # Self-contained zero-install engine dependencies
│   │   ├── fzstd.js            # Pure JS Zstandard decompressor for Method 93
│   │   └── zip.js              # Self-contained @zip.js/zip.js bundle
│   └── ui/                 # 100% Native SillyTavern in-drawer UI components
│       ├── archive-manager.js  # Staged archive workspace manager
│       ├── category-filter.js  # Category checkboxes & desensitization preset controls
│       ├── file-drop.js        # Drag-and-drop area & format inspection card
│       ├── file-tree-picker.js # Single-item file tree penetration picker
│       ├── host-bridge.js      # Host detection, in-drawer mounting, API calls & extension installer
│       ├── log-console.js      # Collapsible bottom real-time diagnostic console drawer
│       ├── split-deliver-modal.js # Multi-part download modal for cloud tavern constraints
│       ├── view.js             # Progress bar, report display accordion, and download trigger
│       └── workbench-template.js # Sub-inline-drawer workbench template (100% native ST styles)
├── fixtures/               # Deterministic fixture generation
│   └── gen.js
├── test/                   # Vitest unit & integration tests (19 test suites, 105 tests)
│   ├── advanced-controls.test.js
│   ├── backup-chats.test.js    # Backup chats & snapshot filtering tests
│   ├── builtin-assets.test.js
│   ├── convert.test.js
│   ├── delta.test.js           # Base-zip delta comparison & patch generation tests
│   ├── detect.test.js
│   ├── filename-template.test.js
│   ├── filter.test.js
│   ├── incremental-merge.test.js
│   ├── logger.test.js
│   ├── mirror.test.js
│   ├── plan.test.js
│   ├── plugin.test.js
│   ├── private-configs.test.js
│   ├── read-write.test.js
│   ├── real-samples.test.js
│   ├── splitter.test.js
│   ├── web-converter.test.js
│   └── zstd-method93.test.js
└── dist/                   # Production Vite build output (for GitHub Pages / distribution)
```

---

## Component Architecture

### 1. `src/ui/host-bridge.js`
- Checks `window.SillyTavern`, `window.luker`, or host DOM markers to determine environment.
- Inside SillyTavern / Luker: directly mounts the workbench inside `#extensions_settings2` / `#extensions_settings` using `.inline-drawer`. No popup modal required.
- Implements `setupDrawerToggles(root)` for collapsible nested sub-drawers with event bubbling isolation.
- Dispatches host `/api/users/backup` and handles CSRF tokens.
- Manages host extension discovery (`discoverHostExtensions`), shallow git installation (`installExtensionViaHost`), and anomaly detection (`checkHostThirdPartyAnomaly`).

### 2. `src/ui/workbench-template.js`
- 100% native SillyTavern design tokens and classes (`.inline-drawer`, `.inline-drawer-toggle`, `.inline-drawer-content`, `.text_pole`, `.menu_button`, `.checkbox_label`, `.extension_block`).
- 0 Emoji policy: strictly uses Font Awesome 6 classes (`fa-solid fa-...`).
- Divided into structured sub-drawers:
  - **Section 1**: Host Direct Export (细粒度类目选择、联动、备份聊天过滤、基准 ZIP 增量导出、直出格式、分包阈值).
  - **Section 2**: External Datapack Converter (文件上传、双向互转、轻量清单模式、历史备份过滤).
  - **Section 3**: Workspace Datapacks (本地 IndexedDB 双列表管理、历史存档回溯).
  - **Section 4**: Conversion & Audit Report (动态合成条目、迁移、丢弃明细折叠屏).

### 3. `src/core/delta.js` & Incremental Export
- Fast metadata-based comparison (`compareArchives`) inspecting entry filenames, uncompressed sizes, and CRC32s.
- Generates lightweight delta patch archives (`generateDeltaArchive`) containing only added and modified entries, along with an audit manifest (`_delta_manifest.json`).

### 4. `src/ui/log-console.js`
- Bottom collapsible diagnostic console drawer permanently listening to `logger` events.
- Features level filters (ALL, INFO, WARN, ERROR), real-time autoscroll, and one-click log copy / file export.
