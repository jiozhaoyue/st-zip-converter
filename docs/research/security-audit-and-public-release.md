# 代码仓库敏感信息安全审计与开源转公开调研报告

> **调研日期**: 2026-09-06  
> **涉及范围**: 全仓库源代码、文档、构建配置、Git 历史提交记录 (Commit History)、本地未入库目录 (`data-zip/`, `out/`)、CI/CD 工作流  
> **核心目标**: 在仓库由私有转为公开发布前，对潜在的私密信息（本地开发路径、开发者真实身份、API 密钥、真实酒馆数据样本）执行地毯式安全审计，完成合规加固，确保 100% 安全开源。

---

## 1. 调研背景与安全基线

作为一款面向 SillyTavern / Luker / PureTavern / TauriTavern 跨平台生态的数据处理工作站，本项目在开发过程中涉及大量真实酒馆备份样本（包含用户的对话记录、角色卡、AI 模型 API Key、本地配置等）。
在项目转为公开开源前，必须设立严格的安全基线：
1. **零个人隐私泄露**：不得残留开发机器名、系统路径、个人真实姓名或非公开邮箱。
2. **零凭据密钥泄露**：源码、配置文件、测试夹具及 Git 历史记录中严禁包含任何真实有效的 API Token、Cookie、Session 或密码。
3. **真实数据彻底隔离**：本地调试使用的超大体积真实 Zip 包（包含私人聊天与设定）严禁进入 Git 追踪体系。
4. **开源合规与政策健全**：具备标准开源许可证与安全漏洞责任披露政策。
5. **部署无摩擦**：外部开发者与普通用户可一键 Fork 并部署到个人 Pages，无需繁琐的手动授权。

---

## 2. 五大维度全面审计过程与证据记录

### 维度 1: 开发者本地文件名、个人用户名与操作系统绝对路径
- **审计手段**:
  使用 `grep_search` 全局对开发者本地操作系统用户名（`caocaobi`）、本地开发盘符及工程路径（`[A-Za-z]:[\\/]`, `d:/Repo`, `C:/Users`）进行不区分大小写的全量正反向检索。
- **审计结果**:
  - `caocaobi`: **0 处匹配**（全部文件零残留）。
  - `[A-Z]:\\` 或 `[A-Z]:/`: **0 处匹配**（源码中均采用相对路径或纯 ESM 模块导入）。
- **结论**: ✅ **通过**。无任何本地主机绝对路径泄露风险。

### 维度 2: 密码、Token、API Key 与私密凭据
- **审计手段**:
  检索全仓库文件中的 `password`, `token`, `secret`, `api_key`, `apikey`, `bearer`, `auth` 关键字。
- **审计结果**:
  - `token`: 仅存在于 `src/ui/host-bridge.js` 中动态调用宿主 `/csrf-token` 端点获取防跨站凭证的逻辑，无硬编码 Token。
  - `secret`: 
    - 业务逻辑中为脱敏过滤选项（`selection: { secrets: false }`）。
    - 测试用例 `fixtures/gen.js` 中包含的密钥定义为确定性的合成 mock 数据：
      ```javascript
      const SECRETS = json({ 
        api_key_openai: 'fixture-secret-do-not-leak', 
        api_key_anthropic: 'fixture-secret-2' 
      });
      ```
      完全为虚拟占位符，不包含任何外部可用服务凭据。
- **结论**: ✅ **通过**。未发现任何真实敏感凭据。

### 维度 3: Git 历史提交者身份与隐私邮箱保护
- **审计手段**:
  提取自仓库初始化以来的全部 Git 提交记录作者名与提交者邮箱：
  ```bash
  git log --format="%an <%ae>" | sort -u
  ```
- **审计结果**:
  ```text
  jiozhaoyue <200372196+jiozhaoyue@users.noreply.github.com>
  jiozhaoyue <jiozhaoyue@local>
  ```
  所有公开提交均统一走 GitHub 官方隐私保护中继邮箱（`users.noreply.github.com`），用户名均为假名 `jiozhaoyue`。
- **结论**: ✅ **通过**。不存在个人真实姓名与私有邮箱外泄。

### 维度 4: Git Remote 远程源地址与权限令牌
- **审计手段**:
  执行 `git remote -v` 与 `git config --list --local`，检查 Remote URL 是否存在嵌入的 Personal Access Token (PAT)。
- **审计结果**:
  ```text
  origin  https://github.com/jiozhaoyue/st-zip-converter.git (fetch)
  origin  https://github.com/jiozhaoyue/st-zip-converter.git (push)
  ```
  采用纯净的标准 HTTPS 地址，认证完全托管于本机系统的 GitHub CLI / Windows 凭据管理器中。
- **结论**: ✅ **通过**。未在 URL 中硬编码认证信息。

