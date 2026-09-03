# 酒馆系数据包互转工具

## Goal

在 SillyTavern / Luker / PureTavern / TauriTavern 四个酒馆系平台之间互转导出的 zip 数据包:任一平台的导出包转成任一其他平台能识别的导入包。核心资产(角色卡/聊天/世界书/各类预设/settings/头像)与 extensions、secrets 全量搬运。

## 已定决策(用户 2026-09-01 答复,不再重开)

1. **交付形态:脚本 + 插件都要。** 脚本指命令行工具(CLI 的解释见下),必须能在手机 Termux 上运行;插件指装进平台里的扩展,让用户在平台 UI 内直接"导出为目标平台格式"。
   - *CLI 是什么*:命令行工具,在终端里敲命令带参数运行的可执行程序,不是 .sh/.ps1 脚本文件。例:`tavern-convert 输入.zip --to pt -o 输出.zip`。
2. **PT 扩展闸:转换器侧绕过,不改 PT 代码。** PT 的扩展导入闸是有意设计(重装式迁移,见 research/platform-facts.md §4),转换器为 PT 目标包合成 `extension-sources` 记录即自然放行。若装最新 PT 后扩展仍导入失败,向 PT 仓库提 issue(附导入警告文案),不提"修 PR"——那是对设计决策的反对,不是缺陷修复。
3. **内容范围:全都要,secrets 绝对必须带。** 包含 secrets.json(ST 原生导出默认排除,本工具不排除);extensions 全搬。zip 泄露责任在用户,产物不做脱敏。

## Requirements

### R1 转换核心(hub 拓扑)

- 以 ST 用户目录布局为中间 hub 布局,四平台两两互转经 hub 完成(理由与证据见 research/platform-facts.md §5)。
- 覆盖转换矩阵(v1 六向核心):
  - ST ⇄ L:manifest.json 合成/剥离(L manifest = `{schemaVersion:1, createdAt, handle, selection}`)
  - ST/L → TT:包一层 `data/default-user/` 前缀
  - TT → ST/L:剥前缀、处理 TT 私有目录、补 manifest
  - ST/L → PT:输出 TT 布局 + 从扩展 manifest 的 `homePage` 合成 `data/_tauritavern/extension-sources/` 记录
  - TT → PT:TT 布局原样保留 extension-sources(PT 原生支持,工具提供"清理 TT 私有缓存"的规范化可选)
  - PT → ST/L/TT:消费 PT 的"TT 迁移包"导出(与 TT→X 同路径);PT 原生归档格式不在 v1
- 私有/超集数据处理:TT 私有(`_tauritavern/`、`_cache`、`_errors`)、L 引擎旁路(`_engine_dump.bin`/`_engine_meta.json`)按目标平台语义保留或丢弃,丢弃项必须在转换报告中逐条列出。

### R2 内容保真

- secrets.json 始终携带,任何方向、任何目标都不剥离。
- extensions/third-party 全量搬运;面向 PT 目标时 extension-sources 缺失则从 manifest homePage 合成(https 校验同 PT 规则)。
- 派生缓存(thumbnails/、backups/、vectors/、_cache/、content.log 等)默认丢弃以减小体积,提供 `--keep-all` 保留开关;丢弃行为在报告中列明。
- 文件字节零改动:只动路径层与元数据文件,不重写角色卡/聊天/世界书内容。

### R3 脚本(CLI)

- 单命令:`tavern-convert <in.zip> --to st|l|tt|pt [-o out.zip] [--keep-all] [--dry-run]`。
- 源布局自动识别(ST 摊平 / L 摊平+manifest / TT data 根 / PT TT 迁移包)。
- **Termux 可运行**:Node.js(≥18)LTS,依赖纯 JS、无原生编译模块。
- 大包流式处理:实测样本最大 964 MiB,内存占用须与包内最大单文件同阶,不整包载入。
- 输出转换报告:各模块文件数、跳过/丢弃清单、警告,人类可读 + `--json` 机器可读。
- 全程离线,不要求任何平台处于运行状态。

### R4 插件(ST / L)

- ST、L 各一个扩展插件,复用 R1 同一套转换核心(同一份代码,不是第二实现)。
- 功能:在平台 UI 内把当前用户数据导出为其余平台格式(至少 L→ST/TT/PT、ST→L/TT/PT)。
- v1 插件只做导出方向;导入走各平台原生通道(L 有 restore、TT 有三布局导入、PT 有 TT 导入、ST 手动铺文件)。
- 插件形态与安装方式在 design.md 细化;若平台扩展 API 限制导致某方向不可行,降级为"插件生成中间 hub 包 + CLI 一条命令完成"。

### R5 约束

- 实例数据只读铁律:开发与测试只用工作区副本与合成固件,绝不读写 `D:\Repo\Tavern-repo\Instance\**` 的实例数据目录。
- 不修改任何平台项目代码(PT 闸绕过、不做上游 PR)。

## Acceptance Criteria

- [ ] AC1 对工作区两个真实 zip(964 MiB L 包、162 MiB TT 包)跑通全部 v1 矩阵方向,`--dry-run` 与实转均无致命错误。
- [ ] AC2 转换报告的各模块计数(按 characters/chats/worlds/预设目录文件数)与源包一致,丢弃项逐条列出。
- [ ] AC3 L 目标包:条目相对用户目录摊平、manifest.json 字段齐全;用 L 的后缀匹配规则(镜像测试)验证主要类目全部可命中目标。
- [ ] AC4 TT 目标包:`data/default-user/` 前缀正确,TT 布局识别(`cargo test -p tt-adapter-archive` 参照)可通过等价断言。
- [ ] AC5 PT 目标包:结构满足 PT tauri-tavern 导入器要求(default-user 内层同构 + extension-sources 记录合法);以 PT 仓库 `tauri-tavern-codec.test.ts` 的断言为镜像写结构校验测试。用户手动在 PT 中导入一次确认角色/聊天/扩展可见。
- [ ] AC6 secrets.json 在所有目标包中存在且字节一致(ST 源包经本工具转换后含 secrets)。
- [ ] AC7 流式验证:964 MiB 包转换时 Node 进程峰值内存 < 512 MiB。
- [ ] AC8 Termux 冒烟:纯 JS 依赖安装无原生模块,CLI 在 Node ≥18 可启动并完成小包转换(桌面 Node 模拟验证 + 结构上禁止原生依赖)。
- [ ] AC9 ST/L 插件在 Dev 实例(UI 副本)加载成功,导出产物与 CLI 同源同构(同一核心模块)。

## Out of Scope(v1)

- PT 原生归档格式(sha256 清单)的读写。
- PT / TT 的导入端插件(两者已有原生导入通道)。
- ST 的图形化导入(平台限制,保持手动铺文件 + 文档说明)。
- 增量/选择性迁移(只转角色卡不转聊天等)——v2 候选。
- 修改 SillyTavern/Luker/PureTavern/TauriTavern 上游代码或提交 PR。

## Notes

- 事实依据全部在 `research/platform-facts.md`,含 file:line 证据;PRD 不重复。
- 技术选型(核心语言、流式库、插件打包)见 `design.md`;执行顺序见 `implement.md`。
