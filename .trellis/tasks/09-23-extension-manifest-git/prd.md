# 扩展清单导出与 Git 迁移语义

## Goal

完善“只提供扩展列表 / 轻量清单”导出与安装恢复的产品契约，并与现有 Git 瘦身任务保持语义一致。

## Background

- `extensionMode=manifest` 当前会生成 `_convert/extensions-manifest.json`，不打包扩展实体；恢复后会呼出扩展安装器。
- `extensionMode=full` 当前保留扩展实体，但 `.git` packfile 会显著放大包体；`09-22-extension-git-slim` 正在规划 keep/strip/minimal 策略。
- Luker 用户私有扩展必须平铺在 `data/<user>/extensions/<name>/`，不能嵌套 `third-party`（L1-MR-12）；宿主公开安装端点使用浅克隆。

## Requirements

- 明确清单模式的契约：清单必须记录扩展名、展示名、安装 URL、分支/版本线索、来源平台及恢复时的推荐动作；无法确定 URL 时必须显式标记，不得伪造。
- 明确 FULL 模式与 `gitMode` 的组合语义：清单元数据仍可用于安装/更新引导，但不得与 FULL 包内实体产生冲突。
- 恢复端交互必须区分“包内已有实体”“仅清单可在线安装”“无 URL 仅展示信息”三类状态。
- UI 文案必须说明在线安装需要网络、宿主安装端点权限和对应扩展仓库可访问。
- 保持纯前端可用；Authority 只能作为可选增强（例如暂存安装结果或跨设备同步），不可作为清单模式闭环的必要条件。

## Acceptance Criteria

- [ ] 清单 schema / 生成规则 / 恢复引导语义成文，并有对应单测计划。
- [ ] 与 `09-22-extension-git-slim` 的 keep/strip/minimal 策略关系明确，不重复实现或冲突。
- [ ] 对无 URL、重复名称、已安装、安装失败、Luker 平铺异常等边界有明确验收。
- [ ] README/用户说明计划列出，避免用户误以为清单包已经包含扩展代码。

## Out of Scope

- 不改变宿主扩展安装端点，不绕过宿主权限，不直接写实例目录。
- 不在本子任务中实现浏览器端 Git repack/shallow shrink。

## Open Questions

- OQ-1：清单模式是否增加“只导出列表、不安装”的只读选项，供用户审阅/分享。
- OQ-2：无 URL 扩展是否从 FULL 包回退提取 `.git/config`，或仅显示“无法在线安装”。
- OQ-3：恢复后是否应自动触发安装器，还是改为用户确认后触发。
