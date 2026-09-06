# 酒馆风格 UI 重构与导出名占位符修复 技术设计 (Design)

## 架构与核心改动

### 1. 导出文件名解析引擎增强 (`src/core/filename-template.js`)
- 扩展占位符词典：
  - `{source}`, `{sourceName}`, `{name}`, `{filename}` -> 源包主文件名
  - `{target}`, `{platform}`, `{layout}` -> 目标平台标识
  - `{handle}`, `{user}`, `{username}` -> 用户身份标识
  - `{date}`, `{datetime}`, `{time}`, `{timestamp}` -> 格式化时间戳
- 安全替换：采用 `replace(/.../gi, () => value)` 避免 `$` 转义字符风险。
- 新增 `previewFilename(template, context)` 供前端无副作用实时展示预览。

### 2. 宿主与转换流文件名管线贯通 (`index.js`, `src/ui/host-bridge.js`)
- 在 `handleHostExport` 中：
  - 获取真实 `handle`（来自 `getHandle()`）。
  - 不论 `selectedTarget === 'native'` 还是其他目标平台，统一通过 `resolveFilename` 计算 `finalFilename`。
  - 宿主原生模式将 `target` 设置为当前宿主平台代码（如 `'st'` 或 `'luker'`）。
- 在外部包转换 (`btnConvert` 与 `runBatchConversion`) 中：
  - 从源数据包探测元数据（如 `detection.handle` 或 manifest 提取）传入 `resolveFilename({ handle })`。
- 占位符药丸芯片智能插入算法：
  - 当无光标或初始状态时，自动追加到 `.zip` 扩展名前并补全连字符 `-`。
  - 触发 `input` 事件联动更新实时预览。
- 增加实时文件名预览组件并同步至界面。

### 3. SillyTavern 视觉系统与样式重构 (`style.css`, `index.html`)
- **CSS 变量分层**：
  - 第一层：优先继承 SillyTavern 宿主注入的 `--SmartThemeBodyColor`, `--SmartThemeBorderColor`, `--SmartThemeChatTintColor`, `--SmartThemeQuoteColor`, `--SmartThemeEmColor`。
  - 第二层：独立运行时高保真回退为经典酒馆深灰黑曜色与暖琥珀金 (`#f59e0b` / `#d97706`)。
- **酒馆质感体系**：
  - 玻璃拟态深色卡片与金黄色细边框微光。
  - 复古探险者卷轴/酒馆背包拖拽放置区。
  - 物品栏风格的双文件管理面板。
  - 金色羊皮纸感进度条与状态微标。
  - 羊皮纸日志抽屉控制台，终端高亮。
- **现代化与响应式**：
  - `accent-color: var(--tavern-gold)` 表单控件着色。
  - 触控目标最小 44px。
