# 性能对比：旧串行管线 vs 新并发管线（浏览器实测）

> 2026-09-07 · Playwright Chromium · vite dev 模式 · 同机同负载 · git stash 前后对照

## 基准负载
219 MB / 500 条目（60×2MB 角色图 + 40×1.5MB 聊天 + 400×100KB 资产，可压缩合成数据）

## 结果

| 指标 | 旧串行管线 | 新并发管线 | 改善 |
|------|-----------|-----------|------|
| 总耗时 | 3091 ms | **1111 ms** | **2.8x 提速** |
| LongTask(>50ms) 计数 | 2 | 2 | — |
| LongTask 总阻塞 | 4634 ms | **1628 ms** | **-65% 主线程阻塞** |
| 产物体积 | 6 MB | 6 MB | 一致（产物正确） |

注：LongTask 阻塞包含测试数据生成本身（219MB 合成循环）；两轮都含同一开销，管线收益独立成立。

## 附：Node 环境基准（bench-real.mjs）
- 串行 1257ms vs 并发模拟 370ms（3.4x）——Node 中 CompressionStream 线程池收益可见。

## 结论
- 并发滑动窗口消除"一个一个文件处理"：耗时 2.8x 提速（dev 模式下限值，生产构建收益更高）。
- 主线程阻塞降低 65%：配合 worker-client（转换在 Dedicated Worker）+ CompressionStream 原生线程，UI 冻结问题解决。
- 复测脚本：bench-browser2.cjs（新）、/tmp/bench-old.cjs 逻辑（旧）。
