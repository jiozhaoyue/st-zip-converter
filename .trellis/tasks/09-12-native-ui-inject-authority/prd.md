# 原生导出UI注入+Authority后端集成

## Goal

在四个酒馆(SillyTavern/Luker/TauriTavern/PureTavern)的原生用户数据备份/导出UI处注入转换器入口按钮，与扩展现有抽屉共存；并以「可选增强适配器」模式集成 ST-Delegation-of-authority(Authority) 后端，承接前端做不到的持久化/任务能力，不可用时不影响纯前端主路径。

## Background

- 调研报告：`research/native-export-ui-anchors.md`（四宿主锚点同为 `.userBackupButton`）、`research/authority-backend-integration.md`（Authority SDK 能力边界）。
- 定位决策（2026-09-21 用户确认）：纯前端为主、Authority 为可选增强层，不转向前后端混合架构。

## Requirements

### R1 原生导出 UI 注入（已交付）

- 四宿主 `.userBackupButton` 锚点注入 `#st-zip-converter-native-btn`（复用 `menu_button menu_button_icon` 原生类，零新增 CSS）
- 多锚点覆盖：扩展设置抽屉、扩展菜单、账号弹层、管理面板每用户行、Luker 备份管理器（`.backupActionRow`）
- 共享 `watchHostDom` MutationObserver（200ms 去抖）统一四个注入点，宿主重渲染自动自愈，替代 1s setInterval 轮询
- 账号弹层锚点附「一键拉取」按钮（复用完整 handleHostExport 流程）；管理面板行只加打开入口，避免逐行"拉取当前用户"歧义
- 单体导出（聊天/角色卡/世界书单条）不注入——转换器消费整包 ZIP，语义不符

### R2 Authority 可选适配器（已交付）

- `authority-store` 适配器：Authority SDK 可用时经 `storage.blob` 持久化产物，不可用时静默降级纯前端路径
- 产物归档镜像：ExportQueue stash 入库成功后 `_mirrorToAuthority(item)` fire-and-forget，失败只告警不阻断本地入库
- ExportQueue 渲染合帧（rAF 优先），批量转换高频 notify 时整表重建按帧合并

## Constraints

- 注入按钮全部复用宿主原生类，不触碰 `.app-container`/`.st-converter-drawer-app` 作用域铁律
- Authority 集成为纯新增可选层，纯前端路径（IndexedDB/OPFS）保持默认可用
- vendor zip.js / fzstd 本地副本不可改动
- 严禁写入本地酒馆实例目录；实例更新只走 Git

## Acceptance Criteria

- [x] 四宿主 `.userBackupButton` 锚点注入（含管理面板行多锚点），MutationObserver 自愈
- [x] Luker 备份管理器内注入入口
- [x] authority-store 适配器 + 产物镜像（fire-and-forget），`test/authority-store.test.js` / `durable-mirror.test.js` 覆盖
- [x] ExportQueue 渲染合帧
- [x] 全量 `npm test` 187 项通过

## Deliverables（已提交）

- `438dbbc` feat(ui): native backup UI injection via .userBackupButton anchor + authority backend research
- `e930e3d` feat(storage+ui): authority-store adapter + native quick-fetch button
- `aef62e5` feat(storage+ui): artifact mirror on stash, Luker backup manager injection, shared MutationObserver
- `00b2e7d` feat(ui): multi-anchor native injection (admin panel rows) + export-queue render coalescing
