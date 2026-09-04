# st-zip-converter

> 🚀 **酒馆系（SillyTavern / Luker / PureTavern / TauriTavern）Zip 数据包互转工具**
>
> 具备**三位一体**标准前端架构：既是标准的 SillyTavern / Luker 扩展插件，又是零依赖本地独立 Web 应用，同时原生支持 GitHub Pages 静态在线部署。

---

## 特性亮点

- ⚡ **三位一体架构**：一份代码满足三大场景（酒馆内置扩展插件、本地轻量 Web 应用、GitHub Pages 在线转换）。
- 🎨 **零 Base64 内联**：代码结构干净透明，采用标准的 HTML5 + CSS + ESM 现代前端组织，杜绝数万行的难看内联大文件。
- 🔒 **纯客户端计算与隐私保护**：所有解压、路由重构与重新打包全部在浏览器本地内存完成，零数据上传服务器；`secrets.json`（API 密钥）严格位级保真。
- 📦 **四大家酒馆全互转**：支持 SillyTavern（摊平）、Luker（清单）、TauriTavern（data/根）与 PureTavern（第三方扩展重装映射）双向无缝转换。
- 💡 **极速流式 IO**：基于 `@zip.js/zip.js` 管道与背压控制，转换 1GB+ 庞大数据包仅需平稳内存储备。

---

## 使用方式 (三大场景)

### 场景 1: 作为 SillyTavern / Luker 扩展插件安装（推荐）

直接克隆本仓库至酒馆的第三方扩展目录：

```bash
cd <SillyTavern安装目录>/public/scripts/extensions/third-party/
git clone https://github.com/jiozhaoyue/st-zip-converter.git
```

重启或在酒馆扩展管理中刷新扩展列表：
1. 扩展菜单中将自动出现 **「📦 酒馆数据包互转器」**。
2. 支持一键导出：点击 `[→ ST]`、`[→ Luker]`、`[→ TT]`、`[→ PT]` 快捷按钮，直接抓取当前酒馆备份并转换下载。
3. 支持外部导入：拖入任意酒馆导出的 Zip 数据包，自动识别源格式并一键转为适合当前酒馆的格式。

---

### 场景 2: 本地轻量开发服务器运行

克隆本仓库到本地，启动极速开发者服务器：

```bash
git clone https://github.com/jiozhaoyue/st-zip-converter.git
cd st-zip-converter

npm install
npm start
```

本地服务将在 `http://localhost:5173` 启动，在浏览器中即可使用完整的拖拽上传、自动识别、格式互转与下载功能。

---

### 场景 3: GitHub Pages 在线直接使用

无需在本地安装任何 Node.js 环境或软件，直接访问 GitHub Pages 在线转换：
👉 **`https://jiozhaoyue.github.io/st-zip-converter/`**

---

## GitHub Pages 一键部署教程

如果您 Fork 了本仓库或在自己的 GitHub 账号下托管，只需 3 步即可开通您自己的专属在线转换站：

1. **进入仓库设置**：打开仓库主页，点击 **Settings** -> 左侧导航栏 **Pages**。
2. **选择部署来源 (Build and deployment)**：
   - 将 **Source** 切换为 **`GitHub Actions`**。
3. **推送代码自动上线**：
   - 本仓库已内置 `.github/workflows/deploy.yml`。每次推送到 `main` 分支，GitHub Actions 就会自动构建静态产物并部署上线。
   - 部署完成后，在 Pages 页面即可获得您的专属访问 URL。

---

## 四大酒馆平台数据映射规则

| 目标平台 | 布局形态 | 平台导入方式与注意事项 |
|:---:|:---:|---|
| **SillyTavern (ST)** | 摊平用户目录根 | 解压后覆盖到 `data/<handle>/` 目录。*注：官方备份端点不含 secrets，插件端已做相应安全说明。* |
| **Luker (L)** | 摊平目录 + `manifest.json` | 在 Luker 界面中点击「恢复备份」上传该 Zip，支持全选资产类目；支持一键恢复。 |
| **TauriTavern (TT)** | `data/default-user/` 结构 | TT 数据管理中导入，自动识别三种目录结构。 |
| **PureTavern (PT)** | TT 布局 + 合成 `extension-sources` | PT 导入选 TT 迁移包；用户级扩展已按 PT 规范自动迁移至 `third-party` 目录并合成来源。 |

---

## 许可证

MIT License © 2026 [jiozhaoyue](https://github.com/jiozhaoyue)
