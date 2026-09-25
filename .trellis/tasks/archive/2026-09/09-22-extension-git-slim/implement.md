# 实施清单：扩展 Git 历史瘦身（gitMode）

> 状态：**待 `task.py start` 后执行**。复选框随执行**实时勾选**（L0-2），禁止事后批量补勾。
> 每步的验证命令必须实际执行并在 PRD/笔记中留痕。

## 0. 预热（已完成，留证）

- [x] L0-3 双通道检索：GitHub API 四组关键词无现成方案可复用；WebSearch 在本环境不可用（已记录在 `prd.md` 已裁决事项 OQ-4）
- [x] git 层实测：临时目录复现四类 `.git` 保留集 → 三条更新命令 + `status` + `fsck`，结论落 `prd.md`「本轮取证」表
- [x] 用户裁决三项：Dev 往返实测**授权** / Node 工具**不纳入** / 默认值 **keep**
- [x] 现场读码确认：Worker 选项 `...options` 透传无白名单；`zip-io.js:101/111` 丢弃目录条目；`isJunkOrDevFile` 不剔 packfile；`Report.dropped` 不收字节数

## 1. 纯逻辑层（`src/core/`）

- [x] 1.1 `transform.js`：新增 `GIT_MODES` 常量并导出
- [x] 1.2 `transform.js`：新增并导出 `isGitEntry()` / `isGitMinimalKept()` 纯函数（另导出 `normalizeGitMode()` / `gitDropReason()` / `GIT_KEEP_PLACEHOLDER`）
- [x] 1.3 `transform.js`：`transform()` 选项加 `gitMode`（默认 `KEEP`，未知值回落 `KEEP`）；`context` 加 `gitMinimalRoots: Set`
- [x] 1.4 `transform.js`：`extension-pkg` 分支插入 `gitKeep` 判定；三个元数据处理器改三分支（MANIFEST / 不保留 / 写出），**解析逻辑保持在三模式下均执行**
- [x] 1.5 `transform.js`：在「轻量清单跳过其他代码文件」前插入 `.git` 兜底闸（`gitEntry && !gitKeep` → skip + 上报）
- [x] 1.6 `transform.js`：`emitSynthesized()` 合成 `<root>/.git/objects/.keep`（走 `targetEntryPath`，`dryRun` 时只上报）；登记点放在**元数据真正写出的分支**内，避免同名冲突被跳过者产生孤儿 `.keep`
- [x] 1.7 `report.js`：`dropped()` 扩可选第三参 `bytes`，模块桶加 `droppedBytes`，`toJSON` totals 与 `toHuman` 同步
- [x] 1.8 `plan-preview.js`：加 `gitMode` 选项 + 动作链分支（置于 MANIFEST 之后、MIGRATE 之前）+ `.keep` 合成项预测（含类目未勾选时不预测）

- 验证：`npx vitest run` → **41 文件 / 358 passed / 2 skipped**（零回归，§1 无新增用例前）

## 2. UI 层（`src/ui/` + `index.js`）

- [x] 2.1 `workbench-template.js`：I 区新增 `git-mode` 单选组（复用 `.ext-mode-row` / `.ext-mode-opt`，**不新增 CSS**；代价说明走 label 的 `title`）
- [x] 2.2 `index.js`：新增 `getGitMode()`；接到 4 处 `extensionMode` 透传点（实际落在 `:598/:976/:1057/:1377`）
- [x] 2.3 `index.js`：`extension-mode=manifest` → git 单选组 `disabled`（`syncGitModeAvailability()`）+ 折叠摘要体现「完整离线包 · Git 瘦身 / 轻量清单（不打包 .git）」；change 时 `refreshPlan()`
- [x] 2.4 `scripts/control-consumer-guard.js`：登记 `'name:git-mode'` 消费点声明

- 验证：四条守卫全部退出码 0（css-scope / dom-injection / template-source / control-consumer）；`npm run build` 通过

## 3. 测试（`test/git-mode.test.js` 新增，28 条）

