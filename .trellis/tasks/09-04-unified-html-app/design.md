# 技术设计: st-zip-converter (三位一体标准插件与Web架构)

> 架构目标: 彻底淘汰 CLI，建立“标准酒馆插件 + 本地独立运行 + GitHub Pages”三位一体无内联静态工程。

---

## 1. 系统全景架构

```
+-------------------------------------------------------------------------+
|                              运行入口 (3态)                              |
|                                                                         |
|  [态 1: ST/Luker 插件]        [态 2: 本地开发服务器]      [态 3: GitHub Pages]  |
|  third-party/st-zip-converter    npm start (如 vite)     https://xxx.github.io  |
+-------------------------------------------------------------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
|                       标准静态资产 (零内联分离架构)                       |
|                                                                         |
|   index.html          index.js (ESM 入口)         style.css (响应式设计) |
|   manifest.json       (SillyTavern 标准第三方扩展清单)                    |
+-------------------------------------------------------------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
|                           前端控制器层 (src/ui/)                         |
|                                                                         |
|   host-bridge.js      环境嗅探: ST/Luker 宿主环境 vs 独立浏览器环境        |
|                       宿主通信: GET /api/users/me, POST /api/users/backup|
|   file-drop.js        文件处理: 拖拽/点击选取本地 Zip 数据包              |
|   view.js             界面渲染: 平台选择器, 进度条, 结构化报告卡片        |
+-------------------------------------------------------------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
|                      纯前端转换引擎 (src/core/)                          |
|                                                                         |
|   detect.js           四平台布局自动检测 (ST / L / TT / PT)              |
|   transform.js        Hub 拓扑转换管线 (ST 摊平为中心, 严格保护 secrets)  |
|   report.js           结构化统计与警告收集 (模块数 / 丢弃项 / 建议)       |
|   zip-io.js           基于 @zip.js/zip.js 的纯浏览器 Blob 流式读写适配器  |
+-------------------------------------------------------------------------+
```

---

## 2. 核心模块边界与职责

### 2.1 静态根目录规范
- `manifest.json`: 符合 SillyTavern 插件标准规范：
  ```json
  {
    "name": "st-zip-converter",
    "display_name": "酒馆数据包转换器",
    "version": "1.0.0",
    "author": "jiozhaoyue",
    "description": "在 SillyTavern / Luker / PureTavern / TauriTavern 之间互转 Zip 数据包",
    "homePage": "https://github.com/jiozhaoyue/st-zip-converter",
    "loading_order": 50
  }
  ```
- `index.html`: 标准 Semantic HTML5 骨架，引用 `style.css` 与 `index.js`，包含：
  - **模态弹窗外壳（Modal Dialog）**：居中半透明遮罩、右上角关闭按钮，在插件态下作为呼出面板，在独立态下全屏优雅铺开。
  - **4 个一键导出按钮网格**（酒馆插件态激活）：
    - `[→ SillyTavern]`、`[→ Luker]`、`[→ TauriTavern]`、`[→ PureTavern]`
    - 单击直接调用 `/api/users/backup`，实时流式转换并触发目标格式下载。
  - **智能双模态导入区**：
    - 拖拽 / 点击文件选择区，支持任何酒馆导出的 Zip。
    - 自动识别源平台 Chip（如 `已识别: TauriTavern`）。
    - 默认推荐转为当前宿主格式；提供『转换为当前酒馆格式并下载』大按钮。
    - 在 Luker 环境下额外显示『直接恢复载入到当前用户』便捷操作。
  - **控制与设置项**：
    - `[x] 保留全部派生缓存 (--keep-all)`：支持保留 thumbnails、vectors、cache。
  - **实时进度与结构化报告面板**：
    - 进度条与实时状态提示（读取 -> 转换 -> 压缩打包）。
    - 结构化报告折叠卡：资产统计（角色/聊天/世界书/预设/密钥状态）、丢弃明细与警告详情。
- `style.css`: 采用现代 CSS 变量，自适应酒馆暗色/明色主题，手机端移动友好响应式。

### 2.2 宿主环境嗅探与桥接 (`src/ui/host-bridge.js`)
```javascript
export function detectHostEnvironment() {
  const isLuker = typeof window.luker !== 'undefined' || document.querySelector('#luker-app');
  const isST = typeof window.SillyTavern !== 'undefined' || document.querySelector('#extensionsMenu');
  return {
    isPlugin: Boolean(isLuker || isST),
    platform: isLuker ? 'luker' : isST ? 'st' : 'standalone'
  };
}
```
- **在插件态下**：自动在 `#extensionsMenu` 注入菜单项，点击呼出主操作面板；支持一键获取 CSRF Token 并调用 `/api/users/backup`。
- **在独立态下**：自动隐匿宿主专有交互，专注于本地 Zip 拖拽转换。

### 2.3 零依赖与纯浏览器流式 IO
- 彻底摒弃 Node.js 专有的 `fs`, `stream`, `yauzl`, `yazl`。
- 使用通用标准库 `@zip.js/zip.js`（作为纯 ESM 依赖），以 `BlobReader` 与 `BlobWriter` 进行单 pass 转换，保持峰值内存平稳。

---

## 3. 旧代码清理与迁移方案

| 旧文件/依赖 | 处置方式 | 替代/新归宿 |
|---|---|---|
| `cli.js` | 彻底删除 | 独立 Web 界面 (`index.html`) |
| `src/io/node-io.js` | 彻底删除 | `src/core/zip-io.js` (浏览器 Blob IO) |
| `src/plugins/build.mjs` | 彻底删除 | 取消复杂 IIFE 打包，采用标准 ESM / Vite 现代工程 |
| `src/plugins/plugin.js` | 重构迁移 | 拆解为 `src/ui/host-bridge.js` 与根目录 `index.js` |
| `yauzl`, `yazl` 依赖 | 彻底卸载 | 仅保留 `@zip.js/zip.js` 作为前端依赖 |
| `fixtures/` | 调整 | 保留测试用小包作为网页端示例文件 |

---

## 4. GitHub Pages 部署机制

- 仓库根目录直接作为静态站点源（或通过 `.github/workflows/deploy-pages.yml` 自动部署到 `gh-pages`）。
- 所有静态资源均采用相对路径引用（`./style.css`, `./index.js`），保证在 `https://<user>.github.io/st-zip-converter/` 二级目录完美运行。
- README 中增加两步在线使用与本地开发服务指南。
