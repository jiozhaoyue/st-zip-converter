# 检索先行记录（双通道）— L0-3

> 日期：2026-09-26 ｜ 结论：**无现成方案可复用，需自建**（自建范围见 `design.md`）

## 通道一：WebSearch / WebFetch —— **本机不可用**

调用 `WebSearch("SillyTavern extension Playwright end-to-end test automation")` 返回：

```
API Error: 400 {"error":{"message":"Thinking mode does not support this tool_choice …",
 "providerMetadata":{"gateway":{"routing":{"originalModelId":"deepseek/deepseek-v4.1-flash"…
```

本机 Claude API 走本地代理 `127.0.0.1:15721`（deepseek-v4-flash 路由），该路由在 thinking 模式下
不支持 `tool_choice`，故 **WebSearch 通道整体不可用**。按 L0-3「国际搜索引擎被屏蔽时用 GitHub API 替代」
处理。**未做任何重试**（错误类型为 `isRetryable: false`，重试无意义）。

## 通道二：GitHub API —— **可用，零命中**

`api.github.com` 可达（`curl` 探活成功，HTTP 200 返回结构化 JSON）。

| 查询 | 端点 | 命中 |
| --- | --- | --- |
| `sillytavern playwright` | `GET /search/repositories?q=sillytavern+playwright` | **4** 项，人工核验全不相关（`LyubomirT/intense-rp-next` 等 RP 前端，非测试基础设施） |
| `sillytavern e2e playwright` | `gh search repos` | 0 |
| `sillytavern data backup sync` | `gh search repos` | 0 |
| `sillytavern extension test automation` | `gh search repos` | 0 |
| `tavern datapack converter` | `gh search repos` | 0 |

**结论**：GitHub 上不存在可直接复用的「四宿主数据包 E2E 验证」或「跨实例数据同源同步」工具。
本任务的两块基础设施（同源同步脚本、E2E 运行器）**需自建**，且自建范围应压到最小：
复用本机已有的全局 Playwright 1.62.1 与本仓既有的 `src/core/convert()`，不引入新框架。

## 仓内既有资产复用评估

| 资产 | 位置 | 可否复用 |
| --- | --- | --- |
| `.pw-profile` / `.pw-profile-dev` 持久化档案 | 仓根（已 gitignore） | ✅ 直接复用，避免每次重登 |
| 上轮 6 个 `.cjs` 探针 | `archive/09-25-all-instance-plugin-sync/research/` | ⚠️ **只作参考**：一次性脚本、无断言、不入库。按 `tavern-browser-automation` skill「同一排障结论需复现 ≥2 次即改写为用例」应重写为带断言的用例 |
| 全局 Playwright 1.62.1 | `%LOCALAPPDATA%\ms-playwright\` | ✅ skill 明令**不新装、不覆盖** |
| `src/core/transform.js` 的 `convert()` | 仓内 | ✅ 纯逻辑 + `io` 注入接缝，可 Node 侧直接产包 |
| `tavern-browser-automation` skill 的启动守卫片段 | `tavern-harness/skills/` | ✅ 直接采用其 `assertDevTarget` 契约 |
