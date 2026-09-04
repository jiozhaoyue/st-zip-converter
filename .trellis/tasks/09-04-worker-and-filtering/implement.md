# 执行计划: Web Worker 多线程加速与独立模式类目选择性导出

> 目标: 落地中央目录毫秒级预检、类目细粒度选择过滤、Web Worker 多线程异步解压压缩与安全脱敏 UI。

---

## Phase 1: 预检统计与选择性过滤核心引擎 (`src/core/`) ✅
- [x] 1.1 实现 `src/core/inspect.js`：零拷贝中央目录预检函数 `inspectArchive(source)`，分类统计各类目文件数量与字节大小。
- [x] 1.2 增强 `src/core/report.js`：扩充 `filtered` 记录与统计字典，输出脱敏/排除文件清单。
- [x] 1.3 增强 `src/core/transform.js`：支持 `options.selection` 参数，实现按类目过滤与条目直接 `skip()`，同步更新目标 `manifest.json`。
- [x] 1.4 编写单测 `test/filter.test.js`：全面覆盖类目统计、脱敏提取（如无 secrets / 无聊天记录）、全平台互转验证。

## Phase 2: Web Worker 异步多线程流水线 (`src/core/`) ✅
- [x] 2.1 实现 `src/core/converter-worker.js`：Dedicated Web Worker 服务，封装独立的 `convert` 执行环境。
- [x] 2.2 实现 `src/core/worker-client.js`：主线程 Worker 客户端，支持进度事件订阅、Promise 转换控制与环境探测（浏览器 Worker vs Node fallback）。
- [x] 2.3 验证大包多线程测试：确保多线程 Worker 运行流畅，并在 Vite 环境下打包无异常。

## Phase 3: UI 资产面板与脱敏过滤器 (`src/ui/`) ✅
- [x] 3.1 更新 `index.html` 与 `style.css`：新增 `#category-panel` 容器、类目选择网格与快速预设按钮组（全部、仅角色卡、安全脱敏等）。
- [x] 3.2 实现 `src/ui/category-filter.js`：负责监听文件变化、调用 `inspectArchive` 渲染类目统计卡片、维护选中状态。
- [x] 3.3 汇聚到 `index.js`：在转换触发时提取用户选中的类目配置，传递给 Worker / 转换引擎。

## Phase 4: 全链路回归、测试与构建验证 ✅
- [x] 4.1 运行全量单元测试 `npm test`，确保新老用例 100% 通过（56 passed）。
- [x] 4.2 执行 Vite 构建 `npm run build`，确保 Worker 与所有组件打包无报错（674ms）。
- [x] 4.3 更新相关 Trellis spec 文档，记录类目过滤与 Worker 架构。
