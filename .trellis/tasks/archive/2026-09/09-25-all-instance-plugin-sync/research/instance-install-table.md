# R1 八处宿主目录插件安装取证表

日期：2026-09-25 ｜ 目标版本：本仓 `origin/main` = `f26dcd5b820f7e4a283a7f385ab73ec687cf886a`
｜ 来源：`https://github.com/jiozhaoyue/st-zip-converter.git`（公开仓，匿名 https）

安装方式**只走 L0-1 允许的路径**：`git clone` / `git pull --ff-only`。全程**未复制任何文件**进实例目录。

| # | 实例目录 | 插件落点 | 方式 | 结果 | `git log -1` |
| --- | --- | --- | --- | --- | --- |
| 1 | `Instance/Dev/Luker` | `data/default-user/extensions/st-zip-converter` | 已装，`fetch` + `pull --ff-only` | `Already up to date.` | `f26dcd5…` ✅ = HEAD |
| 2 | `Instance/Real/Luker` | 同上 | 同上 | `Already up to date.` | `f26dcd5…` ✅ = HEAD |
| 3 | `Instance/Dev/SillyTavern` | `public/scripts/extensions/third-party/st-zip-converter` | **首次安装** `git clone --depth 1` | 克隆成功 | `f26dcd5…` ✅ = HEAD |
| 4 | `Instance/Real/SillyTavern` | 同上 | 同上 | 克隆成功 | `f26dcd5…` ✅ = HEAD |
| 5 | `Instance/Dev/TauriTavern` | —— | **未安装**（见下 B） | — | — |
| 6 | `Instance/Real/TauriTavern` | —— | **未安装**（见下 B） | — | — |
| 7 | `Instance/Dev/PureTavern` | —— | **未安装**（见下 C） | — | — |
| 8 | `Instance/Real/PureTavern` | —— | **未安装**（见下 C） | — | — |

四处已装件的 `manifest.json` 均可解析（`json.load` 成功）：
`name=st-zip-converter` / `display_name=酒馆数据包互转器` / `version=1.0.0` / `js=index.js` / `css=style.css`。

## A. 宿主仓未被弄脏（克隆落点已在宿主的 .gitignore 内）

| 实例 | 忽略规则 | 克隆后 `git status --short` |
| --- | --- | --- |
| `Dev/SillyTavern` | `.gitignore:18` `public/scripts/extensions/third-party/`、`:54` 同 | **空** |
| `Real/SillyTavern` | 同上 | **空** |

Luker 两处的插件在 `data/default-user/extensions/`（原状），`git status` 亦为空。

## B. TT 不装的理由（机制不符，非懒省）

TT 的第三方扩展**有自己的安装契约**，不是"往目录里 clone 一个仓"就等价：

1. **落点依赖运行时 data root，实例里根本没有该目录**：
   `Instance/{Dev,Real}/TauriTavern` **没有 `data/`**（`ls` 无输出）——TT 是 Tauri 桌面应用，
   data root 是**运行期可选**的（`docs/CurrentState/iOSPolicy.md:228` 出现"不支持 data root 选择时"的措辞）。
   离线状态下**无法确定**该往哪写。
2. **TT 的安装由它自己的安装器建立，形态不同**：
   `docs/CurrentState/ThirdPartyExtensions.md` 载明安装走 Rust gitoxide，且
   "新安装直接生成标准 non-bare embedded `.git/`"、branch/tag 有专门的
   version/branches/switch/update 四条契约。手工 clone 得到的是**非受管**目录
   （该文档亦提到"单个损坏的 legacy source 状态只会使对应扩展降为 unmanaged"），
   与 TT 自身的扩展管理状态不一致。
3. **只接受匿名 `http(s)` Git remote**（同上文档）——本仓满足，但那要经 TT 的
   `/api/extensions/install`，需要 TT 跑起来。

**权威落点（供将来安装）**：`ExtensionDEV.md:36-39` 与
`docs/CurrentState/ThirdPartyExtensions.md:133`：
local = `data/default-user/extensions/<folder>`，global = `data/extensions/third-party/<folder>`，
同名 local 优先；资源端点 `/scripts/extensions/third-party/<folder>/<path>`。
**替代路径**：TT 启动后经其自己的扩展管理器用本仓 URL 安装。

## C. PT 不装的理由（纯前端 Profile，无服务端扩展目录）

PT 官方 `apps/web/src/features/extensions/README.md` 写得很明确：

- `:3` "Browser-owned code replaces only the server Git/filesystem boundary."
- `:56` "`local` and `global` are compatibility scope labels **inside one browser Profile**.
  `move` changes that label **without copying blobs because the pure frontend has no multi-user
  server directory**."
- `:54` install/update/switch 把**完整快照存进 M13（浏览器侧 library blobs）**；
  由 Assets Service Worker 提供 `/scripts/extensions/third-party/<folder>/…`。
- 安装来源只支持**远程 URL**（jsDelivr / GitHub / GitLab / 直接 `.zip`），且明确把
  "Node server plugins, npm install scripts, arbitrary server routes,
  private repository proxies" 排除在外。

⇒ PT **没有磁盘扩展目录可供 clone**，包存在浏览器 Profile 的 IndexedDB 里。
`Instance/Dev/PureTavern/apps/web/.generated/public/scripts/extensions/` 是**构建产物**
（内含 `assets`/`attachments` 等上游内置扩展），**不是安装落点**。
**替代路径**：PT 启动后经其扩展管理器用本仓 URL 安装（本仓公开且 CORS 可达）。

## 结论

- 四宿主里 **ST / Luker 共四处已装到最新**（= HEAD，可加载验证的只有 Luker 两处，见 prd R2）。
- **TT / PT 共四处按 R1 例外条款不装**，理由与证据如上；这两处不算"未完成"，
  而是"该宿主的安装契约不允许离线目录方式"，替代路径已写明。
