# 扩展迁移与云端批量恢复规划

## 总体边界

父任务只负责规划、证据归拢和跨子任务验收矩阵。具体实施拆给子任务，且每个子任务在最终规划获批后才可 `task.py start`。

## 子任务地图

| 子任务 | 目标 | 状态 |
| --- | --- | --- |
| `09-23-extension-manifest-git` | 明确“只导出扩展列表 / 清单模式”与 `.git` 保留、剔除、迁移后在线更新能力的语义 | planning |
| `09-22-extension-git-slim` | 既有任务：在 FULL 包中提供 `.git` 处理策略并验证 minimal 可行性 | planning，待 OQ 决策 |
| 待建：`batch-restore-refresh` | 设计多 ZIP / 分卷恢复编排、失败重试和公开契约允许下的一次性刷新引导 | 待创建 |
| 待建：`authority-cloud-transfer` | 基于 transfer / blob / private file / jobs / events 设计可选后台暂存与云端部署优化 | 待创建 |
| 待建：`perf-security-audit` | 审查恢复链路、Authority 适配器、分卷和 DOM 高频路径，形成证据报告 | 待创建 |

## 关键技术约束

- `restoreToHost()` 当前公开入口只能接收完整 ZIP；没有证据表明多次 multipart 请求能被宿主拼成一个 ZIP。
- 独立 ZIP 分卷适合“逐个导入”，但顺序、失败续跑和最终一致性必须由 UI 任务状态显式表达，不能声称原子。
- Authority transfer/blob 可优化扩展自身的暂存与跨端传递，不能静默写入酒馆用户事实源目录（L1-MR-2）。
- 恢复后刷新只使用宿主公开 UI/API；如果无公开机制，产品行为应是“恢复完成后提示用户刷新/重载”，而不是前端 hook 宿主内部（L1-MR-4 / L1-MR-5）。

## 验收与证据

- 每个研究结论需落盘到对应任务 `research/`。
- 实施前必须补上下文清单（inline 模式除外）。
- 实例验证只允许 Dev 实例，且需单独批准；所有自动化不得触碰 `Instance/Real/**`。
