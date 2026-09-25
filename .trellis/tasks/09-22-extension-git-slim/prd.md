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

Luker 前端「一键更新」走 simple-git，调用链（`src/endpoints/extensions.js:686-704` 与 `:948-968`，见调研文档 §4.1）：

```
git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT)   // → git rev-parse --is-inside-work-tree
git.branch()                                     // → git branch --no-color
git.pull('origin', currentBranch.current)        // → git pull origin <branch>
```

- **该链路不调用 `git.status()`** —— 这一点是 `minimal` 策略可行性的关键（见下节实测）。
- 删除 `.git/` → `checkIsRepo()` 为 false，**在线更新功能彻底失效**（但扩展运行不受影响，因为运行期只读代码与资源）。
- 因此 `.git` 既不能无条件全删，也不能无条件全留。

### 现有能力缺口（本项目代码现状）

- `src/core/transform.js:27` 已有 `EXTENSION_MODES = { MANIFEST, FULL }`；`MANIFEST`（轻量清单模式）会**整体不打包插件实体与 git packfile**。
- `isJunkOrDevFile()` 已剔除 `.git/logs/`、`.git/hooks/`、`.git/refs/original/`（仅覆盖小头，不动 packfile）。
- `.git/config`、`.git/HEAD`、`.git/refs/heads/*` 会被解析进 `context.extensionGitMeta`（remoteUrl / branch / commit）。
- **缺口**：FULL 模式下 `*.pack` 瘦身无任何手段，而迁移包恰恰长期使用 FULL 模式（离线可用性优先）。
- `.git/objects/pack/*.pack` **不在** `isJunkOrDevFile()` 的剔除范围（该函数只剔 `.git/logs/`、`.git/hooks/`、`.git/refs/original/`）——所以 packfile 必然全量直通，464 MB 原样进包。
- Worker 选项经 `...options` 展开透传（`worker-client.js:38/102/122`），**无白名单**，故新增 `gitMode` 无需改 Worker 管线。

### 本轮取证（2026-09-25，git 层实测，非实例内）

方法：临时目录构造真实 `git clone` 仓库 → 施加各策略 → 跑酒馆更新链路的那三条命令。全部结论可复现。

| 策略（保留的 `.git` 内容） | `rev-parse --is-inside-work-tree` | `branch --no-color` | `pull origin <br>` | `status --short` | `fsck` |
| --- | --- | --- | --- | --- | --- |
| 仅 `config` + `HEAD` + `refs/heads/<br>` | **fatal rc=128（不认仓库）** | — | — | — | — |
| 上述 + 空 `objects/`、空 `refs/` 目录 | true rc=0 | `* master` | **rc=0 快进成功** | `bad object HEAD` rc=128 | — |
| 上述 + `index` + `objects/.keep` 占位文件 | **true rc=0** | **`* master`** | **rc=0 快进成功，文件内容正确** | **干净 rc=0** | **rc=0 无告警** |
| `strip`（无 `.git`） | **fatal rc=128** | — | — | — | — |

关键结论：

1. **git 的 `is_git_directory()` 要求 `.git/objects` 与 `.git/refs` 是真实存在的目录**——只留 `config`/`HEAD`/`refs/heads/<br>` 会被判为「不是仓库」，与 `strip` 无异。
2. **本项目管线全程文件条目驱动，空目录条目会被丢弃**（`zip-io.js:101` `filter((e) => !e.directory)`、`:111` `if (entry.directory) continue`），故**不能**靠空目录撑住 `.git/objects`；必须用占位文件（`.git/objects/.keep`）让该目录在解压后存在。
3. **补上 index 与占位文件后，酒馆更新链路三条命令全部通过**，且 `git pull` 会自动从 origin 补齐缺失对象，**首次更新后仓库自愈为完整状态**（`refs/remotes` 重建、`status` 干净、`fsck` 无告警）。
4. index 的取舍：**保留** `index` → 更新后 `status` 干净；**不保留** → 首次 pull 后仍残留 `D`/`??` 噪声。首次更新前二者都读不干净（无 index 时 rc=0 但误导、有 index 时 rc=128），但该链路不调用 `status`，故取「更新后健康」的保留方案。

> 上述为 **git 二进制层**结论；实例内表现仍须按 AC 做 Dev 往返实测（用户已授权）。

## Requirements

### R1 `.git` 处理策略枚举贯通

新增 `gitMode` 选项（取值 `keep` / `strip` / `minimal`），默认 `keep`（完全保持现有行为），贯通 `transform.js` → `plan-preview.js` → UI 选择器。

- `keep`：原样保留全部 `.git/` 条目（现状）。
- `strip`：**剔除整个 `.git/` 目录**。纯 JS 可实现、零风险，代价是产出包内插件失去在线更新能力（需重新 `git clone`）。
- `minimal`：仅保留识别与更新所需的最小集——`.git/config`、`.git/HEAD`、`.git/index`、`.git/refs/heads/<branch>`，**并合成一个占位文件 `.git/objects/.keep`**，剔除 `.git/objects/**` 全部对象存储。可行性已由本轮 git 层实测证实（见上节），且不依赖 ZIP 空目录支持。

### R2 策略生效位置与统计上报

