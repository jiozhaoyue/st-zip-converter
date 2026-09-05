# 工作区持久化与单项穿透动作预览实施计划

## 实施步骤

1. **构建浏览器 IndexedDB 存储适配器 (`src/storage/db.js`)**:
   - 纯标准原生 IndexedDB API 封装（零额外依赖）。
   - 实现 `saveFile(file, meta)`, `loadFile(id)`, `deleteFile(id)`, `listStoredFiles()`, `getStorageUsage()`, `clearAll()`.
   - 实现 `saveWorkspaceState(state)`, `loadWorkspaceState()`.
   - 实现 `savePreferences(prefs)`, `loadPreferences()`.

2. **构建完全扫描与动作预测引擎 (`src/core/plan-preview.js`)**:
   - 提取 `routeSource` 的目标路由与操作预测能力。
   - 实现 `generatePlan(source, target, { io, selection, excludedPaths, includeCache, includeBackups, includeAppPrivate })`.
   - 预测出每个条目的 `action`, `targetPath`, `category` 与体积。
   - 编写单元测试验证规划结果与实际转换结果高度一致。

3. **增强转换引擎 (`src/core/transform.js`)**:
   - 支持接收 `excludedPaths`（精细单文件排除集合）。
   - 解耦缓存、备份与私有配置的独立控制开关。

4. **构建可穿透文件树组件与工作区状态栏 (`src/ui/file-tree-picker.js`, `index.html`, `style.css`)**:
   - 在 UI 顶部添加工作区暂存状态指示栏与清空缓存按钮。
   - 在类目面板中添加展开详情按钮、单项文件列表、搜索过滤框与半选逻辑。
   - 目标选择器与复选框改动时，动态更新动作预测与实时预估体积。

5. **全流程联动与自动化测试**:
   - `test/plan.test.js` 测试深度扫描与动作规划。
   - `test/storage.test.js` (模拟/测试存储封装)。
   - `npm test` 与 `npm run build` 验证。
