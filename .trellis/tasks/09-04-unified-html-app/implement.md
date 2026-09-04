# 执行计划: st-zip-converter 重构与三位一体落地

> 目标: 彻底剔除旧 CLI，实现标准插件 + 本地独立运行 + GitHub Pages 三位一体无内联架构。

---

## Phase A: 依赖精简与工程骨架
- [ ] A1 卸载旧版 Node CLI 依赖（`npm uninstall yauzl yazl`），移除 `cli.js`、`src/io/node-io.js`、`src/plugins/build.mjs`。
- [ ] A2 更新 `package.json`，配置开发服务器脚本（`npm start`）、依赖与仓库元数据。
- [ ] A3 建立标准 `manifest.json`（SillyTavern 标准第三方扩展清单）。
- [ ] A4 搭建语义化 `index.html` 与响应式现代主题 `style.css`（支持暗色/明色适配与移动端自适应）。

## Phase B: 纯前端转换引擎收敛 (`src/core/`)
- [ ] B1 建立 `src/core/zip-io.js`，基于 `@zip.js/zip.js` 统一封装纯浏览器 Blob 流式读写适配器。
- [ ] B2 重构 `src/core/detect.js` 与 `src/core/transform.js`，完全去除 Node.js 专有代码，仅依赖浏览器 Web API 与通用核心。
- [ ] B3 保留 Hub 拓扑转换、四平台映射规则、PT 扩展来源合成以及 secrets.json 零篡改安全策略。

## Phase C: 宿主集成与 UI 控制器 (`src/ui/`)
- [ ] C1 实现 `src/ui/host-bridge.js`：自适应环境嗅探（独立 Web vs SillyTavern / Luker 插件）；酒馆环境下自动挂载扩展菜单与模态弹窗，集成 CSRF Token 与一键备份。
- [ ] C2 实现 `src/ui/file-drop.js`：现代文件拖拽上传区、文件选择器监听、源文件类型自动嗅探提示。
- [ ] C3 实现 `src/ui/view.js`：状态机流转、进度条、四平台目标选择联动、转换报告摘要卡片、多项警告折叠面板与一键下载。
- [ ] C4 汇聚于主入口 `index.js`，完成模块拼装与生命周期初始化。

## Phase D: 验证、文档与 GitHub Pages 部署
- [ ] D1 启动本地开发服务（`npm start`）进行全平台双向数据包转换测试（ST ↔ L ↔ TT ↔ PT）。
- [ ] D2 在真实或本地酒馆第三方扩展目录下验证插件自动注册、一键备份转换功能。
- [ ] D3 编写 GitHub Pages 自动化部署配置（`.github/workflows/deploy.yml`）并在 README.md 中编写详细的使用与部署指引。
- [ ] D4 代码与工程归档收尾。
