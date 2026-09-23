# Type Safety & Validation Guidelines

> JSDoc 契约、运行时域守卫、不可变常量与注入面守卫。

---

## Overview

全栈现代 JavaScript（ESM），无 TypeScript 转译、无构建期类型检查——类型契约由三件事兜住：

1. **JSDoc 注解**：导出函数必须有完整签名与返回类型。
2. **运行时守卫**：枚举/形状在入口处校验，非法输入立即抛错。
3. **深不可变**：枚举与选择配置一律 `Object.freeze`。

分层边界同时是类型边界：`src/core/` 纯逻辑（**禁止 DOM 依赖**）→ `src/ui/` 可 DOM →
`src/storage/` 持久化；`src/vendor/` 是第三方本地副本（勿升级改动）。

---

## JSDoc Type Contracts

`src/core/transform.js` 的主入口 `convert()` 是契约范本（摘录）：

```javascript
/**
 * @param {string} sourcePath 源数据包（路径或 Blob，由 io 适配器决定）
 * @param {string} targetPath 产物写出目标
 * @param {object} options
 * @param {'st'|'l'|'tt'|'pt'} options.target 目标布局
 * @param {boolean} [options.keepAll] 保留派生缓存与 TT 私有目录
 * @param {boolean} [options.dryRun] 只产出报告不写文件（数据条目跳过读取）
 * @param {AbortSignal} [options.signal] 中止信号（每条目边界检查）
 * @param {Map<string,number>|Object<string,number>} [options.resumeCrcMap] 断点续传 crc 清单
 * @param {function(string, number): void} [options.onEntryDone] 每完成一个源条目回调
 * @returns {Promise<Report>}
 */
export async function convert(sourcePath, targetPath, { target, ...options } = {}) { /* ... */ }
```

---

## Runtime Type Guarding & Immutability

### 1. 目标布局与扩展模式枚举（`src/core/transform.js`）

```javascript
export const TARGETS = Object.freeze({ ST: 'st', L: 'l', TT: 'tt', PT: 'pt' });
export const EXTENSION_MODES = Object.freeze({
  MANIFEST: 'manifest', // 轻量清单模式：仅导出来源清单，不打包插件实体
  FULL: 'full',         // 完整离线包模式
});
```

入口处两道守门（缺一个都是静默错数据）：

```javascript
if (!target || !Object.values(TARGETS).includes(target)) {
  throw new Error(`convert: target 必须是 ${Object.values(TARGETS).join('|')} 之一`);
}
if (!io || typeof io.openReader !== 'function' || typeof io.createWriter !== 'function') {
  throw new Error('convert: 必须提供有效的 io 适配器 (openReader/createWriter)');
}
```

### 2. 宿主备份选择配置（`src/ui/host-bridge.js`）

`FULL_SELECTION` 是宿主备份的缺省类目集，**导出在桥接层**——不要在别处再定义一份：

```javascript
export const FULL_SELECTION = Object.freeze({
  settings: true, secrets: true, characters: true, chats: true, lorebooks: true,
  presets: true, assets: true, extensions: true, globalExtensions: true, vectors: true,
});
```

### 3. 持久层来源枚举（`src/storage/db.js`）

`ORIGINS`（`upload` / `host-export` / `converted` / `delta` / `split-part`）同样冻结，并承担
v1 → v2 迁移的语义映射（`role → origin`）；新增来源必须同时补到枚举与迁移函数。

### 4. 平台码与布局码互不代用（类型上无法区分，最易错）

| 用途 | 取值 | 来源 |
| --- | --- | --- |
| 宿主端点调用 | `st` / `luker` / `standalone` | `detectHost()`（`host-bridge.js`） |
| 转换 / 文件名模板 | `st` / `l` / `tt` / `pt` | `TARGETS`（`transform.js`） |

二者之间只有一条合法通道：`hostLayoutCode()`（`luker → l`）。改动时必须显式检查调用点
属于「端点」还是「转换」，否则会出现只在宿主直出路径才暴露的抛错。

---

## Manifest Schema Validation

### 1. 扩展清单（仓根 `manifest.json`）

ST / Luker 扩展清单由 `test/plugin.test.js` 把关，字段：

- `name`：kebab-case（`st-zip-converter`）。
- `display_name`：可读标题。
- `version`：与项目版本一致的 semver（当前 `1.0.0`）。
- `author`、`description`：非空。
- `js`（`index.js`）、`css`（`style.css`）：入口必须存在。

同测试还断言根 `index.html` 的 `stylesheet` / `module script` 引用与 `host-bridge.js` 的导出面
（`discoverHostExtensions` / `installExtensionViaHost` / `mountSettingsDrawer` 等）。

> 注意区分两个同名文件：
> - 仓根 `manifest.json` ＝ **本扩展的清单**（上表字段）。
> - 数据包内的 `manifest.json` ＝ **Luker 备份清单**（`schemaVersion` + `selection`），
>   由 `src/core/transform.js` 在 L 目标侧合成，格式见 `guides/tavern-datapack-formats.md`。

### 2. 注入面守卫（运行时绕不过去的「类型」）

- `src/ui/escape.js` 是**唯一** HTML 转义入口：`escapeHtml`（覆盖 `& < > " '`）、
  `isSafeHttpUrl`（仅 http/https）、`trustedStaticMarkup`（恒等函数，仅标注可信静态片段，
  审计：`grep -rn "trustedStaticMarkup(" src/ index.js`）。
- 静态守卫：`npm run check:dom-injection`（`innerHTML` / `insertAdjacentHTML` / `outerHTML`
  赋值中出现未转义插值即失败）、`npm run check:css-scope`（CSS 规则必须以 `.app-container`
  或 `.st-converter-drawer-app` 为根）。
