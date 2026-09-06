# 技术设计：导出管线性能重写

## 1. 现状瓶颈定位（src/core/zip-io.js）

| # | 瓶颈 | 位置 | 修复 |
|---|------|------|------|
| 1 | `useWebWorkers: false` 主线程压缩 | L11 | 开启 Worker；方案 B 备选 |
| 2 | 串行队列 `queue.then(task)` | L106-113 | 并发滑动窗口 |
| 3 | `writer.add` 全量内存读入 | L120 | 流式 pipe |
| 4 | `addLazy` TransformStream `highWaterMark:1` 背压过小 | L127 | 增大缓冲 |
| 5 | chunkSize 64KB 偏小 | vendor 默认 | configure 调大（128~512KB） |
| 6 | 日志/IDB 主线程阻塞 | log-console.js / db.js | 节流 + 后台化 |

## 2. 新写入管线

### 2.1 Worker 启用（方案 A 优先）

```
方案 A: zip.configure({ useWebWorkers: true, maxWorkers: navigator.hardwareConcurrency ?? 4, chunkSize: 262144 })
        风险：vendor zip.js 内联打包，workerURI './core/web-worker-wasm.js' 相对路径在扩展环境失效
        验证：vite build 后在浏览器实测 Worker 压缩路径是否生效（zip.js 内部 fallback 到主线程时不报错，需主动断言）
方案 B（A 失败时）: 自建 worker 池
        new Worker(new URL('./converter-worker.js', import.meta.url), { type: 'module' })
        vite 原生支持该语法，产出独立 chunk；worker 内 import zlib-wasm 或用 CompressionStream
判定标准写入 implement.md Phase 1，实测后锁定方案
```

### 2.2 并发写入器（替换 createWriter 内部实现）

```js
// 伪代码 —— 对外 API 不变
const CONCURRENCY = 6;
let active = 0; const waiting = [];
async function acquire() { active < CONCURRENCY ? active++ : await slot(); }
function release() { active--; next(); }

async add(name, data) {            // 内存条目（合成 JSON 等小对象）
  if (written.has(name)) return; written.add(name);
  await acquire();
  try { await writer.add(name, new zip.Uint8ArrayReader(data)); } finally { release(); }
}
addLazy(name, openFn) {            // 流式条目（pass-through 大文件）
  if (written.has(name)) return; written.add(name);
  await acquire();
  const { readable, writable } = new TransformStream({}, { highWaterMark: 16 });
  const p = writer.add(name, readable);          // zip.js add 支持并发调用
  openFn((err, src) => err ? writable.abort(err) : src.pipeTo(writable));
  enqueue tracking: p.finally(release)            // 完成计数而非串行链
}
```

- **顺序敏感处理**：manifest.json 等首条目在第一个 acquire 前 add（zip.js 中央目录顺序影响恢复端 manifest 跳过逻辑的可见性，保持"manifest 先入"现状）。
- **背压**：`waitForRoom()` 保留（等 active 归零或水位），transform.js 在任务间调用防内存堆积。
- written 去重、abort、close 语义不变。

### 2.3 流式直通（transform.js 配合，最小改动）

- transform.js `pass-through` 分支已走 `addLazy(entry.openStream)`——保持，仅受益于新并发器与增大缓冲。
- `read()` 全量路径仅存在于需要解析内容的条目（settings.json、字符卡 JSON），不动。
- level=0：zip.js Store 模式本就不压缩，Worker 负载天然为零，无需特判。

## 3. 三段式进度（host-bridge.js fetchHostBackup）

```js
const response = await fetch(...);
const total = +response.headers.get('Content-Length') || 0;
const reader = response.body.getReader();   // 流式读���边收边计
// 阶段1: 宿主生成 —— 首字节到达前 (TTFB) 显示"宿主正在打包..."
// 阶段2: 传输 —— received/total 进度条
// 阶段3: 插件处理 —— transform 阶段现有 setProgress
```

- Luker selection 导出与 ST 全量导出同路径受益。
- Content-Length 缺失（chunked）时显示已收 MB 数。

## 4. 卡顿修复

- **log-console.js**：push 改为入环形缓冲，requestAnimationFrame 批量渲染，单帧上限 50 行，超限折叠"+N more"；download/copy 从缓冲全量取。
- **db.js saveFile**：大 Blob put 放入 `navigator.locks`/简单队列串行后台执行，UI 调用立即返回 promise（已有异步，主要避免转换热路径同步等待大 put——调用点从 await 链摘除）。
- **converter-worker.js 现状核对**：确认其使用路径与新管线不冲突（Node 降级仍走旧串行路径，语义不变）。

## 5. 基准与验证

```bash
node fixtures/gen.js --big          # 若脚本不支持大包参数，补参数（仅测试夹具脚本，可改）
node --exposure-gc bench.mjs        # 或 vitest bench；记录：耗时/峰值RSS/LongTask
```

- 基准对照表落 `research/perf-baseline.md`（优化前）与 `research/perf-after.md`。
- Playwright Long Task 采集：`PerformanceObserver({entryTypes:['longtask']})` 注入页面，转换期间计数。
- 回归铁门槛：`npm test`（105+）、zipjs-io 同构性、secrets 字节一致。

## 6. 兼容与回滚

- zipIo 对外签名不变 → delta.js/splitter.js/inspect.js 零改动预期；若 addLazy 语义微调（并发后完成顺序不再确定），close 时全量 await 保序收尾，manifest 首条已单独保序。
- 回滚：新 zip-io 与进度改动分 commit，可独立 revert。
