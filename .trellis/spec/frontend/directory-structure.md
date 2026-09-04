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
├── index.html              # Trinity semantic web interface
├── index.js                # ESM main entry & lifecycle controller
├── style.css               # SillyTavern dark/light responsive styles
├── manifest.json           # Standard SillyTavern extension manifest
├── src/
│   ├── core/               # Pure Web conversion engine
│   │   ├── detect.js       # Layout detection (ST, L, TT, PT)
│   │   ├── null-writer.js  # Null writer for dry-run inspection
│   │   ├── report.js       # Structured conversion reports
│   │   ├── transform.js    # Core hub transform & routing rules
│   │   └── zip-io.js       # Stream IO adapter (@zip.js/zip.js)
│   └── ui/                 # UI components and host bridge
│       ├── host-bridge.js  # Host detection (SillyTavern vs standalone) & backup API
│       ├── file-drop.js    # Drag-and-drop area & format inspection card
│       └── view.js         # Progress bar, report display accordion, and download trigger
├── fixtures/               # Deterministic fixture generation
│   └── gen.js
├── test/                   # Vitest unit & integration tests
│   ├── plugin.test.js      # Extension structure and manifest validation
│   └── web-converter.test.js # Pure web Blob-to-Blob conversion verification
└── dist/                   # Production Vite build output (for GitHub Pages / distribution)
```

---

## Component Architecture

### 1. `src/ui/host-bridge.js`
- Checks `window.SillyTavern` or host DOM markers to determine environment.
- Inside SillyTavern: registers extension settings/button, fetches CSRF tokens, and triggers `/api/users/backup` for 1-click conversion.
- Standalone web: shows file upload/drop area with direct user-selected zip conversion.

### 2. `src/ui/file-drop.js`
- Drag-and-drop file target and dynamic layout detection card.
- Sniffs file magic bytes and central directory to display format indicator.

### 3. `src/ui/view.js`
- Progress bar and live status updates during conversion.
- Accordion for converted files, dropped files, warnings, and error messages.
- Dispatches in-browser download via `URL.createObjectURL(blob)`.