- 策略在 `transform.js` 条目分流阶段生效（与 `extensionMode` 同层），不得影响 `.git/config`/`HEAD`/`refs` 的解析逻辑（`extensionGitMeta` 仍须正常产出）。
- `report` 与 `plan-preview` 需体现各策略的相对体积影响（剔除条目数与**字节数**），使用户在导出前可判断取舍。
- 现有 `Report.dropped(hubPath, reason)` **不接受字节数**（`src/core/report.js`），需向后兼容地扩参（可选第三参 `bytes`）+ 桶内 `droppedBytes` 累计，并同步其序列化输出。

### R3 UI 暴露

- 在导出/转换区提供 `gitMode` 选择（三选一 + 影响说明文案），默认 `keep`。
- 需与现有 `extensionMode`（清单/完整）选择器在语义上不冲突：`MANIFEST` 模式下 `.git` 整体不打包，`gitMode` 对其不产生额外作用（需在 UI 上做联动禁用或说明）。

### R4 Node 侧批量瘦身工具 → **Out of Scope（用户 2026-09-25 裁决：不纳入）**

调研报告 §5 的 shallow shrink 算法链（写 `.git/shallow` → 清 tag → 对齐 `refs/remotes/origin/HEAD` → `reflog expire` → `prune` → `repack -ad -l` → 删 `hooks/*.sample` 与 `logs/`）依赖**系统 git 二进制**，浏览器端无法执行；且形态上必须写实例目录，与 L0-1 冲突。

**本任务不做**。若日后需要，另立任务，并先解决「用户显式调用 + 默认拒绝实例路径 / 显式 `--force`」的安全形态。

## Constraints

- **纯前端优先（L0-11 / L1-MR-1）**：`gitMode` 必须在浏览器内零依赖实现；不得要求用户安装 git 或运行 npm。
- **实例隔离（L0-1）**：实现本身不写任何实例目录。本任务的**验收实测**已获用户授权，限定在 **Dev 实例**、且走**宿主原生恢复接口**（非人工拷贝文件）；Real 实例仍为只读禁区（L0-13）。
- **零回归**：`keep` 为默认值，现有 **358 项**测试（41 文件）行为不变。
- **vendor 副本（zip.js / fzstd）不可改动**。
- 判断依据不得来自宿主源码内部实现（L1-MR-5）——`checkIsRepo`/`pull` 行为以官方文档与既有调研已证实结论为准。

## Acceptance Criteria

- [x] `gitMode` 选项贯通 `transform.js` / `plan-preview.js` / UI，默认 `keep`，且现有 **358 项**测试全绿
- [x] `strip` 模式：单测断言产出包内 `.git/` 条目数为 0，且 report 上报剔除字节数
- [x] `minimal` 模式：单测断言**恰好**保留 `.git/config` + `.git/HEAD` + `.git/index` + `.git/refs/heads/<branch>` + 合成的 `.git/objects/.keep`，且 `.git/objects/` 下再无其他条目
- [x] `extensionGitMeta`（remoteUrl / branch / commit）在三种模式下均能正确解析产出
- [x] `plan-preview` 能预先呈现各模式的体积差异（条目数/字节数）
- [x] `minimal` 模式形成 **Dev 实例往返实测**结论（产出包经宿主原生恢复接口写入 Dev → 界面「检查更新」的实际表现；无论通过与否都必须成文，含 `git` 侧取证）——见 `research/dev-instance-roundtrip.md`，**通过**
- [x] README「核心特性」补充 `.git` 瘦身策略说明与各模式代价（含 minimal 首次更新前 `status` 不可读这一已知局限）
- [x] 产出物与 `keep` 模式的打包结果在非 `.git` 条目上**字节级一致**
- [x] `MANIFEST` 模式下 `gitMode` 不产生额外作用（不合成 `.keep`、不重复上报），UI 有联动说明
- [x] 四条既有静态守卫（css-scope / dom-injection / template-source / control-consumer）全部退出码 0

> 全部 10 条已达成。测试规模：**42 文件 / 386 passed / 2 skipped**（基线 41/358 → 新增 28 条）。

## 已裁决事项（2026-09-25，用户拍板）

- **OQ-1 → 已由 git 层实测证实可行**（见上「本轮取证」表），并**授权对 Dev 实例做往返实测**。
- **OQ-2 → 不纳入**：Node 侧实例批量瘦身工具（R4）本任务不做，理由见 R4 节。
- **OQ-3 → 默认 `keep`**：不在本任务改变既有默认行为；UI 上把 `minimal` 标注为「迁移包推荐：约省绝大部分 `.git` 体积且保留一键更新」。
- **OQ-4 → 检索已完成（L0-3）**：GitHub API 四组关键词（`git repo slim shrink history` / `git clone depth 1 batch` / `git slim tool` / `shallow clone tool`）**无可用现成方案**（首组命中 0，余组命中全为无关项）；WebSearch 通道在本环境不可用（路由报错）。结论：`strip`/`minimal` 本质是**条目级过滤**，复用现有 `extensionMode` 同层的分流机制即可，**不引入任何新依赖**。

## Notes

- 复杂度判定：需 `design.md`（策略分流设计 + 合成条目路径）与 `implement.md`，`task.py start` 前补齐。
- 本任务与 `extensionMode=MANIFEST` 是**互补关系**而非替代：MANIFEST 解决「无网环境外」的体积问题，`gitMode` 解决「需要完整离线包时」的体积问题。
- `strip` 与 `minimal` 的定位差异：`strip` 适合「接收方不需要在线更新」的归档场景；`minimal` 是**保住一键更新能力**前提下体积最小的方案，故 UI 推荐后者。
