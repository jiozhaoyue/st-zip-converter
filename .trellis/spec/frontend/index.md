# Frontend Development Guidelines

> 本仓前端（`src/ui/**`、根 `index.js`、`index.html`、`style.css`）的**真实**约定，不是理想设计。
> 项目形态：四酒馆（SillyTavern / Luker / TauriTavern / PureTavern）数据包互转工具，
> **纯前端为主、Authority 服务端为可选增强层**（适配器 + 特性检测 + 静默降级）。

---

## Overview (概述)

本目录收录前端开发规范。每条约定都应能在代码里指出出处（文件路径 + 符号名）。
标注「待验证」的条目表示尚未在代码中证实，其后必须写明验证方法——**禁止臆测**。

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | 三形态入口（独立 Web / 宿主插件 / Node 测试）、`src/**` 分层、构建与部署 | 就绪（2026-09-24 校正） |
| [Component Guidelines](./component-guidelines.md) | 宿主内 UI 注入（幂等 + 自愈）、注入按钮工厂、单一模板源、CSS 作用域铁律、DOM 注入防线 | 就绪（2026-09-25 刷新） |
| [Host Capabilities](./host-capabilities.md) | 宿主能力获取决策树、原生弹窗适配器契约、降级反例构造法、现存能力面表、**UI 控件合宪性（死控件取证）** | 就绪（2026-09-25 新建） |
| [Hook Guidelines](./hook-guidelines.md) | 宿主生命周期接入、备份/恢复端点、CSRF、无全局命名空间 | 就绪（2026-09-24 刷新） |
| [State Management](./state-management.md) | 内存 Blob 生命周期、TaskManager 断点续传、rAF 合帧 | 就绪 |
| [Quality Guidelines](./quality-guidelines.md) | 验证矩阵、**三条**守卫命令、转义层契约、10 条禁止模式、纯逻辑可单测约定 | 就绪（2026-09-25 刷新） |
| [Type Safety](./type-safety.md) | JSDoc 契约、运行时目标守卫、manifest 校验 | 就绪 |

> 现行质量门槛：`npm test` 全绿（当前 **41 个测试文件 / 358 passed / 2 skipped**，零回归），
> 外加**四条**静态守卫 `npm run check:css-scope`、`npm run check:dom-injection`、
> `npm run check:template-source` 与 `npm run check:control-consumer`（详见 quality-guidelines.md）。
> 同一事实只允许一处权威表述；遇到冲突以本目录文档与根 `CLAUDE.md` 为准。
>
> ⚠ **单个 spec 文件不得超过 Trellis 的 `context_injection.max_file_bytes`（32768 字节）**——
> 超限会被**静默截断**，拿到半截规范的 agent 比拿不到更危险。
> 2026-09-25 因 `component-guidelines.md` 涨到 36.7 KB 而拆出 `host-capabilities.md`。
> 新增内容后请 `wc -c .trellis/spec/frontend/*.md` 自查。

---

## How to Fill These Guidelines (本目录的维护约定)

1. 写**本仓真实约定**（能在代码里指出出处），不写理想设计
2. 代码示例从本仓摘取，路径与符号名逐字核对后再落笔
3. 列出**禁止项**，并写清原因（附真实事故更佳，本仓已发生多起）
4. 记录**已踩过的坑**；无法证实的结论标「待验证」并写明验证方法

目标是让 AI 助手与新人无需通读全仓，即可理解本项目实际如何运作。

---

**Language**: 文档、注释与回复**一律中文**（代码标识符、命令输出、专有名词除外）。
这是对仓群统一规则 L0-15 的落实，**有意覆盖 Trellis spec 模板的 English-only 默认**——不要按模板改回英文。
