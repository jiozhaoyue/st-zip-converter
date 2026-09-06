# 技术设计：统一工作区与转换工作台

## 1. 目标信息架构

```
扩展抽屉（宿主环境）/ 页面（独立模式）
├── 统一转换工作台（合并原 Section1 宿主导出 + Section2 外部互转）
│   ├── 数据源选择: [从宿主拉取] [从工作区选择] [上传新包]
│   ├── 类目勾选（共用组件，ST 宿主源时标注"插件内过滤"）
│   ├── 输出设置: 目标格式 / 文件名模板+芯片 / 压缩率 / 分卷 / 扩展模式 / 增量基准 / 备份聊天
│   └── [开始转换/导出] → 产物入待导出区
├── 待导出区（新子抽屉）
│   └── 条目列表（名字/大小/目标格式）: [下载] [存工作区] [写回宿主] [移除]，支持全选批量
└── 工作区（唯一数据抽屉，合并原状态条+管理抽屉）
    ├── 用量看板: IndexedDB 配额条 + 宿主类目统计入口
    └── 单列表（来源徽标: 上传/宿主导出/转换生成/增量补丁 + 筛选器）
        └── 行操作: 载入为转换任务 / 下载 / 写回宿主 / 删除
状态条（抽屉外）: 一句汇总（N 个包 · 用量）+ [打开工作区] —— 不再重复列表信息
```

## 2. 数据模型（src/storage/db.js）

```js
// DB_VERSION 1 → 2
// files store record 增加:
origin: 'upload' | 'host-export' | 'converted' | 'delta' | 'split-part',
group: string | null,     // 分卷组 id / 增量链 id
createdAt: number,
// 迁移 onupgradeneeded(v1→v2): 游标遍历，role:'source'→origin:'upload'，role:'output'→origin:'converted'
//   metadata 里已有 split/delta 标记的改判 origin='split-part'/'delta'，group 从 metadata 提取
```

- 读取层加兼容：`normalizeRecord()` 保证 v1 残留记录（升级中断）也能显示。
- usage 统计（现有 getUsage）扩展：按 origin 分组计数与字节。

## 3. 组件拆分

| 新组件 | 职责 | 来源/复用 |
|--------|------|----------|
| `src/ui/workbench-template.js` 重写 | 新信息架构模板 | 现模板重构，保留类目面板部分 |
| `src/ui/source-picker.js` 新增 | 数据源选择（宿主/工作区/上传）三态卡片 | host-bridge 的 fetchHostBackup + archive-manager 的载入回调 + file-drop |
| `src/ui/category-filter.js` 微调 | 保持类目组件，增加"过滤执行位置"标注位（ST 宿主源） | 现有 462 行主体复用 |
| `src/ui/export-queue.js` 新增 | 待导出区组件：条目列表+批量操作 | 下载复用现有 blob 下载逻辑；写回宿主复用 restoreToHost |
| `src/ui/archive-manager.js` 重构 | 单列表+徽标+筛选 | 现双列表逻辑收敛，回调协议保留扩展 |
| `src/ui/usage-dashboard.js` 新增 | 配额条+包列表+宿主类目统计 | db.getUsage + inspect.js 类目统计 |
| `index.js` 瘦身 | 只留装配线 | 事件绑定拆到三个 controller |

```
src/ui/controllers/
  workbench-controller.js   # 统一工作台绑定（源选择→控件→转换→入队）
  workspace-controller.js   # 工作区列表/筛选/行操作
  export-queue-controller.js # 待导出区绑定
```

## 4. 待导出区状态机

```js
// export-queue-controller.js
// 内存态: [{ id, name, blob, targetLayout, origin, autoDownload }]
// 持久化: preferences store 存 id 列表 + 元数据（blob 本体不复制，id 引用 files store 里的记录；
//         "仅下载不入库"的产物在下载动作时才临时写 files store（origin='converted', ephemeral 标记））
// 动作:
//   download(item|all)   → 逐个触发浏览器下载（分卷组按序延时）
//   stash(item|all)      → 标记 ephemeral=false 永久入库（已是 origin 记录则空操作）
//   restore(item|all)    → restoreToHost(blob, {platform: host.platform})（仅插件环境可用）
//   remove(item)         → ephemeral 记录连带删除
// 自动下载快捷勾选: 转换完成即 download + stash，兼容原"导出并立即下载"习惯
```

## 5. 关键流程

### 5.1 宿主拉取直出（ST 宿主）

```
源=宿主 → detectHost()=st (host-detect 修正后)
→ fetchHostBackup('st') 全量流式拉取（perf-overhaul 三段进度）
→ transform(blob, { selection })   // 插件内类目过滤（与外部互转同一路径）
→ split? / delta? 处理（现链路复用）
→ 产物入待导出区（origin='host-export'）
```

### 5.2 工作区包再转换

```
工作区列表 → [载入为转换任务] → 工作台数据源预填该包 → 控件区（源包已含内容，类目从 inspect 实测统计）
→ transform → 产物 origin='converted' 入待导出区
```

### 5.3 分卷/增量组展示

- splitter/delta 产物 group 同 id；列表按 group 折叠显示"分卷 1/N"徽标，展开逐卷操作。

## 6. 样式与规范

- 所有新组件沿用原生类名（`.inline-drawer`/`.menu_button`/`.checkbox_label`/`.text_pole`）与 SmartTheme 变量。
- 新增 CSS 一律前缀作用于插件根容器（配合 host-detect 的样式作用域化成果）。
- 0 Emoji；图标 Font Awesome 6；触控 ≥44px；单列堆叠断点沿用。

## 7. 测试设计

- 单测（test/）：
  - `db-migration.test.js`：v1 记录 → v2 origin 映射、残留兼容。
  - `export-queue.test.js`：入队/出队/批量/ephemeral 生命周期。
  - `archive-manager.test.js`：单列表渲染与筛选逻辑（jsdom）。
- Playwright：
  - `workbench.spec.js`：上传→转换→待导出→下载 全流程。
  - `workspace.spec.js`：来源徽标、筛选、迁移后旧数据显示。
  - `host-flow.spec.js`（插件环境，双实例）：宿主拉取→待导出→写回宿主。

## 8. 风险与回滚

- index.js 拆分是最大风险面：以"先抽 controller 后改模板"两步走，每步测试绿再进。
- DB 迁移失败兜底：openDb onupgradeneeded try/catch，失败时降级只读模式并告警，不清库。
- 回滚：模板/控制器/存储三块分 commit，可独立 revert；DB_VERSION 迁移不可逆设计（只加字段不删），旧代码读 v2 库兼容（多余字段忽略）——回滚旧版本也不丢数据。
