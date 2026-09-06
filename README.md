# st-zip-converter (全能酒馆数据包工作站)

> 🚀 **全平台跨酒馆（SillyTavern / Luker / PureTavern / TauriTavern）全能数据包工作站**
>
> 具备**全闭环**前端架构：既是强大的酒馆内置全能工作站（可完全接替各酒馆原生导出，支持细粒度筛选、一键直出跨平台目标格式、增量写入恢复宿主与实时日志审计），又是完全免安装的零依赖独立 Web 应用与 GitHub Pages 静态站点。

---

## 🌟 核心特性与全闭环能力

### 1. 🏛️ 宿主数据导出与细粒度筛选（接替原生导出）
- **单面板全闭环**：无需在不同酒馆设置菜单间来回跳转，所有导出、转换、体检与恢复均在插件内部一站式完成。
- **细粒度类目自由勾选**：支持对 **角色卡 (characters)**、**聊天记录 (chats)**、**世界书 (lorebooks)**、**预设配置 (presets)**、**资产背景 (assets)**、**系统配置 (settings)**、**敏感密钥 (secrets)**、**扩展插件 (extensions)** 进行独立勾选与一键预设（全选、仅角色卡、仅聊天记录、安全脱敏）。
- **角色与聊天智能联动**：可选联动逻辑，勾选角色或聊天时自动联动关联资源，确保头像背景与对话记录上下文完整不丢失。
- **一步直出目标格式**：从当前宿主拉取数据时，可直接指定目标酒馆格式（如当前为 SillyTavern，直接一步直出为 TauriTavern 或 PureTavern 包），无需二次中转。

### 2. 🔄 增量导出与一键恢复写入宿主（Incremental Support）
- **增量合并恢复 (Merge Mode)**：支持将外部导入或转换后的数据包一键写入/恢复到当前宿主酒馆（调用 `/api/users/restore` 端点），保留酒馆已有数据，仅新增缺失项或更新同名冲突文件。
- **全量覆盖恢复 (Overwrite Mode)**：支持二次警示确认的全量数据重置与恢复。
- **离线多包增量合并 (Incremental Archive Merge)**：工作区内支持对两个 Zip 数据包执行差量合并，新版文件自动更新、历史独有文件完整保留，尤其针对 TauriTavern (TT) 与 SillyTavern 历史数据包提供无损补丁融合。

### 3. ⚡ 7-Zip ZS 与 TauriTavern Method 93 (Zstandard) 透明兼容
- 原生支持 **7-Zip-zstd (7-Zip ZS)** 以及 TauriTavern (Rust `zip-rs`) 生成的 **Method 93 (Zstandard 压缩)** Zip 数据包。
- 无论数据包内的条目使用标准 Deflate 还是 Zstandard 压缩，均自动完成透明解压与标准化重构。

### 4. 🧩 SillyTavern Git URL 插件免安装（零 npm 依赖）
- 采用自包含纯 ESM 引擎（内建本地封装的 `zip.js` 与纯 JS `fzstd` 解压模块），杜绝浏览器原生运行时报 `Failed to resolve module specifier` 错误。
- 在 SillyTavern 扩展管理器中直接粘贴 Git 仓库 URL 安装后，**无需运行 `npm install` 或 `npm run build`**，开箱即用。

### 5. 📟 底部抽屉式实时日志与诊断控制台
- 内置结构化日志中心，常驻于主面板底部微型状态栏，支持向上抽屉式平滑展开。
- 支持实时高亮自动滚屏、级别标签过滤（`全部` / `信息` / `警告` / `错误`）、一键复制到剪贴板与一键下载 `.log` 审计文本文件。

### 6. 📱 全屏幕与移动端极致响应式适配
- 严格遵循所有 UI 在单一统一面板内的交互原则，杜绝割裂的弹窗与横向滚动溢出。
- 针对手机竖屏深度优化：双列表自动垂直堆叠、触控按钮高度 $\ge 44\text{px}$、日志抽屉自适应半屏高度并支持平滑触控滚动。

---

## 🛠️ 使用方式

### 场景 1: 作为 SillyTavern / Luker 扩展插件安装（强烈推荐）

