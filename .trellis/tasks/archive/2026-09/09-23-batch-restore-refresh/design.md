# 批量恢复编排设计草案

## 数据流

```
多选 ZIP / 分卷 → 工作区（IndexedDB, origin=upload/split-part）
  → 恢复队列（按序） → restoreToHost(blob, {mode}) 逐项
  → 成功/失败记录 → 全部完成 → 刷新引导
```

## 编排状态机

`queued → running → (item-done | item-failed) → done | partial-failed | aborted`

- 每项恢复独立记录结果；失败项可单独重跑，成功项不重复。
- 中止语义复用 TaskManager：abort 当前 fetch，保留已完成项的记录。

## 诚实性约束

- 逐卷恢复期间 UI 显示“已完成 x/N（部分数据已生效）”，绝不显示“合并完成”。
- 最终刷新引导只在全部成功后出现。

## 研究前置

实施前必须先完成 OQ-1 研究（宿主公开恢复/刷新契约），结论落盘 `research/`。
