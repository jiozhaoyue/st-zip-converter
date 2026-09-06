# 宿主精确识别与 Luker UI 异常排查

> 父任务：09-07-workstation-overhaul · 依赖：无（三个子任务中最先执行）

## Goal

修复 `detectHost()` 将 Luker 宿主误判为 ST 的缺陷；使导出/恢复行为按宿主能力正确分支；查明"Luker 前端 UI 变得很奇怪"的根因并修复（插件侧）/出具报告（宿主侧）。

## Requirements

### R1 宿主识别修复
- `detectHost()` 判定顺序：`globalThis.lukerContext` 存在 → luker；否则 `globalThis.SillyTavern` 存在 → st（顺序不可颠倒，Luker 两者都有，见父任务调研 host-detection-and-luker-ui.md §2.1）。
- `lukerContext` 惰性 getter 须 try/catch 包裹，getter 抛错时回退服务端校验。
- 新增异步服务端校验 `verifyHostPlatform()`：探测 `/version`（假设，需 Playwright 在双实例实测确认端点存在性与响应形状）；前端信号与端点结果不一致时以端点为准并输出告警日志。
- 导出后校验（软校验）：Luker 导出包应含 `manifest.json`；ST 导出包不含。不一致时 logger.warn 提示识别可能错误。

### R2 宿主能力适配（保证导出数据包正确）
- ST 宿主：`fetchHostBackup` 的 selection 参数被端点忽略（ST 全量 glob 导出）。UI 须明示"ST 原生导出为全量包"，类目勾选改为拉回全量后由插件内 transform 过滤生效（过滤逻辑复用现有 selection 能力）。
- Luker 宿主：selection 直接透传端点（现状已正确，补测试锁定）。
- `restoreToHost` 的 platform 参数与目标格式默认值（`index.js:446`）在 Luker 下正确（`'l'`）。
- 宿主徽标、日志前缀、UI 文案按真实 platform 显示。

### R3 Luker UI 异常排查
- 用 Playwright 打开本地 Luker 实例，对比插件注入前后的 DOM/样式快照，定位异常根因。
- 首要嫌疑：`src/style.css` 全局选择器污染宿主页面（通配符、body/html 级规则、滚动条样式等）。
- 根因属插件侧 → 修复（样式作用域收窄到插件根容器）；属宿主侧 → 只出诊断报告不改实例。

### R4 测试
- 单测：detectHost 判定矩阵（lukerContext/SillyTavern 组合 × mock 环境）。
- Playwright：ST 实例与 Luker 实例各验证一次 platform 识别正确 + 导出包形状正确。
- 现有测试零回归。

## Acceptance Criteria

- [ ] `detectHost()` 在 Luker 实例返回 `{platform:'luker'}`，在 ST 实例返回 `{platform:'st'}`（Playwright 双实例实测）。
- [ ] Luker 宿主导出包含 selection 生效的 manifest.json；ST 宿主导出为合法全量包。
- [ ] ST 宿主上细粒度勾选通过插件内过滤生效，导出结果与勾选一致。
- [ ] Luker UI 异常根因定位（报告写入 task research/），插件侧原因已修复。
- [ ] `npm test` 全绿，`npm run build` 无报错。
- [ ] 提交并推送到 origin/main。

## Constraints

- 实例源码只读调研（Instance/Real/...），禁止写入实例目录。
- `/version` 端点行为是假设，必须实测后固化结论到 research 文件。
