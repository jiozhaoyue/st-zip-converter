# PT（PureTavern）数据同步 —— 读数与两条结论更正

> 第六轮（2026-09-26/27）。**PT 同步已完成**（implement.md 3.9）。
> 全文 `file:line` 相对本仓根；PT 侧路径相对 `Instance/Dev/PureTavern`。

---

## 1. 两条**先前结论的更正**（都是错的，本轮实地证伪）

### 1.1 「需另起 PT `remote-server` 才有导入后端」—— ❌ 错

**原结论**（`research/pt-import-channel.md`）：「web dev server 未挂载该路由（POST 404）⇒ 需 remote-server」。

**证伪（本轮实测）**：

- PT 的 `/api/*` **不是服务端后端**，而是 PT **纯前端**自己注册的「legacy 兼容路由」——
  `apps/web/src/features/import-export/legacy/register-routes.ts` 注册在
  `CompatibilityRouter` 上，由 `apps/web/src/legacy-hook/bootstrap.ts` 的
  `installCompatibilityFetch(router)` **补丁页面内的 `window.fetch`** 来生效。
- **页面内**发请求完全可用，实测：
  - `POST /api/backups/archive/inspect` → **200**（返回 `assets 659 records · 329 blobs · 26.7 MB`）
  - `POST /api/backups/tauritavern/import/preview` → **400**
    `{"error":"Archive ZIP file is required.","code":"missing-file","pureTavern":true}`
    注意：**400（参数缺失）而非 404** —— 路由**存在**。
- 早先拿到 404，是因为探查**绕过了页面内被补丁的 `fetch`**（走 Node 侧 / Playwright 的 request）
  ⇒ **404 是探查方法的伪影**，不是能力缺失。

### 1.2 「起 `remote-server` 能帮上忙」—— ❌ 错（且方向相反）

`apps/remote-server` 是 **LLM 请求代理**，其 README 明写只提供：

- `GET /v1/health`（Bearer 鉴权与协议握手）
- `POST /v1/proxy`（转发最终 GET/POST，绕过浏览器 CORS）

⇒ **与备份/导入毫无关系**，起它对数据同步**零帮助**。
（用户当时裁定「起 remote-server 并推进」是基于 1.1 的错误前提；本轮回报并改走正确路径。）

---

## 2. 实际走的路径：宿主数据管理面板（真实用户路径）

数据管理面板是独立的 `<dialog id="pure-tavern-data-management-dialog">`，
由设置里的「**打开数据管理**」按钮打开。**注意**：它不是「点设置项抽屉展开」就能看到的东西 ——
先前 `pt-automation.cjs` 的 `--import-pack` 分支正是栽在这里（文件设进去了但流程没起来，
截图显示面板根本没打开）。

面板内两组导入控件（`apps/web/src/features/import-export/runtime/index.js`）：

| 控件 | 用途 |
| --- | --- |
| `#ptdm-import-file` + `#ptdm-import-method` | PT 自家归档（`fast` / `slow`） |
| `#ptdm-tt-import-file` + `#ptdm-tt-strategy` | **TT 归档**（本项目产出 TT 布局树 ⇒ 走这组） |

**实现落点**：`scripts/instance-sync/import-pt.cjs`（新增），计数装置抽为
`scripts/instance-sync/lib/pt-count.cjs`（与 `pt-automation.cjs` 共用，防口径漂移）。

### 2.1 三个必须踩过的坑（都实际踩过并修掉）

1. **只投文件不会开始** —— 必须点「执行 TauriTavern 导入」（`#ptdm-tt-import-confirm`）。
2. **该按钮在预览完成前是 `disabled`** —— 投文件只触发**异步预览**
   （`previewTauriTavernImport`：`:629 disabled = true` → 预览完成 `:684 disabled = false`）。
   实测：投完就点 ⇒ 拿到「被禁用」，整条流程**静默不走**。
