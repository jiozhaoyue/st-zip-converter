# 扩展 Git 历史瘦身（Shallow Shrink）落地

## Goal

把「扩展插件 `.git` 历史占数据包体积过半」这一实测问题，从**只有调研报告**推进为**可交付的瘦身能力**：在纯前端路径上提供 `.git` 处理策略，使 FULL 模式产出包的体积大幅下降，同时明确各策略对「酒馆在线一键更新」能力的影响边界。

## Background

### 实测证据（`docs/research/luker-extension-mechanics-and-git-prune.md`）

| 观测对象 | 数据 |
| --- | --- |
| 真实用户包 `default-user-2026-09-06-175123.zip` | 未压缩 **1.11 GB / 10,877 条目**，其中 **464 MB 为扩展 `.git` packfile** |
| 本地实例 `data/default-user/extensions/`（32 个扩展）`.git` 合计 | 235.75 MB → 浅层截断后 **99.49 MB**（净省 136.26 MB，降幅 58%） |
| 压缩包体积 | 503.87 MB → **357.04 MB**（净省 146.83 MB，降幅 29.1%；条目 8532+ → 6484） |
| 现存退化根因 | ① `git clone` 未加 `--depth 1`；② 历史提交过的音视频/大图/`.js.map` 即使已删仍永久留在 packfile；③ reflog 与 `hooks/*.sample` |

### 宿主更新机制（决定瘦身不可越界的红线）

Luker 前端「一键更新」走 simple-git：`checkIsRepo(IS_REPO_ROOT)` → `branch()` → `pull('origin', currentBranch)`。
- 删除 `.git/` → `checkIsRepo()` 为 false，**在线更新功能彻底失效**（但扩展运行不受影响，因为运行期只读代码与资源）。
- 因此 `.git` 既不能无条件全删，也不能无条件全留。

### 现有能力缺口（本项目代码现状）

- `src/core/transform.js:27` 已有 `EXTENSION_MODES = { MANIFEST, FULL }`；`MANIFEST`（轻量清单模式）会**整体不打包插件实体与 git packfile**。
- `isJunkOrDevFile()` 已剔除 `.git/logs/`、`.git/hooks/`、`.git/refs/original/`（仅覆盖小头，不动 packfile）。
- `.git/config`、`.git/HEAD`、`.git/refs/heads/*` 会被解析进 `context.extensionGitMeta`（remoteUrl / branch / commit）。
- **缺口**：FULL 模式下 `*.pack` 瘦身无任何手段，而迁移包恰恰长期使用 FULL 模式（离线可用性优先）。

## Requirements

### R1 `.git` 处理策略枚举贯通

新增 `gitMode` 选项（取值 `keep` / `strip` / `minimal`），默认 `keep`（完全保持现有行为），贯通 `transform.js` → `plan-preview.js` → UI 选择器。

- `keep`：原样保留全部 `.git/` 条目（现状）。
- `strip`：**剔除整个 `.git/` 目录**。纯 JS 可实现、零风险，代价是产出包内插件失去在线更新能力（需重新 `git clone`）。
- `minimal`：仅保留识别所需的最小集（`.git/config`、`.git/HEAD`、`.git/refs/heads/<branch>`），剔除 `.git/objects/**` 等全部对象存储。**可行性待验证**（见 Open Questions OQ-1）。

### R2 策略生效位置与统计上报

- 策略在 `transform.js` 条目分流阶段生效（与 `extensionMode` 同层），不得影响 `.git/config`/`HEAD`/`refs` 的解析逻辑（`extensionGitMeta` 仍须正常产出）。
- `report` 与 `plan-preview` 需体现各策略的相对体积影响（剔除条目数与字节数），使用户在导出前可判断取舍。

### R3 UI 暴露

- 在导出/转换区提供 `gitMode` 选择（三选一 + 影响说明文案），默认 `keep`。
- 需与现有 `extensionMode`（清单/完整）选择器在语义上不冲突：`MANIFEST` 模式下 `.git` 整体不打包，`gitMode` 对其不产生额外作用（需在 UI 上做联动禁用或说明）。

### R4 Node 侧批量瘦身工具（范围待定，见 OQ-2）

调研报告 §5 的 shallow shrink 算法链（写 `.git/shallow` → 清 tag → 对齐 `refs/remotes/origin/HEAD` → `reflog expire` → `prune` → `repack -ad -l` → 删 `hooks/*.sample` 与 `logs/`）依赖**系统 git 二进制**，浏览器端无法执行。若纳入范围，形态只能是用户显式调用的 Node 脚本，且**不得**落入插件默认路径。

## Constraints

- **纯前端优先（L0-11 / L1-MR-1）**：`gitMode` 必须在浏览器内零依赖实现；不得要求用户安装 git 或运行 npm。
- **实例隔离红线（L0-1）**：任何实现都不得向 `D:\Repo\Tavern-repo\Instance\**` 写入。R4 若纳入，必须由用户自行对目标目录执行。
- **零回归**：`keep` 为默认值，现有 187 项测试行为不变。
- **vendor 副本（zip.js / fzstd）不可改动**。
- 判断依据不得来自宿主源码内部实现（L1-MR-5）——`checkIsRepo`/`pull` 行为以官方/调研已证实结论为准。

## Acceptance Criteria

- [ ] `gitMode` 选项贯通 `transform.js` / `plan-preview.js` / UI，默认 `keep` 且现有 187 项测试全绿
- [ ] `strip` 模式：单测断言产出包内 `.git/` 条目数为 0，且 report 上报剔除字节数
- [ ] `minimal` 模式：单测断言保留 `.git/config` + `.git/HEAD` + `.git/refs/heads/<branch>`，剔除 `.git/objects/**`
- [ ] `extensionGitMeta`（remoteUrl / branch / commit）在三种模式下均能正确解析产出
- [ ] `plan-preview` 能预先呈现各模式的体积差异（条目数/字节数）
- [ ] `minimal` 模式形成 Dev 实例实测结论（记录 `git status` 与酒馆「检查更新」的实际表现，无论通过与否都必须成文）
- [ ] README「核心特性」补充 `.git` 瘦身策略说明与各模式代价
- [ ] 产出物与 `keep` 模式的打包结果在非 `.git` 条目上**字节级一致**

## Open Questions（待新会话确认后再实施）

- **OQ-1（关键）**：`minimal` 模式下 git 是否判为仓库损坏？酒馆前端 `checkIsRepo` + `pull` 的降级表现如何？—— 必须用 **Dev 实例**实测，不得臆断。若结论为「直接报错崩溃」，则 `minimal` 应降级为「不建议」或直接从 MVP 移除，仅保留 `strip`。
- **OQ-2**：Node 侧实例批量瘦身工具（R4）是否纳入本次范围？纳入即触及 L0-1 实例写入边界，需用户明确授权与使用方式（默认拒绝实例路径 / 显式 `--force` 等）。
- **OQ-3**：UI 默认值是否应改为 `strip`？这会让用户产出包默认失去在线更新能力，属重大产品取向，需用户拍板。
- **OQ-4**（L0-3 检索先行）：实施前需检索是否已有现成方案可复用（如浏览器端 git 瘦身的既有实现、`git clone --depth 1` 引导类工具），避免自造轮子。

## Notes

- 复杂度判定：预计需 `design.md`（策略分流设计 + minimal 可行性验证方案）与 `implement.md`，`task.py start` 前补齐。
- 本任务与 `extensionMode=MANIFEST` 是**互补关系**而非替代：MANIFEST 解决「无网环境外」的体积问题，`gitMode` 解决「需要完整离线包时」的体积问题。
