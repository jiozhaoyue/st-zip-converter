# Node 基准局限性说明（防误导记录）

> 2026-09-07 · Node v24.14.1 实测

## 关键发现

1. **vendor `ZipWriter.add` 原生支持并发调用**：并发 6 路 add 50 个随机文件，条目完整性与串行完全一致（50/50 字节级校验通过）。此前 zip-io.js 的自建串行队列是**纯多余限制**——这解释了"一个一个文件处理"的观感。
2. **Node 端基准不可反映浏览器收益**：Node 的 `CompressionStream` 在 libuv 线程池执行但 JS 主线程同步等待，且 vendor 串行 vs 并发在 Node 下耗时相近（886ms vs 973ms，159MB 数据）——因为 Node 中 zip.js 的 `useCompressionStream` 原生路径同样占线程池，Worker 钩子在 Node 测试环境亦不生效。**真实收益必须在浏览器 Playwright 环境测**（浏览器 CompressionStream/Worker 走独立线程，主线程让出 → UI 不卡 + 并发真实并行）。
3. **vendor 写端 `passThrough` 选项在 zip.js 2.9 需要 `uncompressedSize`+`crc32` 前置已知**（错误信息明确要求），对内存 Uint8Array 场景需自算 CRC——不值得，回退为让 vendor 自行压缩。预压缩注入方案（`compressionMethod:8 + level:0` 手动传压缩字节）已验证会产出损坏包（zip.js 写侧会再套一层处理），**放弃该路线**。

## 最终实现取向（据此修正 design.md §2.2）

- zip-io 并发重写 = **移除自建串行队列，直接并发调用 vendor `ZipWriter.add`**，并发度滑动窗口（2~8，hardwareConcurrency 感知）；
- `addLazy` 流式直通保持（zip.js 流式 add 内部走原生 CompressionStream/Worker，浏览器中不占主线程）；
- `waitForSlot` 背压：在飞 >= 并发上限时等任一完成；
- manifest 首条保序：`addFirst` 或调用顺序保证；
- Node 测试环境退化为串行语义无害（正确性等价）；浏览器基准用 Playwright 采集（Phase 5）。
