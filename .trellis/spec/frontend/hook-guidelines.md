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

## 无全局命名空间（替代旧的 globalThis 调试钩子）

`globalThis.__tavernConvert` 已随 IIFE 打包形态一并移除。**当前不存在任何挂到 `globalThis`
的自有命名空间**——`src/` 下对 `globalThis` 的引用只有**读取**宿主信号
（`globalThis.lukerContext` / `globalThis.SillyTavern`，见 `detectHost()`）。

自动化与调试的现行入口：

- **Node / Vitest**：所有模块都是 ES Module，`src/core/**` 无 DOM 依赖可直接 import；
  `test/plugin.test.js` 即在 Node 下 import `src/ui/host-bridge.js` 校验导出面与清单字段。
- **静态守卫**：`npm run check:dom-injection`、`npm run check:css-scope`。
- **浏览器手测**：`npm run dev` 起 Vite 开发服务器走独立 Web 形态；宿主插件形态需加载到
  **Dev 实例**（8001 ST / 8003 Luker），用 DevTools 直接断点调试 `host-bridge.js` 的导出函数。
- 若后续确需自动化钩子，应新增**显式命名**的接缝并在本节登记，**不要**恢复隐式全局对象。

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
