# Hook & Lifecycle Guidelines (Host Integration)

> 宿主生命周期接入、备份/恢复端点、CSRF 认证与宿主 UI 注入点。

---

## 适用范围

本项目不是 React 应用——「hook」指**宿主集成点**：宿主生命周期、备份/恢复端点、CSRF 认证、
宿主 UI 注入。全部平台差异集中在单一桥接层 `src/ui/host-bridge.js`（分层铁律：宿主适配只许
进桥接层，不得散落进 `src/core/`）。

三形态入口（同一份 ES Module 核心）：

1. **独立 Web** —— `index.html` + `#app`，根 `index.js`。
2. **ST / Luker 扩展插件** —— `host-bridge.js` 把工作台注入宿主扩展设置抽屉。
3. **Node / Vitest** —— `src/core/worker-client.js` 检测不到 `Worker` 时降级为主线程同步执行。

> **已废弃形态（勿再引用）**：IIFE 打包、`globalThis.__tavernConvert` 全局命名空间、
> `src/plugins/`、`dist/plugins/`、`npm run build:plugins`。代码是标准 ES Module，
> 经 `vite` 构建为静态站点（`npm run build` = `vite build --base=./`）；插件形态由
> `host-bridge.js` 在宿主页面内注入实现，**不存在**独立插件打包产物。

---

## Host Lifecycle & Bootstrapping

扩展可能在页面初次加载时载入，也可能在运行中被动态注入，启动入口必须同时兼容两种场景：

```javascript
// index.js 末尾：Node / Vitest 下不存在 document，直接跳过启动，模块仍可被 import
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    // 宿主页面已加载完成（动态注入 / 插件热重载）
    bootstrap();
  }
}

// index.js bootstrap()：按「有没有 #app」区分独立 Web 与宿主插件
function bootstrap() {
  const existingApp = document.getElementById('app');
  if (existingApp) {
    main(existingApp);              // 独立 Web 模式
  } else {
    mountSettingsDrawer((drawerApp) => { /* 抽屉展开时渲染工作台 */ });
  }
}
```

宿主 UI 注入统一走 `host-bridge.js` 的共享 `watchHostDom` MutationObserver（200ms 去抖），
挂载点（扩展抽屉 / 菜单按钮 / 原生备份按钮 / Luker 备份管理器）以 `dataset.stZipInjected`
标记保证幂等，宿主重渲染导致节点丢失时自动重注入——**不要**各自新开 `setInterval` 轮询。

---

## Host Platform API Hooks

### 1. CSRF Token & User Handle Retrieval

宿主端点需要已认证会话与 CSRF 保护，两者都必须**动态解析**，不得缓存到模块级常量：

```javascript
async function getCsrfToken() {
  const response = await fetch('/csrf-token', { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`获取 CSRF token 失败: ${response.status}`);
  const data = await response.json();
  return data.token;
}

async function getHandle() {
  const response = await fetch('/api/users/me', { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`获取当前用户失败: ${response.status}`);
  const data = await response.json();
  return data.handle;
}
```

### 2. Backup / Restore Endpoints

- **`POST /api/users/backup`（JSON）** —— `fetchHostBackup(platform, selection, opts)`
  （`host-bridge.js`）。请求体为 `{ handle, selection }`，`selection` 缺省用 `FULL_SELECTION`
  （含 `secrets: true`、`globalExtensions: true`）。**代码对 ST 与 Luker 发送同一形状的请求体。**
  - Luker 服务端支持 `selection` 细粒度过滤，勾选类别直接生效。
  - ST 服务端不支持 selection 过滤（全量导出），实际过滤在插件侧完成
    （`src/ui/category-filter.js` + `convert()` 的 `selection` / `excludedPaths`）。
    「待验证」：ST 端点对未知 `selection` 字段的具体处置未被本仓代码证实，
    需对 Dev ST 实例（8001）抓包确认。
- **OPFS 直写**：`supportsOpfs()` 为真时响应体流式写入 `fetch-tmp/<taskId>.zip`（零内存缓冲），
  返回 `{ kind: 'opfs', name, size, handle }`；无 OPFS 时回退内存 Blob。
- **续传**：`resumeCheckpoint.receivedBytes > 0` 时先发 `Range: bytes=<received>-`；
  收到 `206` 则追加写半成品；非 206 判定端点不支持 Range → 作废半成品整包重拉。
- **`POST /api/users/restore`（FormData）** —— `restoreToHost(zipBlob, { mode, platform })`，
  字段 `avatar` / `handle` / `mode`（`merge` | `overwrite`）/ `incremental`。
  恢复成功后若包内含 `_convert/extensions-manifest.json`，自动呼出扩展安装面板
  （`renderExtensionInstallerModal`）。Luker 另有 `restoreToLuker` 路径。
- **宿主扩展管理**：`/api/extensions/discover`（`discoverHostExtensions`）、
  `installExtensionViaHost`、`deleteExtensionViaHost`、`checkHostThirdPartyAnomaly`。

