# 8004 真机全面实测与修复报告（2026-09-07）

> 方法：保活 Chrome（CDP 9222）+ Playwright connectOverCDP，longtask/心跳漂移/CDP Performance.getMetrics/真实键盘事件采样。脚本均在本目录 pw-*.cjs。

## 实测结论

### 1. 「慢」的真相
- 直连 `/api/users/backup` 实测吞吐 **16-19 MB/s**（1415MB / 75-88s），非 0.1MB/s。
- **1415MB 的来源**：Luker 服务端 `getUserBackupTargets`（src/users.js:1376）在勾选
  `settings` 时**隐含打包 `backups/` 目录**（历史快照）。实例 `backups/` 实占 **2GB**。
  用户每次勾选系统设置都在拉全部历史备份——这是"慢"的主体。
- 16MB/s 低于硬盘 IO 的原因：服务端 `archiver('zip')` 默认 deflate-6 边压边发
  （用户已明确决定**不改服务端**）。
- **提速路径（不改服务端）**：清空/减少酒馆 `backups/` 历史快照，或拉取时取消勾选
  「系统设置」。插件已在拉取前 log.warn 提示该隐含行为。

### 2. 「拉取时整页卡」根因（插件真责，已修）
- 真机实测：拉取 20s 内 **14 个 longtask（80-107ms/个，共 1.1s）**。
- 根因：传输流每秒约 50 个 chunk，每个 chunk 同步调 `view.setProgress` 写 DOM。
- 修复：`view.js` setProgress 改 rAF 合帧节流（一帧最多写一次，label 取最新）。
- **复测：longtask 14 → 2 个**（57ms/个，共 114ms）。

### 3. 「打开抽屉持续卡」与插件无关（实测排除）
- 抽屉展开/收起 12s CDP CPU 采样：均为 **scriptMs 22/21**，无差异。
- 真实键盘打字延迟（CDP Input 事件→rAF）：收起 p50=33ms vs 展开 p50=45ms，p95 均值 167ms，
  差异在噪声范围。
- 空闲 longtask = 0，心跳漂移 p95 < 1ms。
- 页面上有 43 个持续 CSS 动画（qr-new-badge pulse-red、spreset border-flow 等），
  全部来自其他第三方扩展——「日常持续卡」的候选来源，与插件无关。

### 4. 徽标重复（已修）
- 症状：`env-badge`（插件模式）+ `host-tag-platform`（宿主环境）语义重复；且模板
  status-row 渲染两份、id 重复 → getElementById 只命中第一份，第二份永远"检测中"。
- 修复：单枚合并徽标 `Luker 插件 · v2.7.0`（badgesHtml 按 isDrawer 分支只渲染一份）。

### 5. 配额条重定义（已修）
- 旧：「插件 IndexedDB」+「页面整体存储」两根，概念混乱。
- 新：**浏览器配额**（navigator.storage.estimate：1.4GB / 11.4GB）+
  **用户配额**（Luker 管理员分配，POST /api/users/storage/inspect L0 的
  quota.usedBytes/quotaBytes：3.3GB / 无限制）。非 Luker 或端点不可达时第二行隐藏。

### 6. 拉取透明化（已修）
- 进度文案改为 `[2/3 传输中] 正在接收宿主打包的 ZIP 流 · 已接收 X / Y MB · Z.Z MB/s`，
  速度为 2s 滑动窗口实测值（onPhase 直传 currentBps），非估算。
- 阶段 1 文案标明服务端正在 deflate 压缩打包（等的就是这个）。

## 交付
- `7c50916` fix(ui): merged env badge, browser+user quota bars, fetch telemetry, rAF-throttled progress
- `36637c5` fix(ui): badge shows short version instead of full agent string
- 177 测试全绿；实例已 Git pull 至 36637c5。