#### 方式 A: 在酒馆扩展管理中通过 Git URL 一键安装
在 SillyTavern 的「扩展管理」->「从 URL 安装」输入框中直接粘贴：
```
https://github.com/jiozhaoyue/st-zip-converter.git
```
点击安装即可，无需任何命令行或依赖构建步骤！

#### 方式 B: 手动克隆至第三方扩展目录
```bash
cd <SillyTavern安装目录>/public/scripts/extensions/third-party/
git clone https://github.com/jiozhaoyue/st-zip-converter.git
```
刷新酒馆页面后，在扩展菜单中点击 **「📦 酒馆数据包互转器」** 即可呼出全功能工作台。

---

### 场景 2: 本地独立 Web 工作站模式

```bash
git clone https://github.com/jiozhaoyue/st-zip-converter.git
cd st-zip-converter

npm install
npm start
```
本地开发服务将在 `http://localhost:5173` 启动，支持离线 IndexedDB 工作区双列表、完全扫描规划、批量转换与自定义包名。

---

### 场景 3: GitHub Pages 在线直接使用

无需在本地安装任何 Node.js 环境或软件，直接访问官方静态部署页面：
👉 **`https://jiozhaoyue.github.io/st-zip-converter/`**

---

### 场景 4: 🚀 一键部署到自己的专属站点 (GitHub Pages / Vercel / Netlify)

如果您希望拥有完全属于自己的独立转换工作站，本仓库已完成自动化 CI/CD 与相对路径深度适配，支持零门槛一键部署：

#### 方案 A: 部署到自己的 GitHub Pages (推荐，免费且自动跟随更新)

[![Fork to Deploy](https://img.shields.io/badge/GitHub-Fork_&_Deploy_to_Pages-2ea44f?style=for-the-badge&logo=github)](https://github.com/jiozhaoyue/st-zip-converter/fork)

只需简单 3 步即可上线：
1. **Fork 本仓库**：点击上方绿色徽标或页面右上角的 **[Fork]**，将项目复制到您的个人 GitHub 账号下。
2. **启用工作流**：进入您 Fork 后的仓库，点击 **Actions** 标签页，点击绿色的 **「I understand my workflows, go ahead and enable them」** 按钮启用自动化构建。
3. **开启 Pages 并触发**：
   - 进入仓库 **Settings** -> **Pages**，在 **Build and deployment** 下的 **Source** 下拉框选择 **「GitHub Actions」**。
   - 回到 **Actions** 标签页，在左侧点击 **Deploy to GitHub Pages**，点击右侧的 **Run workflow** 按钮。
   - 约 20 秒后部署完成，即可在 `https://<您的GitHub用户名>.github.io/st-zip-converter/` 拥有永久私有的专属在线转换站！

#### 方案 B: 一键部署至 Vercel / Netlify (极速秒级上线)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/jiozhaoyue/st-zip-converter)
[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/jiozhaoyue/st-zip-converter)

点击上方按钮，登录对应平台并一键授权，平台将全自动配置并在全球 CDN 节点秒级部署完成。


---

## 🗺️ 四大酒馆平台数据映射规则

| 目标平台 | 布局形态 | 平台导入方式与注意事项 |
|:---:|:---:|---|
| **SillyTavern (ST)** | 摊平用户目录根 | 解压后覆盖到 `data/<handle>/` 目录；在插件环境下支持一键通过 API 恢复写入当前用户。 |
| **Luker (L)** | 摊平目录 + `manifest.json` | 包含完整资产清单；在插件环境下支持增量合并写入 (`mode: merge`) 或全量覆盖。 |
| **TauriTavern (TT)** | `data/default-user/` 结构 | 完美适配 TT 桌面端导入，支持 Method 93 (Zstandard) 自适应解密与转出。 |
| **PureTavern (PT)** | TT 布局 + 合成 `extension-sources` | PT 导入选 TT 迁移包；用户级扩展已按 PT 规范自动迁移至 `third-party` 目录并合成来源记录。 |

---

## 📜 许可证

MIT License © 2026 [jiozhaoyue](https://github.com/jiozhaoyue)
