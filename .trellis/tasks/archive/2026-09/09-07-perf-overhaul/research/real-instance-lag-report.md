# Real 实例卡顿诊断报告（Phase 6）

> 2026-09-07 · Playwright 采样 Luker 实例（https://127.0.0.1:8004）· 只读，未改动实例

## 现场数据

### 空闲期主线程长任务（8 秒观察窗）
- **9 个 LongTask（>50ms），最重 440ms 与 491ms**，累计阻塞 ~1.5s / 8s ≈ **19% 时间主线程被占满**
- JS 堆内存：采样一 245MB → 采样二 427MB（有第三方扩展加载差异，内存增长快）

### 实例环境
- DOM 节点 12391 个，11 个第三方扩展同时在跑：
  `tavern-menu-manager`、`SillyTavern-Dialogue-Colorizer`、`SillytarvenSwipes`、
  `ST-Prompt-Template`、`Extension-Silence`、`silly-tavern-reminder`、`st-input-helper`、
  `Acsus-Paws-Puffs`、`st-persona-weaver`、`st-api-wrapper`、`chat-companion-stats`
- **本插件（st-zip-converter）未加载进 real 实例**（converterPluginLoaded: false）

## 结论

1. **卡顿主因不在本插件**：实例空闲期（插件根本未加载）就有 19% 主线程占用率与数百毫秒级长任务，来自上述 11 个第三方扩展中的一个或多个（440/491ms 级别长任务的特征是初始化/轮询类脚本）。
2. **插件侧已完成的自保措施**（本次 perf-overhaul 落地）：
   - 转换主流程本就在 Dedicated Worker（worker-client.js），不占宿主主线程；
   - 新并发写入管线把主线程阻塞降低 65%（bench-compare.md）；
   - 日志渲染帧合并 + 洪泛折叠（log-console.js），大包时数千条日志不再逐条打 DOM；
   - 大 Blob IndexedDB 写入串行队列化（db.js），与转换热路径解耦。
3. **实例侧建议**（交给用户，不改实例）：
   - 逐个禁用上述扩展做二分定位，优先怀疑带轮询/定时器/大列表渲染的
     （`chat-companion-stats`、`tavern-menu-manager`、`ST-Prompt-Template` 是 400ms+ 长任务的高危形态）；
   - 内存 245→427MB 增长快，怀疑有扩展泄漏，可在 DevTools Memory 面板做堆快照对比；
   - 若需要精确定位，可在实例上用 chrome://tracing 采集 30s trace 分析。

## 遗留
- 插件未安装进 real 实例（遵循"Git 交付"规范），安装后若有新的插件侧卡顿证据可再开诊断任务。
