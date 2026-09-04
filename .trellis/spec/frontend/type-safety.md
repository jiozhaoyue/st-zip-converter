# Type Safety & Validation Guidelines (Plugins)

> JSDoc annotations, runtime platform validation, and immutable constants.

---

## Overview

The plugin layer is written in modern JavaScript (ESM) without TypeScript transpilation to ensure zero compilation drift and immediate browser compatibility. Type safety is enforced via:
1. **JSDoc Type Annotations**: Clear function signatures and parameter/return typing.
2. **Runtime Domain Guards**: Strict enum checks on target platforms.
3. **Deep Immutability**: `Object.freeze` on configuration objects and schemas.

---

## JSDoc Type Contracts

Exported and interop functions must include complete JSDoc headers:

```javascript
/**
 * 把平台备份 blob 转成目标平台包。
 * @param {Blob} sourceBlob - 平台导出的源数据包 Blob
 * @param {'st' | 'l' | 'tt' | 'pt'} target - 目标平台标识
 * @returns {Promise<{ blob: Blob, warnings: string[] }>} 转换后的包与警告清单
 */
export async function convertBackup(sourceBlob, target) {
  if (!Object.values(TARGETS).includes(target)) {
    throw new Error(`未知目标平台: ${target}`);
  }
  // ...
}
```

---

## Runtime Type Guarding & Immutability

### 1. Frozen Target & Selection Enums
Prevent accidental modification of critical API selection configurations:
```javascript
export const TARGETS = Object.freeze({
  ST: 'st',
  L: 'l',
  TT: 'tt',
  PT: 'pt',
});

const FULL_SELECTION = Object.freeze({
  settings: true,
  secrets: true,
  characters: true,
  chats: true,
  lorebooks: true,
  presets: true,
  assets: true,
  extensions: true,
  globalExtensions: true,
  vectors: true,
});
```

### 2. Manifest Schema Validation
Both SillyTavern and Luker extensions require a `manifest.json`. `test/plugin.test.js` enforces schema requirements during automated testing:
- `name`: Non-empty string (kebab-case).
- `display_name`: Human-readable title.
- `version`: Semver string matching project version.
- `description`: Non-empty string.
- `author`: Project author handle.
