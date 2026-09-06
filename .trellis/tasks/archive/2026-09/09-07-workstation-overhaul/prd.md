# 全能数据包工作站统一重构与性能优化（父任务）

## Goal

将 st-zip-converter 从"功能堆叠"状态收敛为统一、高性能、宿主感知的数据包工作站：

1. **UI 统一**：工作区收敛为单列表+来源标签；宿主导出与外部互转合并为统一转换工作台；统一待导出区出口；宿主类目与工作区用量可视化。
2. **性能**：重写 zip-io 写入管线（Web Worker 多线程 + 流式直通 + 并行写入），消除主线程逐文件串行；排查插件导致的 real 实例卡顿并全修，实例侧出诊断报告。
3. **宿主感知**：可靠区分 ST / Luker 宿主（当前 Luker 必然被误判为 ST），保证导出数据包正确；查明 Luker 前端 UI 异常原因。

每个交付物独立验收，全部完成后推送到 origin/main。

## Background（调研结论摘要）

- 详细调研见 `research/` 下三份文件（host-detection-and-luker-ui / perf-pipeline-analysis / ui-current-state-and-target）。
- 关键事实：
  - Luker 前端暴露 `globalThis.SillyTavern`（Luker `public/script.js:360`），插件 `detectHost()` 依赖的 `window.luker`/`#luker-app` 信号不存在 → Luker 被误判为 ST。
  - ST 备份端点忽略 selection 全量导出；Luker 支持 selection+manifest → 宿主不区分则导出行为错误。
  - `zip-io.js` `useWebWorkers: false` + 串行队列 + 逐文件内存读入 → 导出慢、UI 卡。
  - "IndexedDB 工作区：暂存 0 个数据包" 状态条与 "工作区数据包管理" 抽屉信息重复。

## 子任务映射（依赖顺序）

| 子任务 | 交付物 | 依赖 |
|--------|--------|------|
| `09-07-host-detect` | detectHost 修复 + 宿主能力适配 + Luker UI 异常根因 | 无（最先做，其结论决定 ui-unify 的宿主分支行为） |
| `09-07-perf-overhaul` | zip-io 管线重写 + 卡顿修复 + 实例诊断报告 | 无（可与 host-detect 并行） |
| `09-07-ui-unify` | 单列表工作区 + 统一转换工作台 + 待导出区 + 可视化 | host-detect（宿主分支）、perf-overhaul（新管线 API） |

执行顺序：host-detect → perf-overhaul → ui-unify（串行，降低合并冲突；若 perf 与 host 互不碰文件可并行）。

## 跨子任务验收标准（父任务级）

- [ ] 三个子任务各自验收全过并归档。
- [ ] 全量测试绿：`npm test`（现有 105 项 + 新增测试）。
- [ ] `npm run build` 无警告无报错。
- [ ] Playwright 自动化回归通过（独立 Web 模式全流程 + 双宿主实例识别验证）。
- [ ] 现有功能零回归：ST/L/TT/PT 四格式互转、增量导出、分卷、备份聊天过滤、扩展轻量清单。
- [ ] 全站 0 Emoji、100% 原生 `.inline-drawer` 体系保持。
- [ ] 所有提交推送到 origin/main（每个子任务完成即推送）。

## Constraints

- 遵守项目规范：禁止直接操作本地酒馆实例目录（实例只读调研、Git 交付）；diff 工具编辑；交互式问答决策。
- 实例侧问题不改动实例目录，只出报告。
- 移动端适配规范不回退（touch ≥44px）。

## Notes

- 复杂任务：三个子任务各自需要 prd/design/implement 三件套。
- 本任务统筹跨子任务验收与最终集成审查，自身无直接实现工作。
