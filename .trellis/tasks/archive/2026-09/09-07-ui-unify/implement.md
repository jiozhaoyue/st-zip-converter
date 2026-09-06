# 执行计划：统一工作区与转换工作台

## 前置确认

- [ ] 0.1 子任务 09-07-host-detect 已归档（platform 修正、ST 过滤分支、样式作用域化成果在库）
- [ ] 0.2 子任务 09-07-perf-overhaul 已归档（zipIo 并发语义、三段进度回调 API 在库）

## Phase 1：存储层（最底层，先行）

- [ ] 1.1 db.js：origin/group/createdAt 字段 + DB_VERSION 2 迁移 + normalizeRecord 兼容 + getUsage 按 origin 分组
- [ ] 1.2 `test/db-migration.test.js`（v1→v2 映射、残留兼容、usage 分组）
- [ ] 1.3 `npm test` 绿

## Phase 2：index.js 拆分（先抽不改）

- [ ] 2.1 事件绑定拆出 `src/ui/controllers/workspace-controller.js`（工作区/上传/列表现有行为原样迁移）
- [ ] 2.2 拆出 `export-queue-controller.js` 骨架（暂只承接现有下载/存工作区按钮路径）
- [ ] 2.3 拆出 `workbench-controller.js`（宿主导出+互转现有行为原样迁移）
- [ ] 2.4 index.js 只留装配；`npm test` + build 绿（行为零变化检查点）

## Phase 3：模板重构与统一工作台

- [ ] 3.1 workbench-template.js 新信息架构（design §1）：合并两个区块为统一工作台
- [ ] 3.2 source-picker.js：宿主拉取/工作区选择/上传三态数据源
- [ ] 3.3 category-filter 标注位（ST 宿主源"插件内过滤"提示）；文件名/压缩率/分卷/扩展模式/增量基准控件单套化
- [ ] 3.4 workbench-controller 接线：宿主直出/工作区包/上传包三条转换流 → 产物入待导出区
- [ ] 3.5 ST 宿主分支：全量拉回+插件内 selection 过滤（调 host-detect 成果）；Luker 透传

## Phase 4：待导出区

- [ ] 4.1 export-queue.js 组件 + controller 完整状态机（download/stash/restore/remove/批量/自动下载勾选）
- [ ] 4.2 分卷组/增量链在待导出区的组展示与按序下载
- [ ] 4.3 `test/export-queue.test.js`

## Phase 5：工作区单列表与用量看板

- [ ] 5.1 archive-manager 重构：单列表+来源徽标+筛选+行操作（载入为转换任务/下载/写回宿主/删除）
- [ ] 5.2 usage-dashboard.js：配额条+包列表+宿主类目统计入口（inspect 复用）
- [ ] 5.3 状态条去重（一句汇总+打开入口）；删除旧双列表模板
- [ ] 5.4 `test/archive-manager.test.js` 更新

## Phase 6：样式与规范

- [ ] 6.1 新组件样式全部前缀化作用域；原生类名/主题变量沿用
- [ ] 6.2 0 Emoji 扫描、touch ≥44px、移动端断点、无横向溢出检查

## Phase 7：端到端验证与交付

- [ ] 7.1 Playwright：workbench.spec / workspace.spec 全流程
- [ ] 7.2 Playwright 双实例：host-flow.spec（宿主拉取→待导出→写回）
- [ ] 7.3 旧库升级实测（预置 v1 数据 → 打开插件 → 列表完整）
- [ ] 7.4 `npm test` 全绿 + `npm run build` 无报错
- [ ] 7.5 spec 更新判断（组件拆分约定、待导出区模式写入 frontend 规范）
- [ ] 7.6 batched commit（分 Phase 组）→ 用户确认 → 推送 origin/main

## 回滚点

- Phase 1/2/3-4/5-6 各一组 commit；Phase 2 是零行为检查点，任何后续异常可退回该点。

## 验证命令

```bash
npm test
npm run build
npx playwright test tests/e2e/workbench.spec.js tests/e2e/workspace.spec.js
npx playwright test tests/e2e/host-flow.spec.js   # 需本地双实例
```