- [x] 3.1 `keep` 回归：`.git/**` 条目全留，`extensionGitMeta` 三字段正确
- [x] 3.2 `strip`：产出包 `.git` 条目数 **= 0**；`report` 的 `droppedBytes` > 0，packfile 条目字节数精确
- [x] 3.3 `minimal`：保留集**恰好**为 `config` + `HEAD` + `index` + `refs/heads/<branch>` + `objects/.keep`；`objects/` 下再无其他条目
- [x] 3.4 三模式下 `extensionGitMeta`（remoteUrl / branch / commit）均正确（经 `_convert/extensions-manifest.json` 断言）
- [x] 3.5 非 `.git` 条目在 `keep` 与 `minimal` 之间**字节级一致**
- [x] 3.6 `MANIFEST` + `minimal` 不合成 `.keep`，且不上报额外剔除（该条**捕获到一处真实缺陷**：MANIFEST 下兜底闸抢了清单文案，已修）
- [x] 3.7 未知 `gitMode` 值回落 `keep`
- [x] 3.8 `plan-preview`：动作与体积差异、`.keep` 合成项出现、MANIFEST / 类目未勾选下不出现
- [x] 3.9 `isGitEntry` / `isGitMinimalKept` 边界：`.gitkeep` 不算、`.git/refs/heads/feat/x` 算
- [x] 3.10 追加：UI 契约（三入口模板三档齐全 + 默认 keep、每档 `title` 写明代价、守卫已登记且 `index.js` 有真实读取点与 4 处透传）

- 验证：`npm test` → **42 文件 / 386 passed / 2 skipped**（基线 41/358 → +28 条零回归）；`npm run build` 通过

## 4. 文档

- [x] 4.1 README「核心特性」补三种策略与代价表（含 minimal 需接收方联网、首次更新前 `status` 不可读的已知局限）——落在「🧩 扩展打包模式」下新增的「`.git` 历史策略」小节

## 5. 实例验收（Dev 往返实测，已授权）

- [x] 5.1 Dev 8003 **本就在运行**（HTTPS；journal 里「已崩」的记录已过时）——未重启、未改配置
- [x] 5.2 用本插件产出 `minimal` 包（`target=st`，3 592 B，剔除 3.15 MB），经**宿主原生恢复接口**写入 Dev
      —— 端点实为 `POST /api/users/restore-backup`（`/api/users/restore` 在 L 上是 404，黑盒探测所得），HTTP 200 / `restoredCount:7`
- [x] 5.3 宿主「一键更新」链路三条命令在实例目录内实跑：`is-inside-work-tree=true`、`branch=* main`、真实 `git pull` 快进成功且拉取到上游新提交
- [x] 5.4 现场输出已记录：恢复后 `.git` 5 个文件（含 101 B 的 `objects/.keep`）；pull 后 `.git` 5→22、`status` 干净、`fsck` 无告警
- [x] 5.5 结论成文落 `research/dev-instance-roundtrip.md`（**通过**），并回填 PRD 该条 AC

- 附：`/api/extensions/discover` 200 且列出探针扩展（界面侧数据源）；包裹未落 Real(8004)；探针扩展 `zz-git-slim-probe` 仍在 Dev 中，待用户决定是否清除

## 6. 质量门与收口

- [x] 6.1 四条静态守卫全部退出码 0：`check:css-scope` / `check:dom-injection` / `check:template-source` / `check:control-consumer`
- [x] 6.2 `git status --short` 核对改动范围（**注意：不得用 `git diff --stat` 判断范围**，L0-17）——产品代码仅 7 个文件 + 1 个新测试文件
- [x] 6.3 spec 沉淀：`.trellis/spec/guides/tavern-datapack-formats.md` 新增 §5「扩展 `.git` 历史策略 (gitMode)」（自包含：白名单、`.keep` 命门、两处实测取证、实现落点），**并更正该文件 §3 中「不存在 Shallow Git 转换能力」这一已作废条文**；「环境教训」补记 Luker 恢复路由与 CSRF/会话绑定两处宿主端事实
- [x] 6.4 提交（`cdc9772`；分支 `feat/git-history-slim` 已在 `task.py start` 时登记进 `task.json`）
- [x] 6.5 `git push` 到 origin（L0-7）——`origin/feat/git-history-slim` = `cdc9772`

## 回滚点

- §1 完成 → 可独立回滚（默认 `KEEP`，行为与今日一致）
- §2 完成 → UI 层回滚不影响 §1 契约
- §5 若实测推翻 `minimal` 可行性 → 回滚 §1.4/§1.6 的 minimal 分支，仅保留 `strip`（PRD 已预留此降级路径）

## 当前不做

- 不做 Node 侧实例批量瘦身脚本（R4，用户已裁决 Out of Scope）
- 不改 `src/vendor/**`；不引入任何新依赖
- 不向 Real 实例写入（L0-1 / L0-13）
