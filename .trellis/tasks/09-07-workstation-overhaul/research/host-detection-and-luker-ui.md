# 调研：宿主识别现状与 ST/Luker 可靠区分方案

> 调研日期：2026-09-07 · 基于本地只读实例源码（Instance/Real/Luker、Instance/Real/SillyTavern）与插件代码

## 1. 当前插件检测逻辑的缺陷

`src/ui/host-bridge.js:28-35` 的 `detectHost()`：

```js
const isLuker = typeof window.luker !== 'undefined' || Boolean(document.querySelector('#luker-app'));
const isST = typeof window.SillyTavern !== 'undefined' || Boolean(document.querySelector('#extensionsMenu'));
```

**已证实的问题**：

| 信号 | ST 实例 | Luker 实例 | 结论 |
|------|---------|-----------|------|
| `window.luker` | 无 | **无**（grep 整个 public 目录无 `window.luker` 赋值） | 死信号，永远 false |
| `#luker-app` | 无 | **无**（DOM 中不存在该元素） | 死信号 |
| `window.SillyTavern` | 有（`public/script.js:292` `globalThis.SillyTavern = { libs, getContext }`） | **有**（`public/script.js:360` `globalThis.SillyTavern = lukerApi`） | 两边都有，**Luker 必然被误判为 ST** |

结论：当前 Luker 宿主 100% 被识别为 `st`。影响链：
- `fetchHostBackup(host.platform)` 两平台端点同为 `/api/users/backup`，但 **Luker 支持 selection 细粒度+manifest，ST 端只支持全量 glob 导出（selection 被忽略）**（ST `src/users.js:1152-1189` 用 `archive.glob('**/*')`，无 selection 参数）。
- `restoreToHost(platform)` 的目标语义错误。
- UI 徽标、目标格式默认值（`index.js:446` `targetSelect.value = host.platform === 'luker' ? 'l' : 'st'`）全部失效——Luker 上会默认 'st'。
- Luker 恢复端点对 `mode: overwrite` 的处理也可能与 ST 不同。

## 2. 可靠区分信号（按优先级）

### 2.1 前端全局对象（最可靠）
- **Luker**：`globalThis.lukerContext`（`public/script.js:313-316` 经 `scripts/lukerContext.js` 发布，惰性 getter，加载后必然存在）。另 `globalThis.SillyTavern = lukerApi`（Luker 特有的兼容 API 形状）。
- **ST**：`globalThis.SillyTavern = { libs, getContext }`（`public/script.js:292`）。
- **判定规则**：`lukerContext` 存在 → luker；否则 `SillyTavern` 存在 → st。**顺序不可颠倒**（Luker 两者都有）。
- 风险：`lukerContext` 是惰性 getter，`typeof globalThis.lukerContext === 'object'` 触发 getter，若 `getContext()` 在早期抛错会暂时 undefined——需 try/catch 并回退到 2.2。

### 2.2 服务端版本端点（权威，可做二次校验）
- ST 与 Luker 的 `package.json` version 不同（本地实例：ST `1.18.0`，Luker `2.7.0`）。
- 探测路径（待 Playwright 实测确认，规划阶段标注为假设）：
  - `GET /version`（ST 历史上有此端点返回 `{version}`）——两端均试。
  - `GET /api/settings` 响应中可能含版本字段。
- 建议实现：`detectHost()` 先用前端信号，再异步 `fetch('/version')` 校验，不一致时以端点为准并告警日志。

### 2.3 manifest 形状（导出后校验）
- Luker 导出包根有 `manifest.json`（schemaVersion+selection），ST 导出包无。可用于**导出后验证宿主识别是否正确**：若 platform=st 但包内出现 manifest.json → 识别错了。

## 3. 宿主能力矩阵（影响导出 UI 与数据包正确性）

| 能力 | ST | Luker |
|------|----|-------|
| `/api/users/backup` | 全量 glob，忽略 selection | 支持 `selection` 分类导出 + 写入 manifest.json |
| `/api/users/restore` | 存在 | 存在，恢复按"路径后缀匹配"且**跳过包内 manifest.json**（users-private.js:311） |
| secrets 排除 | `allowKeysExposure=false` 时强制排除 | 同 |
| storage engine dump | 无 | 非 fs 引擎时附 `_engine_meta.json` + `_engine_dump.bin` |

**导出数据包正确性要求**：
- 宿主为 ST 时：UI 应明示"ST 原生导出为全量包，细粒度类目勾选仅在 Luker 宿主/插件侧后处理生效"（或改为拉全量后在插件内做类目过滤——这是 ui-unify 统一工作台的自然能力）。
- 宿主为 Luker 时：selection 直接透传。

## 4. Luker 前端 UI 异常（新增排查项）初步假设

用户报告"Luker 前端 UI 变得很奇怪"。候选根因（待子任务 3 排查证实）：
1. **插件 style.css 全局污染**：`style.css` 若含通配选择器（`* { box-sizing }`、`body { ... }`、`::-webkit-scrollbar` 等全局规则），注入到 Luker 页面后覆盖宿主样式。需审计 `src/style.css` 的选择器作用域。
2. Font Awesome 全局类名冲突或重复注入字体。
3. 插件 DOM 挂载点选择器与 Luker 布局不匹配（`mountSettingsDrawer` 的目标容器在 Luker 中结构不同）。
4. Luker `lukerContext` 惰性 getter 抛错导致插件初始化路径异常，留下半渲染 DOM。

排查方法：Playwright 打开 Luker 实例 → 注入前后 DOM/ComputedStyle 快照对比 → 定位被污染规则。

## 5. 交付要点（子任务 3 验收基线）
- `detectHost()` 在 ST 与 Luker 实例中返回正确 platform（Playwright 双实例实测）。
- Luker 宿主上导出包带 manifest.json 且 selection 生效；ST 宿主上导出为合法全量包。
- Luker UI 异常根因定位并修复（属插件侧）或出具报告（属宿主侧）。
