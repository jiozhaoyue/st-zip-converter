# ui-unify 终验记录（Playwright 独立 Web 模式，生产构建 preview）

> 2026-09-07 · 全部真机实测

## 1. 静态结构（pw-unified-workspace.cjs）

- 状态条去重：`工作区就绪` 单行汇总 ✓
- 工作区抽屉新标题 `工作区` ✓（旧"工作区数据包管理"双列表消失）
- 待导出区面板 + 空状态文案 ✓
- 用量看板容器 + 空状态 ✓
- `archive-manager-grid` 双栏已不存在 ✓
- 宿主导出卡片在独立模式隐藏 ✓
- 页面 0 Emoji ✓ / 无 JS 错误 ✓

## 2. 全流程闭环（eq-diag 系列 + e2e-fullflow）

上传 ST 包 → 转 L（触发智能分卷）→ 待导出区条目（来源徽标"分卷"）→
"全部存入工作区" → 工作区单列表出现两条：`分卷`徽标产物 + `上传`徽标源包 →
筛选条 `全部(2) 上传(1) 分卷(1)` → 用量看板来源统计
`分卷 1 个 · 1.2 KB` / `上传 1 个 · 585.0 B` → 下载按钮自动入库（"已入库"标记）→
移除条目清空队列 → 全程无 JS 错误。

下载→自动 stash→"已入库"标记 ✓；移除 ✓；批量操作 ✓。

## 3. 发现并修复的问题

1. **独立模式 index.html 是静态硬编码模板**，与 workbench-template.js 漂移：
   新结构（usage-dashboard/export-queue-panel/workspace-archive-list）必须两处同步。
   已同步 index.html。→ spec 更新项。
2. `Cannot access 'Ee' before initialization`：usageDashboardEl/exportQueuePanel
   赋值先于声明（let 提升死区）→ 改为 const 直接初始化。
3. stash 在存储不可用（Node 降级）时误标已入库 → saveFile 返回 null 判定。
4. split 路径（外部互转）绕过待导出区直接 saveFile + 弹 modal → 已统一入队
   （来源 split-part），废弃 renderSplitDeliveryModal 调用点（组件保留兼容）。

## 4. 回归

- npm test：23 套件 **137 passed / 2 skipped** 全绿。
- npm run build：无警告。
- 截图：unified-workspace-check.png / e2e-fullflow.png。

## 5. 遗留

- 插件态（宿主环境）人工终验：通过 Git 更新实例插件后观察统一工作台 +
  宿主导出 → 待导出区 → 写回宿主路径（本次已验证按钮回调接线，逻辑同独立模式）。
- export-queue 的 preferences 持久化（刷新后恢复队列）未实现：队列是内存态 +
  ephemeral 自动入库策略，刷新丢失未入库临时产物，符合"统一出口"最小实现；
  若需要刷新恢复可作后续增强。
