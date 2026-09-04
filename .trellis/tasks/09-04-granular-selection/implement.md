# 细粒度全类目选择器实施计划

## 实施步骤

1. **重构 `src/core/inspect.js`**:
   - 扩充 `CATEGORIES` 与 `CATEGORY_LABELS` 至 10 大标准项。
   - 优化 `categoryOfHubPath` 路径匹配，精准识别 `presets`（各类设置子目录）、`assets`、`extensions` 与 `globalExtensions`。
   - 更新 `inspectArchive` 初始化 10 项统计字典。

2. **同步 `src/core/transform.js` 与 `src/core/report.js`**:
   - 统一使用 `inspect.js` 中的 `CATEGORIES`。
   - 确保 `emitSynthesized` 中 Luker `manifest.json` 输出完整的 10 项 `selection` 字典。

3. **重构 `src/ui/category-filter.js` 与 `index.html` / `style.css`**:
   - `index.html`: 更新顶部控制按钮为【全选】、【全不选】、【反选】、【仅角色卡】、【安全脱敏】。
   - `src/ui/category-filter.js`:
     - 维护 10 项当前勾选状态。
     - 渲染 10 项网格条目，支持禁用 0 项类目。
     - 实现 `selectAll()`, `deselectAll()`, `invertSelection()`, `applyPreset()` 等操作。
   - `style.css`: 优化细粒度复选框网格排版，增加 hover 反馈与 disabled 样式。

4. **更新与扩充单元测试**:
   - `test/filter.test.js`: 补充 10 项类目预检识别与过滤的测试用例。
   - 运行 `npm test` 确保 100% 通过。

5. **验证与打包**:
   - 运行 `npm run build`。
   - 在已启动的本地服务中验证交互。