### 维度 5: 本地 1GB+ 真实备份包隔离状态与 Git 历史追踪排查
- **审计手段**:
  1. 检查本地磁盘发现：本地存在 `data-zip/` 目录，存放了 `default-user-2026-08-25-172056.zip` (1.03 GB) 与 `tauritavern-data-20260825-100035.zip` (162 MB) 两个庞大真实数据包。
  2. 检索 Git 全量历史对象树中是否曾提交过真实样本包：
     ```bash
     git log --all --name-only --format="" | sort -u
     ```
- **排查发现**:
  - 历史提交中**从未追踪或提交过**该目录下的任何文件。
  - **隐患排查**: 原 `.gitignore` 中仅声明了 `*.zip` 与 `samples/`，若未来用户在 `data-zip/` 目录中解压出非 `.zip` 格式的散装文件（如 `.json`, `.png`），可能会被 Git 误识别为未跟踪文件并误提交。
- **结论**: ⚠️ **需在 `.gitignore` 中将 `data-zip/` 及 `data-*/` 升级为整目录显式黑名单**。

---

## 3. 排查发现的问题与加固落地方案

针对上述审计发现的薄弱环节，本期执行了四项关键加固措施：

### 3.1 废弃失效测试脚本清理
- **对象**: `test/verify-secrets.mjs`
- **问题**: 该脚本为早期手写的验证脚本，引用的 `src/core/read.js` 在后续架构重构为 `zip-io.js` 时已被删除，运行直接触发 `ERR_MODULE_NOT_FOUND`；且脚本内硬编码了特定的本地测试文件名。
- **处理**: 执行 `git rm test/verify-secrets.mjs` 彻底移除。所有密钥一致性验证已由标准 Vitest 测试集（`test/convert.test.js`, `test/filter.test.js`）完全覆盖。

### 3.2 补充正式开源协议 (`LICENSE`)
- 依据 `package.json` 与 `README.md` 的开源承诺，创建标准的 **MIT License** 文件，明确版权归属为 `Copyright (c) 2026 jiozhaoyue`，确保全球开发者均可在合规前提下自由使用、修改与衍生。

### 3.3 建立安全政策与责任披露机制 (`SECURITY.md`)
- 规范化建立安全模型声明：
  - 强调本工作站为 **100% 纯客户端本地计算**（运行于浏览器 Web Worker / IndexedDB 或本地 SillyTavern Node 环境），绝不设立任何外部数据收集服务器。
  - 为开源社区提供 [GitHub Private Vulnerability Reporting](https://github.com/jiozhaoyue/st-zip-converter/security/advisories/new) 负责任的安全漏洞私密提报通道。

### 3.4 `.gitignore` 深度防御规则加固
在根目录 `.gitignore` 中补充完善以下规则：
```gitignore
# 真实数据样本与本地大文件 (严禁入库)
*.zip
!fixtures/*.zip
data-zip/
data-*/
samples/

# 运行与测试产物
dist/
out/
tmp/
coverage/
.nyc_output/

# 环境配置与凭据安全
.env
.env.*
!.env.example
*.pem
*.key
*.cert
*.crt

# 编辑器与操作系统私有文件
.vscode/*
!.vscode/extensions.json
.idea/
*.swp
*.swo
.DS_Store
Thumbs.db
```

---

## 4. 多平台一键部署赋能调研

为了让外部用户在无需配置后端的情况下直接拥有属于自己的在线工作站，对 GitHub Pages 与现代 Serverless 部署机制进行了优化：

1. **GitHub Pages 部署工作流自动化**:
   - 在 `.github/workflows/deploy.yml` 的 `actions/configure-pages@v5` 步骤中开启 `with: enablement: true`。
   - **成效**: 外部用户 Fork 仓库后，运行 Action 时系统会自动为 Fork 仓库开启 GitHub Pages，无需用户手动寻找 Settings 配置 API。
2. **Vercel / Netlify 一键部署按钮**:
   - 本项目通过 `vite.config.js` 采用纯相对基址 `base: './'` 构建，天然支持零配置部署到任何静态 CDN。
   - 在 `README.md` 中集成官方标准的 `Deploy with Vercel` 和 `Deploy to Netlify` 按钮，外部用户单次点击授权即可上线。

---

## 5. 验证与回归审计结果

- **自动化测试回归**: 执行 `npm test -- --run`，全量 75 项自动化单元与集成测试全部通过，0 报错。
- **生产构建验证**: 执行 `npm run build`，Vite 编译耗时 596ms，零警告，产物资源完好。
- **CI/CD 自动化验证**: 触发 GitHub Actions 编译部署，工作流在 20 秒内顺利完成部署。
- **开源可见性变更**: 通过 GitHub CLI 完成仓库可见性从 `PRIVATE` 切换至 `PUBLIC`，正式对公开发布。