3. **确认对话框是两层、且用同一个选择器** `[data-action="confirm"]`：

   | 层 | 来源 | 内容 | 按钮文字 |
   | --- | --- | --- | --- |
   | ① 模块选择 | `chooseImportModules`（`:187`） | 「选择要导入的 TauriTavern 模块」 | **继续** |
   | ② 请确认 | `confirmAction`（`:150`） | 「已选择 N 个模块，检测到 M 个冲突…确定继续吗？」 | **确定** |

   且**两层之间隔着一段真实工作** —— `slow` 模式下会先做**逐文件 CRC/SHA-256 校验**
   （7209 文件 / 1.16 GB 实测数分钟）。
   先前实现只轮询 6×1.5 s ≈ 9 秒 ⇒ **等不到第二层** ⇒ 「继续」点完导入**根本没开始**，
   而外层还在傻等完成信号直到超时（症状：日志停在 `已处理确认层：module-picker(继续)` 之后再无进展）。
   **修法**：改为**时长预算**模型，退出条件取「页面导航 / 完成文案 / 预算耗尽」三者之一，
   校验期**持续等待**并每 30 s 打一次进度。

4. **完成信号是「页面 reload」，不是浮层文本** ——
   源码 TT 分支末尾 `notify('success', 'TauriTavern 数据导入完成，页面即将刷新。')`
   之后立刻 `setTimeout(() => location.reload(), 500)` ⇒ 该浮层**只存在约 500 ms**，
   3 s 间隔的文本轮询**必然错过**。
   实测症状：计数明明已 +15759，却被判成「超时未检出完成信号」。
   **修法**：改用 `framenavigated` 事件作判据，文本轮询收紧到 800 ms 作辅助。

### 2.2 大包风险与守卫

PT 是纯前端，数据落 **IndexedDB**，磁盘上**没有数据目录**（`e2e/lib/instances.cjs` 的
`pt-web.userDir` 按设计为 `null`）。实测面板读数：

- 存储模式 = **「尽力而为」**（非 `persistent`）
- 面板自己的警告原文：「浏览器未授予持久化存储：磁盘空间不足时，**它可能在不通知的情况下清除本站的全部数据**。建议定期导出 ZIP 备份到本地磁盘。」
- 导入后：**用量 660.5 MB / 配额 10.6 GB（6.06%）**

⇒ `import-pt.cjs` 对 > 100 MB 的包**默认拒绝执行**，需显式 `--allow-large`
（把风险摆到明面上，而不是替用户默默决定）。

---

## 3. 导入读数（pack-tt，510.8 MB）

```
[导入] 导入方式：slow（大包须 slow = 逐文件低内存，shared with #ptdm-import-method）
[导入] 策略：merge（U-3 要求 merge）
[导入] 预览读数：TauriTavern 数据包：7209 个文件 … 发现 8 个可导入模块 · 1.16 GB
[导入] 共处理确认层 2 层：module-picker(继续) → confirm(确定)
[导入] 结果：done=true signal=页面已 reload（导入完成）  耗时 337.3s
[计数] 导入后总记录 1310 → 17069（Δ15759）
       + pure-tavern-modular-dev.records: 976 → 11740（+10764）
       + pure-tavern-modular-dev.blobs:   334 →  5326（+4992）
       + shujuku_v120_config_v1.kv:         0 →     3（+3）
```

**只增不减**（`shrank` 为空）—— 这是 U-3「不删独有」的直接体现。

---

## 4. 内容级核对（AC-2 / AC-3 在 PT 上的形态）

⚠️ **PT 无磁盘目录 ⇒ `diff-report.cjs` 那套按路径比对的核对在 PT 上根本不可用**。
PT 侧唯一可程序化读到的真源是 **IndexedDB 的逐库计数** + **面板的逐模块读数**
（`import-pt.cjs --report`）。界面上的模块条目会被虚拟滚动截断，不能当判据。

### 4.1 PT 侧模块读数（`--report`）

| 模块 | records | blobs | 体积 |
| --- | --- | --- | --- |
| assets | 10597 | 5298 | 195.6 MB |
| characters | **25** | 25 | 53.2 MB |
| chats | **467** | 0 | **838.0 MB** |
| extensions | 51 | 0 | 54.3 KB |
| personas | 1 | 0 | 3.64 KB |
| presets | 549 | 0 | 33.6 MB |
| secrets | 1 | 0 | 3.39 KB |
| settings | 1 | 0 | 21.5 MB |
| stats | 0 | 0 | 0 B |
| world-books | 44 | 0 | 19.6 MB |
| **合计** | | | **≈ 1161.6 MB** |

