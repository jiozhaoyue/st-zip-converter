# IndexedDB 工作区与完全扫描预测架构设计

## 1. 架构总览

```
[ 用户 Zip 输入 / 恢复 ]
         │
         ├──► [ IndexedDB Storage ] (files / workspace / preferences)
         │           ▲
         │           └── 页面刷新时秒级还原
         │
         ▼
[ 完全扫描规划引擎 (Plan Preview) ]
         │
         ├── 遍历中央目录 (零拷贝)
         ├── 计算目标路由路径 targetPath
         ├── 分类 action: COPY | ROUTE | MIGRATE | SYNTHESIZE | DROP | FILTER
         │
         ▼
[ 可穿透树形选择器 (Tree Picker) ]
         │
         ├── 10 大标准类目 + 缓存/备份/私有独立组
         ├── 单文件展开列表 (可单独反选单个文件)
         ├── 实时搜索过滤
         │
         ▼
[ 转换执行引擎 (convert / Worker) ]
         │
         ├── 接收 categorySelection 与 excludedFilePaths
         └── 产出精准转换包与下载/暂存
```

## 2. IndexedDB 存储规范

- **数据库名**: `st_zip_converter_db`, Version: `1`
- **Stores**:
  - `files`: `{ id (string), name, size, lastModified, blob, layout, createdAt }`
  - `workspace`: `{ key: 'current', fileId, target, selection, excludedPaths, report, resultBlobId }`
  - `preferences`: `{ key: 'user_prefs', target, rememberSelection, selection }`

## 3. 规划预测模型 (Plan Preview Model)

对于源包中的每一个非目录 entry：
```typescript
interface PlanItem {
  sourcePath: string;
  sizeBytes: number;
  category: string; // 10 大标准类目之一，或 'cache' | 'backups' | 'private'
  targetPath: string | null; // 在目标布局中的预期路径，若 DROP 则为 null
  action: 'COPY' | 'ROUTE' | 'MIGRATE' | 'SYNTHESIZE' | 'DROP';
  reason?: string; // 例如 "用户级扩展迁移到 third-party", "TT 派生缓存丢弃"
  selected: boolean;
}

interface ConversionPlan {
  sourceLayout: string;
  targetLayout: string;
  totalSourceFiles: number;
  totalSourceBytes: number;
  estimatedOutputFiles: number;
  estimatedOutputBytes: number;
  itemsByCategory: Record<string, PlanItem[]>;
  synthesizedItems: PlanItem[];
  droppedItems: PlanItem[];
}
```

## 4. 转换引擎扩展

`convert(source, targetPath, options)` 中增加：
- `excludedPaths?: Set<string>`: 用户在单项穿透列表中取消勾选的文件路径（匹配 `routed.hubPath` 或原始 `entry.fileName`）。
- `includeCache?: boolean` (替代单一 keepAll)
- `includeBackups?: boolean`
- `includeAppPrivate?: boolean`

## 5. UI 交互体验

- 顶部显示：`💾 工作区已暂存 1 个数据包 (18.2 MB) [清空]`。
- 类目卡片下方增加：`[展开 12 个文件明细 ▼]`。
- 展开后展示带搜索框的文件列表，每个条目带有操作标签 `[直通]`, `[路由]`, `[迁移]`, `[丢弃]`。
- 用户取消某单张角色卡，总类目复选框变为半选 `-`，并动态更新预计输出文件数与体积。
