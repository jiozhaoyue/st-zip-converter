# Error Handling Guidelines（错误分类与降级）

> 核心抛错边界、非致命警告汇入报告、资源收尾。

---

## Overview

本工具**没有 CLI，也没有退出码**。错误分两类：

- **致命错误**：`src/core/` 抛出 `Error`，中止本次转换；由 UI 层捕获（根 `index.js` 的 `try/catch` + `logger.error`），任务状态置 `failed`。
- **非致命异常**：不中断进度，汇入 `Report`（`warn()` / `dropped()` / `filtered()`），最终在报告面板与日志抽屉中呈现。

---

## 致命错误：`convert()` 的抛错边界

`src/core/transform.js` 的 `convert()` 在下列条件下抛 `Error`（消息为中文，可直接展示给用户）：

| 抛出点 | 条件 | 消息 |
|---|---|---|
| 入口校验 | `target` 不在 `TARGETS`（`st|l|tt|pt`） | `convert: target 必须是 st\|l\|tt\|pt 之一` |
| 入口校验 | `io` 缺少 `openReader` / `createWriter` | `convert: 必须提供有效的 io 适配器 (openReader/createWriter)` |
| 检测后 | 源包是 PT 原生归档（per-file `sha256` / `moduleId` 清单） | `PT 原生归档(sha256 清单)暂不支持,请先从 PT 导出 TT 迁移包` |
| 检测后 | 布局无法识别（无 `manifest.json` / 无 `data/` 根 / 非摊平用户目录） | `无法识别源包布局(无 manifest.json / data/ 根 / 摊平用户目录标记)` |
| 条目边界 | `options.signal.aborted` | 抛 `DOMException('转换任务已被中止/暂停', 'AbortError')` |

其他抛出点：`host-bridge.js` 的 `getCsrfToken()` 在宿主返回非 2xx 时抛 `获取 CSRF token 失败: <status>`；`/api/users/backup`、`/api/users/restore` 的失败经各自调用点的 `catch` 记入日志。

---

## UI 层捕获与呈现

- 根 `index.js` 在转换、宿主拉取、恢复写入、批量转换等异步入口处 `try/catch`，失败统一 `logger.error`（例：`数据包转换出错`、`宿主拉取过程发生错误`、`恢复写入宿主过程发生错误`、`批量转换失败 [<包名>]: <message>`）。
- 中止与失败必须在日志和任务状态上可区分：`TaskManager` 的状态为 `running | paused | aborted | done | failed`——暂停保留 checkpoint，中止清理半成品，真失败为 `failed`。
- 禁止静默吞异常：至少 `logger.error`；涉及用户数据的失败必须在界面上可见。

---

## 非致命警告与报告账本

平台差异（扩展格式不匹配、TT 私有缓存、Luker 私有配置等）通过既定策略解决并记账，不中断转换。以下均为 `transform.js` 中的真实调用：

```javascript
report.dropped(routed.hubPath, 'TT 私有/缓存,目标平台不消费');
report.dropped(routed.hubPath, '派生缓存,导入后会自动重新生成');
report.dropped(routed.hubPath, '酒馆原生固定资产(默认背景/主题/预设)，已智能剔除');
report.dropped(routed.hubPath, `与 third-party 扩展 "${extFolder}" 同名,保留第三方副本`);
report.filtered(hubPath, 'secrets');    // 用户主动取消勾选该类别
report.synthesized('_convert/INSTALL.md');
report.resumed(hubPath);                // 断点续传命中，跳过重写
report.warn('源包含 _engine_dump.bin/_engine_meta.json(数据库引擎状态),已按设计丢弃;…');
```

`Report` 的真实方法集为 `copied / dropped / filtered / synthesized / resumed / warn` + `toJSON()` / `toHuman()`（见 `src/core/report.js`）——**不存在 `recordDiscard`**。

- **报告输出**：`toJSON()` 供程序消费，`toHuman()` 输出模块计数表 + 丢弃清单 + 警告清单。
- **已实现的降级示例**（均为 `transform.js` 实际行为）：
  - PT / TT 目标的扩展来源产出：源里已有记录则原样保留（`data/_tauritavern/extension-sources/<scope>/<name>.json`）；否则仅当 `remoteUrl` / `homePage` **为 https** 时合成（字段 `remote_url` / `reference` / `installed_commit`），非 https 只记警告：`扩展 "<name>" 无来源记录且 remoteUrl/homePage 非 https(…),按 PT 规则它将在导入时被跳过,请在 PT 扩展面板重装。`——**不再合成占位 URL**。
  - 用户级扩展与 third-party 同名冲突 → `dropped(…, '与 third-party 扩展 "<name>" 同名,保留第三方副本')` + 汇总 `warn('以下用户级扩展与 third-party 同名,已保留第三方副本: …')`。
  - ST / L 目标消除错误的 `third-party` 嵌套 → `warn('已针对 ST 平台规范消除错误的 third-party 嵌套，自动将 N 个扩展条目拉平为标准平铺布局 (extensions/<name>/)。')`。
  - 非 Luker 目标下，Luker 私有配置（`stats.json` / `macros.json` 等）转入 `_compat/luker/` 而非丢弃（`transform.js`；`test/private-configs.test.js` 把关）。

---

## 资源收尾

1. **Reader 必须关闭**：`zipIo.openReader()` 得到的 reader 用完即 `close()`；`convert()` 用 `try/finally` 保证检测用 reader 释放。
2. **中止 / 暂停**：`options.signal` 在**每条目边界**检查；由 `TaskManager` 触发——暂停先落 checkpoint 再 abort（半成品保留待续传），中止则 abort 后清理半成品。
3. **Worker 路径**：`worker-client.js` 在 `signal.aborted` 时立即 `terminate()` 并**将实例引用置空**（`workerInstance = null`），下一次任务重建。`terminate()` 后不置空会让后续每次 `postMessage` 静默失效。另：`AbortSignal` **不可** `postMessage`，须在主线程侧监听（`delete serializedOptions.signal`）。
4. **不允许无界等待**：任何 `await`（DOM 事件、`fetch`、渲染 promise）都必须有超时或 destroy 兜底，禁止让 promise 永久 pending。
