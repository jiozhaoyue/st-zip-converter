# 实测探测记录：ST / Luker 宿主特征

> 探测日期：2026-09-07 · 方法：curl 探测本地实例（只读）

## Luker 实例（运行中）

- **端口**：`8004`（config.yaml port: 8004），**仅 HTTPS**（http 000，https 200）。进程 node PID 57660。
- **`GET /version` 响应（200）**：

```json
{
  "agent": "Luker:2.7.0:Cohee#1207",
  "compatAgent": "Luker:1.18.0:Cohee#1207",
  "stCompatVersion": "1.18.0",
  "pkgVersion": "2.7.0",
  "gitRevision": "239b329ea",
  "gitBranch": "release",
  "commitDate": "2026-09-06 10:09:52 +0800",
  "isDocker": false
}
```

- 页面 HTML 含 15 处 `luker` 字符串标记。
- Luker 特征判定（实现依据）：
  1. `agent` 字段以 `Luker:` 开头（最直接）。
  2. `pkgVersion` = 2.x 且存在 `stCompatVersion` 字段（ST 无此字段）。

## SillyTavern 实例（当前未运行）

- **端口**：`config.yaml` 配置 `port: 8002`，ssl.enabled: false（HTTP）。
- 当前探测 `https/http://127.0.0.1:8002/` 均 000 → **ST 实例未启动**。
- ST `/version` 形状（基于 ST 源码知识，ST 运行后须复测）：`{"version":"1.18.0"}` 单字段。
- ST 前端全局：`globalThis.SillyTavern = { libs, getContext }`（public/script.js:292）。

## 对 verifyHostPlatform() 实现的决定性结论

1. **`/version` 端点两端都存在**，且 Luker 响应含 `agent` 字段可直接判定宿主名。
2. 判定规则（端点侧）：
   - 响应含 `agent` 且以 `Luker` 开头 → luker
   - 响应含 `agent` 且以 `SillyTavern` 开头 → st
   - 仅 `{version}` 单字段（无 agent）→ st（老版 ST 形状）
   - 404/不可达 → 保留前端判定，logger.info 记录
3. **协议字段（HTTP vs HTTPS）**：插件运行在宿主页面内，fetch 相对路径 `/version` 自动沿用页面协议，无需处理。
4. 兼容字段：`stCompatVersion` 存在即 Luker（ST 永远不会有）。

## Luker UI 异常现场采样（Phase 1.3 初步）

- 页面正常返回，`lukerContext` 发布机制存在（scripts/lukerContext.js）。
- 插件 CSS 注入前后 diff 待 Playwright 执行（Phase 4 前完成）。
- 已知嫌疑（源码层面）：`src/style.css` 待审计全局选择器。
