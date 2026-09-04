# ST/Luker 细粒度全类目选择器设计

## 1. 背景与对齐目标

用户明确指出：原有的类目选择器仅暴露 7 项且预设式呈现，不符合日常使用 SillyTavern 与 Luker 的习惯。SillyTavern 与 Luker 原生备份/导出功能具有严谨且成熟的 10 项细粒度备份项划分。

本项目必须严格遵循此行业事实标准，将类目定义、中央目录预检归类、转换流过滤与 UI 交互全面对齐至这 10 项。

## 2. 10 大标准类目定义与路径映射

```javascript
export const CATEGORIES = Object.freeze({
  CHARACTERS: 'characters',
  CHATS: 'chats',
  LOREBOOKS: 'lorebooks',
  PRESETS: 'presets',
  SETTINGS: 'settings',
  SECRETS: 'secrets',
  ASSETS: 'assets',
  EXTENSIONS: 'extensions',
  GLOBAL_EXTENSIONS: 'globalExtensions',
  VECTORS: 'vectors',
});
```

### 映射表 (Hub 路径)

| 类目 Key | 中文标签 | 涵盖 Hub 路径 / 特征 |
|---|---|---|
| `characters` | 角色卡 (Characters) | `characters/` |
| `chats` | 聊天记录 (Chats) | `chats/`, `groups/`, `group chats/` |
| `lorebooks` | 世界书 (World Info) | `worlds/` |
| `presets` | 预设配置 (Presets & Prompts) | `OpenAI Settings/`, `NovelAI Settings/`, `presets/`, `instruct/`, `context/`, `sysprompt/`, `reasoning/`, `themes/`, `movingUI/`, `QuickReplies/`, `textgen_presets/` |
| `settings` | 系统设置 (Settings) | `settings.json`, `tauritavern-settings.json`, `backups/` |
| `secrets` | API 密钥 (Secrets) | `secrets.json` |
| `assets` | 素材与头像 (Assets & Avatars) | `User Avatars/`, `backgrounds/`, `assets/`, `user/` |
| `extensions` | 用户扩展 (User Extensions) | `extensions/` (排除 `extensions/third-party/`) |
| `globalExtensions` | 第三方/全局扩展 (Global/3rd Extensions) | `extensions/third-party/`, `_tauritavern/extension-sources/`, `public/scripts/extensions/third-party/` |
| `vectors` | 向量数据库 (Vectors) | `vectors/` |

## 3. UI 交互设计

- **网格布局**: CSS Grid 自适应多列（桌面 2 列或 3 列，移动端 1 列）。
- **每个条目**:
  - `Checkbox`: 初始若包内 count > 0 则勾选；若 count === 0 则未勾选且 `disabled`。
  - `Title`: `角色卡 (Characters)` 等清晰中英文标注。
  - `Meta Badge`: `4 项 · 1.2 MB`，当 count === 0 时显示 `0 项 · 0 B` 并降低不透明度 (置灰)。
- **操作栏**:
  - `全选` (Select All): 仅勾选所有非 disabled 项。
  - `全不选` (Deselect All): 取消勾选所有非 disabled 项。
  - `反选` (Invert): 翻转所有非 disabled 项的勾选状态。
  - 辅助预设按钮（`仅角色卡`, `脱敏排除`），点击后联动复选框。

## 4. 转换引擎与 Manifest 交互

- 在 `transform.js` 中:
  - `categoryOfHubPath(routed.hubPath)` 返回标准 10 项类目之一。
  - 当 `selection[cat] === false` 时，执行 `entry.skip()` 并计入 `report.filtered(routed.hubPath, cat)`。
  - 目标为 `l` 时，合成的 `manifest.json.selection` 完整输出该 10 项布尔值。
