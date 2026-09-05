# 全能工作站控制台技术设计

## 1. 存储层增强：双文件分类 (`src/storage/db.js`)

在 IndexedDB `files` 存储对象中区分 `role`:
```typescript
interface StoredFileRecord {
  id: string;
  name: string;
  size: number;
  blob: Blob;
  layout: string;
  role: 'source' | 'output'; // 核心区分
  createdAt: number;
  metadata?: {
    sourceName?: string;
    target?: string;
    compressionLevel?: number;
  };
}
```
新增/优化 API：
- `listSourceFiles()`: 返回 `role === 'source'` 的文件列表。
- `listOutputFiles()`: 返回 `role === 'output'` 的文件列表。
- `saveFile({ id, name, size, blob, layout, role, metadata })`: 支持指定 role。

## 2. Zip 压缩率配置管线 (`src/core/zip-io.js` & `transform.js`)

`@zip.js/zip.js` 的 `ZipWriter` 选项：
```javascript
new zip.ZipWriter(blobWriter, {
  level: options.compressionLevel ?? 5, // 0 = STORE, 1-9 = DEFLATE
  bufferedWrite: true,
});
```
在 `transform.js` 中将 `compressionLevel` 传递至 `io.createWriter(targetPath, { level: compressionLevel })`。
所有四平台解压机制兼容性验证：
- **ST / Luker**: Node.js `yauzl` / `adm-zip`，完全支持 0-9 任何 Deflate 压缩级别与 Store 级别。
- **TT**: Rust `zip-rs` 0.6+，原生识别 Store (Method 0) 与 Deflate (Method 8)。
- **PT**: `@zip.js/zip.js` 2.7+，原生兼容。

## 3. 自定义包名模板解析器 (`src/core/filename-template.js`)

```javascript
export function resolveArchiveName(template, { sourceName, target, handle = 'default-user', date }) {
  const cleanSource = (sourceName || 'archive').replace(/\.zip$/i, '');
  const timestamp = date || new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return template
    .replace(/\{source\}/g, cleanSource)
    .replace(/\{target\}/g, target || 'unknown')
    .replace(/\{handle\}/g, handle)
    .replace(/\{date\}/g, timestamp)
    + (template.endsWith('.zip') ? '' : '.zip');
}
```

## 4. 文件树增强：动作筛选、排序与大文件醒目标注 (`src/ui/file-tree-picker.js`)

- **动作筛选**:
  维护全局/组件级状态 `activeActionFilter: string | null`。
  当点击动作条中的 `[路由 8]` 胶囊时，`activeActionFilter = 'ROUTE'`，文件树中隐藏非 ROUTE 项。
- **体积排序**:
  在搜索栏增加排序选择器：
  - `default`: 原始目录结构顺序
  - `size-desc`: 按 `sizeBytes` 降序排
  - `name-asc`: 按名称字母顺序排
- **大文件标记**:
  - `sizeBytes >= 5 * 1024 * 1024`：添加 `.large-file-heavy` (火标/红警示)
  - `sizeBytes >= 1 * 1024 * 1024`：添加 `.large-file-warning` (黄警示)
