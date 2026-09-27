# 独立 Web / 云部署形态的自动化验证套件

> 本文件是**工作副本**；规范条文已落 `.trellis/spec/guides/standalone-web-and-cloud-e2e.md`。

## Goal

给「**页面自己就是站点**」的那条形态补上自动化验证 —— 它此前是**零覆盖**的。

现状取证（会话开始前）：

| 事实 | 证据 |
| --- | --- |
| E2E 只有 `guard`（无实例）+ `smoke` / `matrix`（`dev-st` / `dev-luker`） | `e2e/specs/*.e2e.cjs` 的 `requiresInstance(s)`；`e2e/run.cjs` 只扫该目录 |
| 独立形态**没有任何**自动化 | 全仓检索：无 `e2e` 用例引用 `dist/`、`5173/3040/4173`、`独立 Web 模式` |
| 独立形态的真实部署形态是**子路径** | `vite.config.js` 的 `base: './'`；静态托管（GitHub Pages 项目页）挂在 `/<repo>/` 下 |
| 该形态的报错**全量可归因**（页面 100% 是本插件） | 与实例态相反（同页 30 个第三方扩展 ⇒ 只能按 slug 归因） |

## Requirements

### R1 独立运行器（不干扰实例 E2E）· MUST

- 新目录 `e2e/standalone/`，新命令 `npm run e2e:web`；
- **只扫** `e2e/standalone/specs/*.e2e.cjs`，`e2e/run.cjs` 只扫 `e2e/specs/` ⇒ 两者互不触发；
- 不需要任何实例在跑；**不引入任何新依赖**（Playwright 仍走 `e2e/lib/resolve-playwright.cjs`）。

### R2 子路径部署形态 · MUST

- 站点挂载前缀可配（默认 `/st-zip-converter/`，`--prefix /` 可对照根路径）；
- 判定：同源请求**没有一条**落在前缀之外；零 4xx/5xx（favicon 除外，见 R4）。

### R3 转换闭环要验到**产物内容** · MUST

- 上传 → 计划预览 → 转换 → 待导出区 → **下载产物 → 解包核对条目**；
- 只验「队列里有一行」不算（空包也会有一行）。

### R4 判定纪律：先证明判定能抓到违规 · MUST

- 每条「相等/不小于」类断言前先有一条**非空读数**的前置门（否则两侧同为 0 时恒真）；
- `favicon.ico` 必须排除（未声明 icon ⇒ 浏览器必然去根路径取一次 ⇒ 子路径下必然 404；不排除即假红）；
- 计划阶段的读数取**类目卡片**（`.category-card[data-category] .cat-badge`），
  **不是** `#report-panel` 里的 `#count-*`（那是转换后报告，初始 `hidden`）；
- 数字输入框填值一律**回读校验**（`page.fill` 会静默不写入）。

### R5 非目标 · MUST NOT

- **不**改 `e2e/specs/**`（并发会话正在使用）；**不**改实例侧端口白名单与 `guard.cjs`；
- **不**触碰宿主实例目录与宿主源码。

## Acceptance Criteria

| 编号 | 判据（可执行） |
| --- | --- |
| **AC-1** | `npm run e2e:web` 在**无任何实例在跑**时全绿退出（exit 0） |
| **AC-2** | 子路径形态下：同源请求 0 条越界、0 条 4xx/5xx（favicon 除外）—— 且**判别力已实测**：把 `npm run build` 的 `--base=./` 临时改成 `--base=/` ⇒ **10 条转红**（A1–A5 形态判定 + B1–B4 + 闭环一条） |
| **AC-3** | 转换闭环验到产物：下载后的 zip 是合法包，含 `characters/` 与 `chats/` 条目（与源包对应） |
| **AC-4** | 包选择预设：三类目读数非零为前置门；预设生效的证据是**世界书/系统设置被取消勾选** |
| **AC-5** | 分卷：阈值**回读确认**写进输入框；产物 ≥ 2 份、序号从 1 连续、抽验是合法 zip |
| **AC-6** | 形态差异可见契约：独立形态下**无**「从宿主拉取」入口、产物行**无**「写回宿主」按钮 |
| **AC-7** | 全流程零页面异常 / 零控制台错误 / 零失败请求 |
| **AC-8** | `npm test` 零回退（新增目录不被 vitest 收集） |

## 交付读数（2026-09-28 实测）

| 项 | 读数 |
| --- | --- |
| `npm run e2e:web -- --rebuild` | **183 断言 / 183 通过 / 0 失败**（8 个 spec） |
| spec 构成 | `workbench` 42 · `targets` 51 · `chat-store-module` 17 · `pause-resume` 16 · `flows` 16 · `library-export` 13 · `perf` 12 · `split` 10 · `file-protocol` 6 |
| 判别力证明 | ① 构建脚本 `--base=./` → `--base=/` ⇒ workbench **10 条转红**；② 移走 `webfonts/` 并 `--rebuild` ⇒ **6 条转红**（含 A7/A8 与 2 条 4xx）；③ 不注入桩 ⇒ 聊天库补齐**消失**（M14/M15） |
| `npm test` | **60 文件 / 573 passed / 2 skipped / 0 failed**（默认并发下先出现 13 条 5s 超时型失败，全为资源争抢；机器 idle 仅 3.3%、并发会话 18 个 chrome；`--maxWorkers=2` 复跑全绿） |
| 静态守卫 | 五条 `exit=0` |

## 由本任务发现并顺手修掉的缺口

1. **独立形态的 Font Awesome 走 CDN 外链**（`index.html`）。由本 spec 的「跨源请求」信息项
   读数发现 ⇒ 违反用户级 `nocdn`，且离线/云部署下全部图标失效。已改 `src/vendor/fontawesome/`
   本地副本（`L1-MR-11` 惯例），跨源读数 **2 → 0**，并把它从「信息项」升级为
   **三条硬断言**（A6 图标元素非空 / A7 字族已加载 / A8 `::before` 命中 FA）。
2. **运行器的构建新鲜度判据看不见「删了源码文件」**（只看 mtime）⇒ 首轮判别力实验跑了旧
   `dist/`，**无效实验**。新增 `--rebuild` 强制重建。

## 阻塞（非本任务可解）

- **实例侧验证不可做**：另一会话的 `e2e/run.cjs` 进程自 2026-09-27 22:20 起挂死（CPU 两小时
  只涨 8s），期间 dev-st 页面停在 `Initializing…`（`#send_form` 在、但初始化不完成），
  smoke 读数呈现「panel/drawer/menu 全 false 且零本插件报错」——**这是实例被拖住的形态，
  不是产品结论**，故不作任何判定。待其释放后再跑实例侧矩阵。
