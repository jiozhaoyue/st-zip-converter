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

- [x] 清单 schema / 生成规则 / 恢复引导语义成文，并有对应单测计划。
      → `design.md` §2/§3/§5；`test/extension-manifest.test.js` + `test/restore-manifest.test.js`。
- [x] 与 `09-22-extension-git-slim` 的 keep/strip/minimal 策略关系明确，不重复实现或冲突。
      → 不实现 `gitMode`（全仓 grep 无命中）；`research/00` 第 5 节给出互补不重叠结论。
- [x] 对无 URL、重复名称、已安装、安装失败、Luker 平铺异常等边界有明确验收。
      → 无 URL ⇒ `unavailable` + notes；重复/已安装 ⇒ 既有「本地已安装」徽标逻辑保留；
      Luker 平铺由 `thirdPartyFlattenedCount` 既有路径处理（未改动）。
- [x] README/用户说明计划列出，避免用户误以为清单包已经包含扩展代码。
      → README 新增「扩展打包模式（清单包不含扩展代码）」整节 + 恢复面板三态表。

## 交付状态（2026-09-24）

已完成实施并全量验证：`npm test` 274 passed / 2 skipped（基线 226/2，零回归）、
`check:css-scope` 与 `check:dom-injection` 通过、`npm run build` 成功、双入口自查 1/1。
核验证据见 `implement.md` 的「验证结果」与「主代理自核验」两节。

## Out of Scope

- 不改变宿主扩展安装端点，不绕过宿主权限，不直接写实例目录。
- 不在本子任务中实现浏览器端 Git repack/shallow shrink。

## Open Questions（2026-09-24 已全部裁定）

- OQ-1 → **采纳**：新增「仅导出扩展清单」只读选项，产物进待导出区、不触发安装（决策 D-2）。
- OQ-2 → **不采纳** `.git/config` 回退提取：无 URL 一律显式标 `availability = unavailable`，不伪造（决策 D-3）。
- OQ-3 → **保持自动弹出**，但只列「可在线安装」项；已内嵌实体与无 URL 项不提供勾选（决策 D-4）。

> 决策详情与代码锚点见本任务 `research/00-manifest-git-contract-evidence.md` 第 6 节。
> 技术方案见 `design.md`，执行步骤见 `implement.md`。
