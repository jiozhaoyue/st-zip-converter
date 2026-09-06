# 调研：UI 现状结构与统一工作台改造输入

> 调研日期：2026-09-07 · 基于插件源码

## 1. 当前 UI 分区（用户痛点对照）

`src/ui/workbench-template.js` 现有结构：

```
1. 宿主酒馆数据导出（Section 1）
   - 细粒度类目勾选 + 快捷预设 + 增量基准 + 分卷 + 文件名 + 2 按钮（下载/存工作区）
2. 工作区数据包管理（workspace-panel-drawer）
   - archive-manager.js 双列表：【已上传/暂存源包】+【已转换生成包】
3. 外部数据包互转（Section 2）
   - 拖放上传 + 类目选择 + 动作预测 + 文件树 + 目标格式/压缩率/分卷/扩展模式 + 转换按钮
```

**用户确认的痛点**：
- "IndexedDB 工作区：暂存 0 个数据包" 与 "工作区数据包管理" 重复（一个状态条一个抽屉，信息重叠）。
- 双列表（source/output 两 role）不足以表达实际来源：上传、宿主导出、转换生成、增量补丁、分卷——全混在两个列表里。
- 宿主导出区与互转区控件重复（类目勾选、分卷、文件名模板两套几乎相同的 UI），按钮各一套。
- 导出动作分散：宿主导出有"立即下载/存工作区"2 个按钮，转换产物另有下载，无统一"待导出"出口。

## 2. 用户拍板的目标形态（问答确认）

1. **单列表 + 来源标签**：唯一工作区区域，统一列表，每条目带来源徽标：`上传` / `宿主导出` / `转换生成` / `增量补丁`（分卷按 metadata 关联主包）。支持来源筛选，跨条目统一操作。
2. **统一转换工作台**：数据源 = 宿主实时拉取 **或** 工作区任意选中包；共用同一套控件（类目勾选、文件名模板、压缩率、分卷、增量基准、扩展模式）；产物统一先进"待导出区"，从那里统一执行下载 / 存工作区 / 写回宿主。
3. **可视化看板**：宿主类目统计（文件数+体积，Luker selection 预检或拉全量后 inspect）+ 工作区 IndexedDB 用量（配额、各包体积列表）都有列表化展示。

## 3. 现有可复用资产（解耦复用要求）

| 模块 | 现状 | 复用方式 |
|------|------|---------|
| `src/ui/archive-manager.js` (268行) | 双列表渲染+载入/下载/删除/再转换回调 | 重构为单列表+来源徽标+筛选器组件，回调协议保留扩展 |
| `src/ui/category-filter.js` (462行) | 类目勾选卡片+预设+联动 | 抽为两处共用组件（宿主源/工作区源同用） |
| `src/core/inspect.js` (271行) | 中央目录预检+类目统计 | 直接用于工作区包与宿主拉回包的可视化统计 |
| `src/storage/db.js` (267行) | files store（role: source/output）+ usage 统计 | role 字段扩为 origin 枚举（upload/host-export/converted/delta/split-part），DB_VERSION 迁移 |
| `src/core/filename-template.js` | 占位符引擎 | 直接复用 |
| `src/core/splitter.js` / `delta.js` | 分卷/增量 | 产物 metadata 标记 origin，进入待导出区 |
| `index.js` (1192行) | 全部事件绑定 | 拆分为 workbench-controller（统一工作台）+ workspace-controller（工作区） |

## 4. 数据模型变更（design 输入）

```js
// db.js record
{
  id, name, size, blob, layout,       // 现有
  origin: 'upload' | 'host-export' | 'converted' | 'delta' | 'split-part',
  group: '<uuid>',                     // 分卷组/增量链归属同一组
  createdAt,
  metadata: { targetLayout, selection, baseZipName, partIndex, partTotal, ... }
}
```

- 迁移：DB_VERSION 1→2，onupgradeneeded 遍历旧记录按 role 映射 origin（source→upload，output→converted）。
- 待导出区不是新 store：它是"选中进入导出队列的条目集合"（内存态 + preferences 持久化 id 列表），避免数据重复存储。

## 5. 交互流（验收基线）

1. 宿主导出：勾选类目（Luker 透传 selection / ST 拉全量后插件过滤）→ 产物直接入待导出区。
2. 上传/拖包：入库 origin=upload，出现在工作区列表。
3. 任意列表条目 → "转为转换任务" → 统一工作台（数据源预填）→ 转换 → 产物 origin=converted 入待导出区。
4. 待导出区：逐条或批量 下载 / 存工作区 / 写回宿主 / 移除。
5. 两个信息抽屉合并为一个"工作区"抽屉：顶部用量看板（IndexedDB 配额条 + 宿主类目统计入口）+ 单列表。
6. 状态条与抽屉不再重复：状态条只显示一句汇总+打开抽屉。

## 6. 约束

- 100% 酒馆原生 `.inline-drawer` 体系 + Font Awesome 图标、0 Emoji（Session 14 既定规范）。
- 移动端 touch target ≥44px、不横向溢出（既有规范）。
- 独立 Web 模式（非插件环境）下统一工作台同样可用（数据源只有上传+工作区）。
- Playwright 回归覆盖上述 5 条交互流。
