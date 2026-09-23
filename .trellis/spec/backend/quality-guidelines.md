# Quality Guidelines（测试矩阵、守卫与禁止模式）

> 验证标准、测试矩阵、数据保真约束与禁止模式。

---

## Overview

`st-zip-converter` 处理的是用户的**真实数据**（聊天记录、角色卡、人设图、API 密钥），且会被装进别人的酒馆里运行，因此正确性、数据保真与内存安全是第一优先。

---

## Testing Matrix

改动 `src/core/`、`src/storage/`、`src/ui/` 或根 `index.js` 后必须跑完整验证矩阵：

| 类别 | 命令 | 目的 |
|---|---|---|
| 单元 / 集成 | `npm test` | Vitest 全量：当前 **34 个文件 / 226 passed / 2 skipped** |
| 单文件 | `npx vitest run test/xxx.test.js` | 只跑一个文件（调试用） |
| 单条用例 | `npx vitest run -t "用例名"` | 只跑一条用例 |
| CSS 作用域守卫 | `npm run check:css-scope` | 断言 `style.css` 每条规则都带 `.app-container` 或 `.st-converter-drawer-app` 前缀 |
| DOM 注入守卫 | `npm run check:dom-injection` | 断言 `src/ui/**` 与根 `index.js` 中进 `innerHTML` 的插值都经 `escapeHtml()` / `trustedStaticMarkup()` |
| 固件重建 | `npm run gen-fixtures` | 重新生成 `fixtures/` 下的四平台测试包 |

与 secrets 保真直接相关的现有用例：

- `test/convert.test.js`：以 `Buffer.compare` 断言各目标产物内 `secrets.json` 与源字节一致。
- `test/filter.test.js`：断言取消勾选 `secrets` 后产物不含 `secrets.json`，且报告 `filtered` 中登记该项。
- **待验证**：浏览器侧峰值内存**没有**自动化门禁（仓库中不存在 `test/termux.test.js` 之类的堆预算用例）。若要重建内存门禁，验证方法是：写 Playwright 基准脚本 → 对 >900MiB 的真实包跑 `runConversionTask` → 用 `performance.measureUserAgentSpecificMemory()` 采样峰值。

---

## Forbidden Patterns

1. **`src/core/` 内的 I/O 依赖**（**不是“禁止一切 Node 引用”**——旧稿曾错写“命中数为 0”，实际并非如此）：
   - ❌ 顶层静态引用：`import fs from 'node:fs'`、`require(...)`、顶层 `process.*`
   - ❌ 直接读写文件而不经适配器接缝
   - ✅ 经 `options.io` 注入 IO 适配器（缺省为 `zipIo`）
   - ✅ **本仓既有的合法例外**：运行时守卫 + **动态** import，仅在 Node 专属分支内求值。
     实例（两处，仅此两处）：`src/core/zip-io.js:92`（`typeof source === 'string'` 时 `await import('node:fs/promises')` 读文件）、
     `src/core/zip-io.js:259`（`isFilePath` 时 `await import('node:fs/promises')` 写文件）。
     **副作用是预期的**：浏览器构建时 Vite 会将其 externalize，`npm run build` 日志出现
     `Module "node:fs/promises" has been externalized for browser compatibility` —— 属正常提示，不是缺陷。
     自查命令（命中应为 **2**，且必须在动态 import 内）：
     ```bash
     grep -rn "node:fs" src/
     ```
2. **整包驻留内存**：
   - ❌ 把整个 zip 读成单个 `ArrayBuffer` / `Buffer` 再处理
   - ✅ 逐条目处理；大条目走 `addLazy` 惰性流直通（`src/core/zip-io.js`）
3. **zip 包内路径使用 Windows 反斜杠**：
   - ❌ 用 `\` 作为条目分隔符
   - ✅ 一律 `/`；消费外部路径先用 `replace(/\\/g, '/')` 归一（现有实现见 `inspect.js` / `splitter.js` / `builtin-assets.js`）
4. **篡改 `secrets.json`**：
   - ❌ 静默剥离、掩码或改写内容
   - ✅ 默认字节保真；只有用户显式取消 `secrets` 类目时才排除，并在报告 `filtered` 中留痕
5. **改动 `src/vendor/`**：
   - ❌ 升级或修改 `src/vendor/zip.js`、`src/vendor/fzstd.js`
   - ✅ 只用其已有 API；需要新能力时改封装层 `src/core/zip-io.js`

---

## Required Patterns

1. **路径归一**：
   ```javascript
   const normalized = entryPath.replace(/\\/g, '/').replace(/^\/+/, '');
   ```
2. **确定性合成元数据**：所有合成条目（目标 `manifest.json`、`data/_tauritavern/extension-sources/`、`_convert/*`）必须使用固定时间戳 `FIXED_TIMESTAMP = '2020-01-01T00:00:00.000Z'` 并按名字排序，保证相同输入产出相同包体。
3. **检测与转换分两次开包**：zip 读取游标不可倒回——`convert()` 先用一个 reader 跑 `detectFromReader`，`finally` 中 `close()`，再重新 `openReader` 走主循环（见 `transform.js`）。任何“边扫描目录边读条目”的写法都是错的。
4. **reader 必须 `close()`**：`for await` 结束后与异常抛出时都要释放（`try/finally`）。

---

## Pre-Development Checklist

改 `src/core/` 前：
- [ ] 读本目录的 `directory-structure.md` 与 `database-guidelines.md`，确认布局与存储契约。
- [ ] 新增目标平台或转换规则时，确认 `secrets.json` 不被改动。
- [ ] 确认没有把 Node 专有 API 引入 `src/core/`。
- [ ] 注意：`.trellis/spec/guides/tavern-datapack-formats.md` 仍含旧架构表述（node-io / yauzl / yazl），**引用其格式事实前必须先核对源码**。

---

## Quality Check

改动后：
- [ ] `npm test` 全绿（零失败）。
- [ ] `npm run check:css-scope` 退出码 0。
- [ ] `npm run check:dom-injection` 退出码 0。
- [ ] 若改了 UI 结构：确认 `index.html` 与 `src/ui/workbench-template.js` **同源同改**（grep 新 id 两处均须命中）。

---

## Zip IO Concurrency Mandate (2026-09-07)

**zip-io.js 写入管线禁止重新引入串行队列。** 实测结论（见 tasks/archive/2026-09/09-07-perf-overhaul/research/）：

1. vendor zip.js `ZipWriter.add` 原生支持并发调用（内部自带互斥），并发 50 条目字节级校验一致。旧的 `queue.then(task)` 串行链是"一个一个文件处理"的根因（浏览器实测 2.8x 提速来自移除它）。
2. 并发度 = `max(2, min(8, navigator.hardwareConcurrency || 6))`（非浏览器环境取 6），`waitForSlot()` 背压：在飞条目达上限时 `Promise.race(inflight)` 等任一完成。
3. 首条目保序：第一个 add/addLazy 独占写入完成后才放开并发（恢复端 manifest 处理依赖包首条目）。
4. **禁止预压缩注入**：手动 `deflate-raw` 后以 `compressionMethod:8 + level:0` 传入会产生损坏包；vendor 写端 `passThrough` 需要调用方提供 `uncompressedSize`+`crc32`，内存场景不值得。
5. 大 Blob IndexedDB 写入（≥16MB）走 `saveFile` 内部串行队列，与转换热路径解耦。
6. Node/Vitest 环境 Worker 不生效（基准不反映浏览器收益），性能验证必须用 Playwright 浏览器基准。
