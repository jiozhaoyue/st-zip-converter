# 执行计划：导出管线性能重写与实例卡顿排查

## Phase 1：方案 A/B 判定（Worker 路径实测）

- [ ] 1.1 vite build 后浏览器实测方案 A：vendor zip.js `useWebWorkers: true` 的 workerURI 在扩展环境（file:// 与宿主页面注入）与独立 Web 环境是否可解析；主动断言压缩确实走了 Worker（zip.js 内部静默 fallback 需显式检测）
- [ ] 1.2 方案 A 失败 → 切方案 B（自建 `new Worker(new URL('./converter-worker.js', import.meta.url))` worker 池），修订 design.md 后继续
- [ ] 1.3 记录判定结论与证据截图/日志到 `research/worker-path-decision.md`

## Phase 2：写入管线重写（src/core/zip-io.js）

- [ ] 2.1 并发滑动窗口替换串行队列（design §2.2，CONCURRENCY=6 起步，可配置）
- [ ] 2.2 manifest 首条保序、written 去重、waitForRoom、abort、close 语义保持
- [ ] 2.3 addLazy 缓冲 highWaterMark 1→16，完成计数释放槽位
- [ ] 2.4 zip.configure：useWebWorkers、maxWorkers、chunkSize 调优
- [ ] 2.5 单测：并发写入正确性（条目数/顺序无关性/CRC）、去重、abort；Node 降级路径不变

## Phase 3：三段式进度（src/ui/host-bridge.js）

- [ ] 3.1 fetchHostBackup 改流式 response.body 读取 + Content-Length 进度估算
- [ ] 3.2 阶段回调接入 view.setProgress 与 logger（宿主生成/传输/插件处理三段）
- [ ] 3.3 单测：mock fetch 流式响应，进度回调序列断言

## Phase 4：卡顿修复

- [ ] 4.1 log-console.js 帧合并批量渲染 + 超限折叠（单帧 ≤50 行）
- [ ] 4.2 db.js saveFile 调用点从转换热路径摘除，后台排队
- [ ] 4.3 Playwright Long Task 采集对比（转换期间，优化前 vs 优化后）→ `research/longtask-compare.md`

## Phase 5：基准与回归

- [ ] 5.1 生成 ≥1GB 基准包，记录优化前基线 → `research/perf-baseline.md`（如优化前数据难复现，用旧管线 git stash 方式现测）
- [ ] 5.2 优化后同基准测试 → `research/perf-after.md`（耗时/内存/LongTask 三指标）
- [ ] 5.3 `npm test` 全绿（105 项 + 新增并发/进度测试）；zipjs-io 同构性、secrets 字节一致专项通过
- [ ] 5.4 `npm run build` 无报错；独立 Web 模式手工/Playwright 冒烟（上传→转换→下载）

## Phase 6：实例侧诊断报告

- [ ] 6.1 Playwright Performance trace：real 实例 空闲 vs 转换期间、插件启用 vs 禁用 采样
- [ ] 6.2 输出 `research/real-instance-lag-report.md`（插件侧已修项 + 实例侧观察与建议，不改实例）

## Phase 7：交付

- [ ] 7.1 spec 更新判断：zipIo 并发语义、Worker 判定结论写入 .trellis/spec/backend 或 guides
- [ ] 7.2 batched commit（管线/进度/卡顿修复分组）→ 用户确认 → 推送 origin/main

## 回滚点

- Phase 2 一个 commit（核心管线），Phase 3/4 各自 commit；任一出问题独立 revert。

## 验证命令

```bash
npm test
npm run build
node fixtures/gen.js --big && node bench.mjs   # 具体形式 Phase 5 定
npx playwright test tests/e2e/longtask.spec.js
```
