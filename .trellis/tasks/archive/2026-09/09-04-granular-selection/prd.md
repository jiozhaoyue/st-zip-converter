# 对齐 ST/Luker 原生规范的全类目细粒度选择器

## Goal

重构类目选择器，严格参考 SillyTavern 和 Luker 原生导出/备份规范（`getUserBackupTargets` 与 `selection` 字典结构），将原本粗粒度预设改为全量 10 项标准细粒度复选框，让用户拥有与官方酒馆完全一致的精细勾选控制权。

## Requirements

1. **对齐 10 项标准类目结构**：
   - `characters`: 角色卡（`characters/`）
   - `chats`: 聊天记录（`chats/`, `groups/`, `group chats/`）
   - `lorebooks`: 世界书 / 设定集（`worlds/`）
   - `presets`: 预设与提示词（`OpenAI Settings/`, `NovelAI Settings/`, `presets/`, `instruct/`, `context/`, `sysprompt/`, `reasoning/`, `themes/`, `movingUI/`, `QuickReplies/`, `textgen_presets/`）
   - `settings`: 系统设置（`settings.json`, `tauritavern-settings.json`, `backups/`）
   - `secrets`: API 密钥（`secrets.json`）
   - `assets`: 素材与头像背景（`User Avatars/`, `backgrounds/`, `assets/`, `user/`）
   - `extensions`: 用户扩展（用户级 `extensions/`）
   - `globalExtensions`: 第三方/全局扩展（`extensions/third-party/`, `_tauritavern/extension-sources/`）
   - `vectors`: 向量数据库（`vectors/`）

2. **Zip 中央目录预检精准归类**：
   - `inspectArchive` 与 `categoryOfHubPath` 严格按上述 10 大标准类目统计文件数与解压体积。
   - 保留对 TT 布局（`data/default-user/` 前缀及 `data/_tauritavern/`）的精准类目路由映射。

3. **UI 细粒度网格与交互控制**：
   - 将类目面板由预设主导改为**全量原生勾选面板**。
   - 每个类目包含：复选框、中文/英文对照标签、当前包内文件数与格式化体积（例如 `3 项 · 12.4 KB`）。
   - 空类目（0 项）自动禁用复选框并置灰，清晰提示“无”或“0 项”。
   - 提供便捷操作控制条：`全选`、`全不选`、`反选`，仅操作当前包内非空的有效类目。
   - 仍保留极简辅助快捷按钮（如`仅角色卡`、`脱敏导出`），供快速一键切换，但主体界面为 10 项全量独立复选框。

4. **转换与 Manifest 同步联动**：
   - 在 `convert()` 流程中，按 10 项 `selection` 精准判定跳过未勾选类目的文件，并在 report 中记录过滤明细。
   - 目标为 Luker (`l`) 时，合成的 `manifest.json` 中的 `selection` 字典严格保留与用户勾选完全一致的布尔值映射（10 项）。

## Acceptance Criteria

- [x] `inspectArchive` 和 `categoryOfHubPath` 正确识别并归类 10 项标准类目。
- [x] UI 网格渲染全部 10 项标准类目复选框，包含文件数与字节体积。
- [x] 提供 `全选`、`全不选`、`反选` 功能，支持独立自由勾选。
- [x] 导出 Luker 包时，`manifest.json` 中的 `selection` 字典精准反映用户的 10 项勾选状态。
- [x] 单元测试更新并覆盖 10 类目过滤与统计，全量测试套件通过（100% passed）。
- [x] 生产打包 `npm run build` 干净利落完成，无类型或打包报错。
