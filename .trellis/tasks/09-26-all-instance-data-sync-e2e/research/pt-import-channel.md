# PT（PureTavern web）数据导入通道取证 —— 结论：**web 模式下无后端，M21/TT 导入跑不通**

> 取证日期 2026-09-26 ｜ 实例 `:8899`（`Instance/Dev/PureTavern/apps/web`，`pnpm dev`）
> 目的：为 `implement.md` **3.9**（PT 同步）确定可用通道；结论推翻了「PT 全自动」的默认假设。

## 1. 面板入口与控件（**已实测存在**）

在 PT 界面「扩展程序 → PureTavern 数据管理」面板内实测到两组导入控件：

| 控件 id | 用途 | 默认值 |
| --- | --- | --- |
| `#ptdm-import-file` + `#ptdm-import-method` | PT 自家归档导入 | method = `fast` |
| `#ptdm-tt-import-file` + `#ptdm-tt-strategy` | **TT 归档导入**（本任务所需） | strategy = `merge` |
| `#ptdm-tt-import-confirm` | 「执行 TauriTavern 导入」按钮 | 未选文件时 **disabled** |

TT 导入的界面说明（`apps/web/src/features/import-export/runtime/index.js:1027`）：
> 「TauriTavern 格式即 SillyTavern 的 `data/default-user` 目录，可直接被 TauriTavern 的数据迁移扩展导入。」

⇒ **与本任务产出的 `pack-tt-*.zip` 形态一致**（包内 `data/**` 根）。策略 `merge` 与 U-3「覆盖同名、不删独有」一致。

## 2. 流程是**三段式**，不是「选文件即完成」

读实现（`runtime/index.js:690-760`）：

1. 选文件 → 启用 `#ptdm-tt-import-confirm`；
2. 点确认 → **模块选择对话框**（`chooseImportModules`）；
3. 再弹**二次确认**（`confirmAction`：「已选择 N 个模块，检测到 M 个冲突…确定继续吗？」）；
4. 才真正执行：优先走 `globalThis.__PURE_TAVERN_DATA_STREAMING__`（**Tauri 桌面桥**），
   否则 `fetch('/api/backups/tauritavern/import')`（`TT_API = '/api/backups/tauritavern'`，`index.js:4`）。

## 3. **决定性证据：web 模式没有这个后端**

| 探针 | 结果 | 判读 |
| --- | --- | --- |
| `GET /api/backups/tauritavern/import` | HTTP 200，`Content-Type: text/html`，体为 `<!DOCTYPE html>` Vite 页面 | **SPA 兜底**，不是后端 |
| `POST /api/backups/tauritavern/import`（JSON 体） | **HTTP 404**，无 content-type | 该路径在 web 模式下**没有注册处理器** |

⇒ 第 4 步的 `fetch` 拿到的是 404/HTML，`response.json()` 必失败 ⇒ **导入在 PT web 上必然失败**，
与 `PTD` 自身逻辑无关，属**部署形态缺件**。

后端在哪：PT 仓内的 `apps/` 有 `desktop` / `harmony` / `mobile` / `remote-server` / `vscode-extension` / `web`；
`/api/backups/*` 的路由注册点在 `apps/web/src/features/import-export/legacy/register-routes.ts`，
但 web dev server 未挂载该路由（POST 404 即为证据）。⇒ 需要 **remote-server / desktop** 形态才有该后端。

## 4. 结论与残留

- **PT 同步本轮未执行**（`implement.md` 3.9 未完成）。
- 若要打通，需要**另起 PT 的 remote-server（登记端口 3030，L0-16）**并让 web 与它同源/代理，
  这超出本任务「启动已登记实例」的范围 ⇒ 属**方向性决策**，须用户裁定（已在收尾时提出）。
- 可以先行确认的**前置条件已满足**：本插件在 PT 上已装好（见 `git log` 的
  `9358fbd feat(sync): PT 自动化（装插件流程已走通）` 与 `test-results/pt-install-result.png`）。
- 核对手段的限制：PT 是**纯前端**（数据落 IndexedDB，`userDir: null`），
  故即便导入跑通，也只能用「IndexedDB 计数 + 界面读数」核对，**不能**用 `diff-report.cjs` 的路径比对。
  本仓库已备好读数函数（`pt-automation.cjs` 的 `countPtData()`：逐库逐 store `count()`），导通则可直接复用。
