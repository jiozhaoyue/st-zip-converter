# st-zip-converter: 三位一体酒馆数据包转换器 (标准插件 + 本地独立运行 + GitHub Pages)

## Goal

项目命名为 **`st-zip-converter`**，遵循 SillyTavern 插件规范。彻底重构淘汰旧版 Node CLI 方案，建设**“三位一体”标准无内联前端架构**：
既是标准的 SillyTavern / Luker 扩展插件（可一键克隆安装使用），又是功能完备的独立 Web 应用（可本地开发者服务器启动、可双击运行），同时原生兼容 GitHub Pages 静态部署。

---

## 核心架构原则

1. **三位一体 (Trinity Architecture)**：
   - **酒馆插件态**：标准 `manifest.json` 与插件入口，放入 `third-party/st-zip-converter` 即可被 ST/Luker 自动加载，提供扩展菜单与一键备份转换功能。
   - **本地独立态**：提供 `npm start` 快速启动开发服务器或通过浏览器直接打开，拖拽外部 Zip 即可互转。
   - **GitHub Pages 态**：纯静态无后端依赖，支持 GitHub Pages 直接托管，提供免安装在线 Web 版。
2. **禁止内联 (No Inlining)**：
   - 彻底取消单文件 HTML 内联 base64 的做法。
   - HTML、CSS、JS 保持现代标准分离组织，代码结构干净易维护。
3. **彻底清理 CLI (Clean Refactoring)**：
   - 删除 `cli.js`、`src/io/node-io.js`、`yauzl`/`yazl` 依赖。
   - 继承原有已验证的 Hub 拓扑转换算法、四平台路由规则与 secrets 绝不篡改的安全准则。

---

## Requirements

### R1: 标准酒馆扩展集成
- 规范遵循 ST 第三方扩展标准，根目录提供合规的 `manifest.json`。
- 在宿主环境中自动挂载至扩展菜单（或主操作栏），支持与酒馆后端（`/api/users/me`, `/api/users/backup`）直接通信，实现“一键导出并转为目标格式”。
- 提供弹窗操作面板，用户既可在酒馆内一键转当前数据，也可拖入外部已导出的 Zip 数据包转换。

### R2: 独立 Web 运行与 GitHub Pages 部署
- 界面包含：清晰的拖拽/选择 Zip 上传区域、源布局自动识别、目标平台选择（SillyTavern / Luker / TauriTavern / PureTavern）、缓存过滤选项（--keep-all 对应开关）、实时转换进度条、详尽的转换统计卡片与一键下载。
- 提供直观的 GitHub Pages 部署说明与配置。

### R3: 核心转换引擎收敛与依赖清理
- 核心转换逻辑（`src/core/`）完全基于现代浏览器标准与轻量 ESM 架构，不再依赖 Node.js 文件系统与流。
- 彻底清理 `cli.js`、`src/io/node-io.js`、`yauzl`/`yazl` 等旧代码与依赖。

---

## Acceptance Criteria

- [ ] **AC1 (命名与清单规范)**：项目正式命名为 `st-zip-converter`，`package.json` 与 `manifest.json` 信息完全对齐。
- [ ] **AC2 (零内联分离架构)**：工程由独立的 `index.html`、`index.js`、`style.css` 组成，无任何 base64 伪内联代码，具备良好可读性。
- [ ] **AC3 (本地独立运行验证)**：通过轻量开发服务器（`npm start`）可在浏览器中正常访问，支持 4 大平台（ST/L/TT/PT）Zip 文件的相互转换与正确下载。
- [ ] **AC4 (酒馆内嵌实测可用)**：复制/链接至 SillyTavern / Luker 的 `third-party` 扩展目录后能被正常激活并调用一键备份转换。
- [ ] **AC5 (GitHub Pages 部署文档与支持)**：包含完整的 GitHub Pages 部署指引，静态资源均使用相对路径支持二级路径部署。
- [ ] **AC6 (彻底清理旧 CLI)**：删除 `cli.js`、`node-io` 与 Node 端 zip 依赖，无残留无用代码。