> **平台代码双轨制（最容易踩的坑）**：端点调用传**平台码**（`st` / `luker`，来自 `detectHost()`）；
> 传给 `convert()` 与文件名模板的必须是**布局码**（`st` / `l` / `tt` / `pt`），
> 中途必须经 `hostLayoutCode()` 归一（`luker → l`），否则 `convert()` 会抛
> `convert: target 必须是 st|l|tt|pt 之一`。

---

## 全局命名空间：默认禁止，只许「显式登记」的只读接缝

`globalThis.__tavernConvert` 已随 IIFE 打包形态一并移除。**隐式全局对象一律不得恢复**
（见下方 Forbidden Patterns）。

**当前存在的自有全局命名空间：恰好 1 个 —— `window.__stZipConverterDebug`（2026-09-27 登记，R-19）。**

| 项 | 值 |
| --- | --- |
| **显式命名** | `window.__stZipConverterDebug` |
| **挂载点** | `index.js` 的 `mountDebugProbe()`，由 `bootstrap()` **最先**调用（两种形态都挂：插件态的工作台在抽屉里且抽屉默认为关，放进 `main()` 会让「抽屉未打开」时探针不可用） |
| **成员** | 仅 `getRestoreProbe()`（数据来自 `src/ui/host-bridge.js` 的同名导出，遵 `L0-9`：平台差异唯一落点） |
| **只读契约** | 命名空间对象 `Object.freeze`；`getRestoreProbe()` **每次返回新的 `Object.freeze` 快照** ⇒ 调用方改不动 `capability`，**E2E 无法伪造状态**（防伪能力来自快照冻结，不是命名空间冻结） |
| **不覆盖** | 挂载前查 `Object.prototype.hasOwnProperty.call(window, KEY)`，**已占用则不覆盖并 `logger.warn`**（宿主或别的扩展可能同名；静默覆盖会悄悄弄坏别人的对象） |
| **不泄漏** | 只暴露能力枚举（`unknown`/`available`/`unsupported`）与原因文案（形如 `/api/users/restore → 404、…`，两项都是源码里的静态常量）；**不含** CSRF token / user handle / 文件系统路径 |
| **无 window 环境** | `typeof window === 'undefined'` 时静默跳过（Node / Worker 环境不抛） |
| **测试** | `test/restore-probe.test.js`（7 项：初始态 / 探测后 unsupported / 冻结 / 快照非共享 / 挂载 / 已占用不覆盖 / 无 window 跳过） |

**新增这类接缝的规矩**（本节是唯一登记处）：

1. **必须是显式命名**的，且命名带插件前缀（`__stZipConverter*`），不得用泛名；
2. **必须只读** —— 返回冻结快照，**不得**暴露 setter（否则自动化能伪造状态，断言失去判别力）；
3. **必须做占用检查**，已存在则不覆盖并 warn；
4. **必须不泄漏**敏感项（token / handle / 绝对路径）；
5. **必须在本节登记**（补一行表格），否则规格与实现脱节 —— 本节标题曾写作
   「**当前不存在任何挂到 `globalThis` 的自有命名空间**」，若不随之更正就变成**假事实**（`P-3` 同形）。

自动化与调试的**其余**入口（不带全局对象）：

- **Node / Vitest**：所有模块都是 ES Module，`src/core/**` 无 DOM 依赖可直接 import；
  `test/plugin.test.js` 即在 Node 下 import `src/ui/host-bridge.js` 校验导出面与清单字段。
- **静态守卫**：`npm run check:dom-injection`、`npm run check:css-scope`。
- **浏览器手测**：`npm run dev` 起 Vite 开发服务器走独立 Web 形态；宿主插件形态需加载到
  **Dev 实例**（8001 ST / 8003 Luker），用 DevTools 直接断点调试 `host-bridge.js` 的导出函数。

---

## Forbidden Patterns

- ❌ 假设 `DOMContentLoaded` 一定触发（扩展在页面加载后被动态注入时不会触发）。
- ❌ 硬编码用户 handle（始终经 `/api/users/me` 动态解析）。
- ❌ fetch 请求遗漏 `{ credentials: 'same-origin' }`（宿主端点依赖同源会话 cookie）。
- ❌ 恢复 IIFE 打包 / `globalThis.__tavernConvert` / `src/plugins/` / `dist/plugins/`
  ——这些是已删除的旧架构。
- ❌ 把宿主平台码直接传给 `convert()` 或文件名模板（必须先过 `hostLayoutCode()`）。
- ❌ 在 `host-bridge.js` 之外做宿主**嗅探 / 端点调用 / UI 注入**分支——这三类判断只许存在于
  桥接层（`src/core/` 只按布局码 `st|l|tt|pt` 分支）。
- ❌ 宿主响应正文（错误消息等）经 `innerHTML` 直插（须走 `src/ui/escape.js` 的
  `escapeHtml` 或 `textContent`）。
- ❌ 向宿主 DOM 注入未带双前缀的 CSS 规则（守卫：`npm run check:css-scope`）。