### 4.2 体积判据：**精确吻合** ✅

源包**未压缩 1.16 GB** 与 PT 侧各模块体积合计 **≈ 1161.6 MB** 吻合 ⇒
**数据完整落库**，计数差异来自**口径**而非丢失。

### 4.3 三项可精确对上的读数 ✅

| 判据 | 源侧 | PT 侧 | 结论 |
| --- | --- | --- | --- |
| 聊天角色目录数 | **23** | `chats\|owner-aliases` = **23** | **相等** |
| 「孤独摇滚」系列聊天 | 131+9+1+1+22+1 = **165** | **165** | **相等**（源侧 `孤独摇滚1/2/2_1/3/3_1` 在 PT 侧归一到 `孤独摇滚`） |
| 真聊天 `.jsonl` 数 | **223** | **222** 个聊天（+1 个是 E2E 夹具 `Fixture Character`） | 基本一致（见 §4.4） |

### 4.4 计数口径差异（**登记，非缺陷**）

`chats/` 的 **1029 条** 并不全是聊天 —— 实测构成：

| 类别 | 条数 |
| --- | --- |
| 真正的聊天 `.jsonl` | **223** |
| `.luker-state.*` 附属状态文件 | **786** |
| 其它（`runs/**` 编排运行记录：manifest / checkpoint / resolved_* 等） | **20** |
| 合计 | **1029** |

⇒ 「1029 条聊天」是**文件条目数**，不是**聊天数**。
这与缺陷 F-4 同形（当时把 Luker 的**版本历史**当成 430 张不同的卡；实际 26 个角色）。
PT 的 chat 模型是「**每个聊天 = 1 条 `chats|messages` + 1 条 `chats|sessions`**」
（键形如 `chats␟messages␟<uuid>`），故 222 个聊天 = 444 条记录 + 23 条 `owner-aliases` = **467** ✓
与面板读数**自洽**。

**characters 25 vs 源侧 29 个人类名卡片 / 376 条内容寻址条目** —— 同为口径差异
（与 ST 侧「430 条版本化条目 → 26 个角色」同一机理：PT 按**卡片**计，源按**条目**计）。
本轮**未逐张核对到位**，登记为残留。

---

## 5. 残留（如实登记）

| 编号 | 残留项 | 说明 |
| --- | --- | --- |
| PT-R1 | **chars 计数未逐张对到位**（PT 25 张卡 vs 源 29 个人类名卡片 / 376 条内容寻址条目） | 体积判据（§4.2）与 chats 的两项精确对应（§4.3）都指向「导入了」，但**卡片级一一对照未做**。PT 的卡片记录含 `avatarFile` 字段（可作对照锚点），本轮未展开 |
| PT-R2 | **PT 侧「尽力而为」存储 = 数据可能被浏览器静默清空** | 面板原话见 §2.2。已用量 660.5 MB / 配额 10.6 GB。**建议用户定期用面板的「导出 ZIP」落盘备份**（PT 自带的本地恢复点也在同一个 IndexedDB 里，不构成异地冗余） |
| PT-R3 | **`runs/**` 编排运行记录（20 条）未确认去向** | 属 Luker 的 orchestrator 运行留痕，PT 无对应模块；按 U-3「不删独有」不影响目标侧，但**是否应保留**未裁决 |
| PT-R4 | `pt-automation.cjs --import-pack` 分支**仍是坏路径** | 它点的是「设置项抽屉」而非「打开数据管理」按钮 ⇒ 面板不会打开。**已被 `import-pt.cjs` 取代**；留着是因为它另含 PT 插件安装流程（`--install-plugin`，已走通），本轮未动 |

---

## 6. 复现命令

```bash
# 只读核对（不导入任何数据）：打印 PT 侧模块读数与配额
node scripts/instance-sync/import-pt.cjs --report

# 真导入（策略默认 merge；导入方式默认 slow = 逐文件低内存）
# >100 MB 的包需显式 --allow-large（PT 的 best-effort 存储风险）
node scripts/instance-sync/import-pt.cjs --pack <pack-tt-*.zip> --allow-large --timeout 3600000
```