# Backend Development Guidelines（核心引擎与注入层）

> 本项目的「后端」指**不依赖 DOM 的纯逻辑核心**（`src/core/`）+ 持久化适配层（`src/storage/`）+ 宿主注入桥（`src/ui/host-bridge.js`）。项目**没有服务端进程、没有 CLI、没有构建期插件打包产物**。

---

## Overview

`st-zip-converter` 是四酒馆（SillyTavern / Luker / TauriTavern / PureTavern）数据包互转工具。同一份 `src/core/` 核心跑在三种形态：

1. **独立 Web**：`index.html`（`#app` 容器）+ 根 `index.js` 渲染工作台。
2. **酒馆扩展插件**：`src/ui/host-bridge.js` 把工作台注入 ST / Luker 的扩展设置抽屉。
3. **Node/Vitest**：`src/core/worker-client.js` 在无 `Worker` 时自动降级为主线程同步执行。

本目录记录的是**代码里可验证的真实约定**；`src/ui/` 的界面层约定见 `../frontend/`。

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | 目录布局、模块职责、三形态入口与命名约定 | Ready |
| [Datapack Storage Guidelines](./database-guidelines.md) | 四平台 zip 布局、流式 IO、IndexedDB 暂存、secrets 保真 | Ready |
| [Error Handling](./error-handling.md) | 核心抛错边界、报告警告/丢弃账本、资源收尾 | Ready |
| [Quality Guidelines](./quality-guidelines.md) | 测试矩阵、守卫命令、禁止模式、zip 写入并发契约 | Ready |
| [Node Zip Writer Pitfalls](./node-zip-writer-pitfalls.md) | **`zip-io.js` 的四处静默缺陷**（已锁流 cancel 杀进程 / `bufferedWrite` 永不落盘 / 背压自锁 / 无界并发）与四条硬约束、`io` 契约陷阱、大包不进内存的可用做法、可执行守护 | Ready（2026-09-26 新建） |
| [Logging Guidelines](./logging-guidelines.md) | 结构化 logger、报告输出、密钥脱敏 | Ready |

---

## 维护要求

每个规范文件：

1. 只写**代码里能验证的真实做法**，不写理想态；旧架构残留一律删除。
2. 断言必须给出可核对的来源（文件路径、导出名、命令）。
3. 列出**禁止模式**及违反后果（本项目多数红线来自真实事故，见仓库根 `AGENTS.md`「坑与教训」）。
4. 无法在代码中证实的结论标注「待验证」并写明验证方法。

目标是让 AI 助手与新成员理解本项目**实际**如何运转。

---

**语言**：本目录文档、注释与回复一律**中文**（代码标识符、命令、专有名词除外）。
