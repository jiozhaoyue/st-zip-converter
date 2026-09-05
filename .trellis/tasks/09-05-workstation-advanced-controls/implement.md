# 全能工作站控制台实施计划

## 实施步骤

1. **升级存储层 (`src/storage/db.js`)**:
   - `saveFile` 支持 `role: 'source' | 'output'`.
   - 实现 `listSourceFiles()` 与 `listOutputFiles()`.
   - 增加按 ID 获取和删除单个文件的完备处理。

2. **Zip 压缩率全链路打通 (`src/core/zip-io.js`, `src/core/transform.js`, `src/core/converter-worker.js`)**:
   - `zipIo.createWriter(targetPath, { level })` 支持透传 `level` 至 `zip.ZipWriter`.
   - `convert()` 选项支持 `compressionLevel: 0 | 1 | 5 | 9`.
   - 单元测试验证不同 level 生成的合规 zip 包均可被正确解压和识别。

3. **自定义包名生成器 (`src/core/filename-template.js`)**:
   - 实现占位符替换逻辑与防空兜底。
   - 编写单元测试。

4. **动作胶囊联动与文件树增强 (`src/ui/file-tree-picker.js`, `src/ui/category-filter.js`)**:
   - 动作条胶囊增加点击事件，切换 `activeActionFilter`.
   - 文件树增加排序切换（默认、体积降序、文件名）与大文件醒目标记（>1MB、>5MB）.

5. **双文件列表 UI 面板 (`src/ui/archive-manager.js`, `index.html`, `style.css`)**:
   - 在工作区横幅下方增加可展开的双文件管理面板：
     - 左栏：已上传源包（切换/移除）
     - 右栏：已生成产物（重新下载/载入/移除）
   - 控制栏添加自定义包名输入框与压缩率下拉选择器。

6. **全链路测试与验证**:
   - 编写测试用例覆盖模板、压缩率、存储分类。
   - 运行 `npm test` 与 `npm run build`。
