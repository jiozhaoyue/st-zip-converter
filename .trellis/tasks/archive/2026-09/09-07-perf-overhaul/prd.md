# 导出管线性能重写与实例卡顿排查

> 父任务：09-07-workstation-overhaul · 依赖：无（可与 host-detect 并行，但建议串行其后以减少冲突）

## Goal

重写 zip-io 写入管线，启用 Web Worker 多线程压缩、流式直通、并行写入，消除"逐文件串行 + 主线程压缩"导致的导出缓慢与 UI 卡顿；排查插件导致的 real 实例卡顿因素并全修；实例侧因素只出诊断报告。

## 症状与根因（调研已证实，详见父任务 research/perf-pipeline-analysis.md）

1. 宿主导出"时间太长"：宿主端点生成 + 传输 + 插件 transform 重压缩三段叠加，UI 只有 10% 单点日志。
2. 直出写入慢：`zip-io.js` `useWebWorkers: false`（主线程压缩）+ `createWriter` 串行队列（逐文件排队）+ `writer.add` 全量内存读入。
3. 插件特别卡：转换/导出期间主线程被 deflate 占满；日志洪泛 DOM 渲染；IndexedDB 大 Blob 写阻塞。

## Requirements

### R1 写入管线重写
- 启用 zip.js Web Worker 多线程压缩（`useWebWorkers: true` + maxWorkers=hardwareConcurrency）；若 vendor 内联导致 workerURI 失效，改用 vite 原生 `new Worker(new URL(...), {type:'module'})` 自建 worker 池（方案 B）。
- 移除串行队列：并发度 N（4~8）滑动窗口并行 add；保留 `written` 去重与首条 manifest 顺序敏感处理。
- 流式直通：pass-through 条目 `entry.getData(writable)` 直接 pipe 到 writer，零拷贝不落内存；level=0 (Store) 时字节直通跳过压缩。
- 保持 zipIo 对外 API 形状兼容（openReader/createWriter/add/addLazy/close），上层 transform.js/delta.js/splitter.js 尽量零改动或最小改动。

### R2 进度与体验
- 宿主导出三段式进度：宿主生成（流式 response.body 读取按 Content-Length 估算）→ 传输 → 插件处理，替换单点 10% 日志。
- 大文件条目（>1MB）转换时单条目进度回调。

### R3 卡顿修复（插件侧全修）
- 日志节流：log-console 按帧批量 flush（requestAnimationFrame 合并），超限折叠。
- IndexedDB 大 Blob 写入移出关键路径（后台排队）。
- 消除转换期间主线程长任务（Long Task >50ms 计数优化前后对比）。

### R4 实例侧诊断报告
- Playwright Performance trace 对 real 实例采样（插件启用/禁用对比、转换期间 vs 空闲），输出 `research/real-instance-lag-report.md`。
- 只报告不改实例。

### R5 性能基准与回归
- 基准：`fixtures/gen.js` 生成大包（≥1GB 级），记录优化前后转换耗时、峰值内存、Long Task 计数 → 记入 research。
- 全部现有测试语义保持：105 项测试、zipjs-io 同构性、secrets 字节一致必须通过。

## Acceptance Criteria

- [ ] 1GB 级基准包转换耗时对比优化前显著下降（目标 ≥2x，以实测为准记录真实数字）。
- [ ] 转换期间宿主 UI 保持响应（Long Task 计数对比数据落档）。
- [ ] 宿主导出全程有三段式进度反馈，无长时间无响应死区。
- [ ] `npm test` 全绿（含同构性与 secrets 字节一致），`npm run build` 无报错。
- [ ] real 实例卡顿诊断报告完成，插件侧因素全部修复。
- [ ] 提交并推送到 origin/main。

## Constraints

- zipIo API 形状兼容优先；上层模块改动最小化（解耦复用）。
- Method 93 (Zstandard) 透明解压能力不得回退。
- Node 测试环境（Vitest）无 Worker 的降级路径必须保留。
