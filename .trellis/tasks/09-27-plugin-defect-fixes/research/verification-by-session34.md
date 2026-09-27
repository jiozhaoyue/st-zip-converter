# 实例侧验证证据（由 Session 34 代跑，2026-09-28 凌晨）

> 本文件由**另一个会话**（Session 34，通宵迭代轮）写入，只登记**读数与证据**，
> **不代勾** `implement.md` 里的复选框 —— 那些条目由本任务的 owner 按自己的判据收口。
> 目的：让本任务的 E2E 类验收（4.3 等）有可追溯的现场读数，避免重复跑。

## 0 前置：实例插件已更新（R-20 纪律）

两个 **Dev** 实例的插件从 `d15737a` `git pull --ff-only` 到工作区最新（当时 `137d4f3`）：

| 实例 | 插件路径 | 结果 |
| --- | --- | --- |
| dev-st | `Instance/Dev/SillyTavern/public/scripts/extensions/third-party/st-zip-converter` | ✅ 快进，无本地改动 |
| dev-luker | `Instance/Dev/Luker/data/default-user/extensions/st-zip-converter` | ✅ 快进，无本地改动 |

**Real 实例未动**（`8002` / `8004`）。

## 1 全量 `npm run e2e`（含 guard + 新增的 library-inject + matrix + smoke）

**199 断言 / 198 通过 / 1 失败**（exit 1）。

| 段 | 读数 |
| --- | --- |
| `guard` | 全绿 |
| `library-inject`（本会话新增，见 §3） | **21/21** |
| `matrix` @ **dev-luker** | **全绿**（M-1 … M-10b，含批次续传 M-10b） |
| `matrix` @ **dev-st** | ❌ 中途抛错，见 §2 |
| `smoke` @ dev-st / dev-luker | **全绿**（dev-st 36/36） |

## 2 dev-st 矩阵的唯一失败：**宿主弹窗拦截**（不是断言逻辑失败）

```
[FAIL] 功能矩阵：宿主检测 / 计划预览 @ dev-st 未抛异常 — page.click: Timeout 30000ms exceeded.
  - waiting for locator('#btn-convert')
    - locator resolved to <button … id="btn-convert" class="… interactable">…</button>
  - attempting click action
    - element is visible, enabled and stable
    - <dialog open="" class="popup popup--animation-fast" data-id="1865ccd1-…">…</dialog> intercepts pointer events
```

**判据**：Playwright 明说**元素可见/可用/稳定**，但**被一个宿主 `<dialog class="popup">` 拦截指针事件** ⇒
这是**宿主侧弹窗未关**，不是产品缺陷、也不是断言写错。

两次全量跑**都在同一处**失败（另一次日志同形），且 **dev-luker 从不发生**。

**最可能的成因（待 owner 确认）**：宿主的一次性弹窗（刚 `git pull` 更新过扩展 ⇒ 宿主可能弹
"扩展已更新"一类提示；或 ST 的 splash `<dialog>` 未关）。本仓规范 §11.6（负载型假红）与
§11.7（宿主冷启动窗口）已收录同族问题：**矩阵要独占机器**跑。

**排除代码回归的证据**：
① 同一份代码在 **dev-luker 上矩阵全绿**；
② 同一份代码 **dev-st 冒烟 36/36 全绿**（注入点 panel/drawer/menu 全在、零本插件报错/失败请求）；
③ 失败签名是"指针被 dialog 拦截"，**没有任何本插件的报错**。

## 3 本会话新增的实例侧用例 `e2e/specs/library-inject.e2e.cjs`

驱动此前**从未被任何 E2E 驱动过**的 `#btn-host-fetch → injectLibraryChatsIntoSource()` 接线，
两档各 21 项，**dev-luker 上全绿**：

- **快档（默认）**：只勾 `characters`（≈40 MB）⇒ 拉取快；`chats` 未勾 ⇒ 插件**正确地不注入**
  （尊重用户选择），但路径与原因都可观测：探针 `lastListCount=3`、桩 `listChats` 被调过、
  日志含「聊天库检查完毕：… （跳过：… / 类目关断 3）」。
- **重档（`SZC_HEAVY_HOSTPULL=1`）**：勾上 `chats` ⇒ **真注入**：
  日志「**已把 2 条库中聊天补入源包**」、探针 `lastExportOk=2 / lastExportFailed=0`、
  导出集合恰为那两条桩聊天（隐藏容器条目被过滤）。

> 默认只跑快档：重档在 dev-luker 上要拉 ≈670 MB（几分钟），不该拖慢他人每次的 E2E。
> 驱动这条路径的**成本压缩与四处坑**已写进 `guides/instance-e2e-and-data-sync.md` §11.8。

## 4 建议 owner 收口时怎么做

1. 若要复现 dev-st 的绿：独占机器、并在跑之前**确认宿主没有未关闭的弹窗**；
   必要时先手工访问 `http://127.0.0.1:8001` 关掉一次性提示（该状态存在共享 profile 里）；
2. 4.3 的「连续两轮全绿」建议在 **dev-luker 单实例**`--url https://127.0.0.1:8003` 上取
   （它能完整跑完 M-1…M-10b）；
3. 本会话的改动对本任务**是加性的**（新增一个按钮 + 可用性求值 + 聊天库模块），
   已由 `npm test`（60 文件 / 581 项 / 0 失败）、独立形态 281 项、dev-st 冒烟 36/36 共同守护。
