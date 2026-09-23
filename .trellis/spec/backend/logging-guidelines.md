# Logging & Output Guidelines（日志、报告与脱敏）

> 结构化 logger、转换报告、输出通道约定与密钥脱敏。

---

## Overview

本项目**没有 CLI，也没有 `stdout` / `stderr` 通道**。日志与结果分为两个机制：

1. `src/core/logger.js` —— **结构化实时日志**（运行诊断，进日志抽屉 + 控制台镜像）。
2. `src/core/report.js` 的 `Report` —— **转换结果账本**（每个条目去了哪里，进报告面板）。

---

## 1. 结构化日志：`src/core/logger.js`

- 单例 `logger`，级别集合 `LOG_LEVELS = INFO | WARN | ERROR | SUCCESS`；方法 `logger.info / warn / error / success`。
- **环形内存缓冲**：最多 `MAX_LOG_ENTRIES = 1000` 条，超出后丢弃最旧的。
- **订阅机制**：`subscribers` 集合，供 `src/ui/log-console.js` 实时渲染；`logger.subscribe(fn)` 返回取消订阅函数。订阅者抛错会被捕获并记 `Logger subscriber error:`，不影响主流程。
- **控制台镜像**：按级别调用 `console.error` / `console.warn` / `console.log`，前缀 `[st-zip-converter][HH:MM:SS.mmm][LEVEL]`。
  - 因此**“core 必须完全静默”是过时说法**：`src/core/` 中确实存在控制台输出，但**仅**出自 `logger.js`（其他核心模块只能经 `logger.*` 输出）。核心模块**不得**自行裸调 `console.*`。
- 条目结构：`{ id, level, message, detail, timestamp, timeMs }`；支持文本导出。

---

## 2. 转换报告：`src/core/report.js`

`Report` 是条目归置的账本（不是日志）：

- **模块计数（`MODULES`）**：`settings | secrets | characters | chats | lorebooks | presets | assets | extensions | meta | derived | other`；hub 路径 → 模块名的映射见 `classifyModule()`。
- **记账方法**：`copied()` / `dropped()` / `filtered()` / `synthesized()` / `resumed()` / `warn()`；模块桶字段为 `{ copied, dropped, synthesized, filtered, bytes }`（`resumed` 命中时追加）。
- **账本明细**：`dropped`（含 reason）、`filtered`（含 category）、`synthesized`、`resumed`、`warnings`，另有 Store 直存统计 `storeBypass = { count, bytes }`（经 `setStoreBypass()` 写入）。
- **出口**：`toJSON()`（结构化）与 `toHuman()`（文本表）。

### `toHuman()` 输出结构（逐行取自 `report.js`）

```
转换报告: <sourceLayout> -> <target>
模块            复制   丢弃   合成   字节
<模块名.padEnd(14)> <copied> <dropped> <synthesized> <bytes>
合计            <totals.copied> <totals.dropped> <totals.synthesized>
丢弃清单 (<n>):
  - <path>  [<reason>]
警告 (<n>):
  ! <warning>
```

（丢弃清单与警告清单为空时这两段不输出。）

### `toJSON()` 顶层字段（字段名固定，值为示意）

```json
{
  "sourceLayout": "st",
  "target": "pt",
  "modules": { "assets": { "copied": 0, "dropped": 0, "synthesized": 0, "filtered": 0, "bytes": 0 } },
  "dropped": [{ "path": "thumbnails/avatar.png", "reason": "派生缓存默认丢弃" }],
  "filtered": [{ "path": "secrets.json", "category": "secrets" }],
  "synthesized": ["_convert/INSTALL.md"],
  "warnings": [],
  "resumed": [],
  "storeBypass": { "count": 0, "bytes": 0 },
  "totals": { "copied": 0, "dropped": 0, "filtered": 0, "synthesized": 0, "resumed": 0, "warnings": 0 }
}
```

---

## Security & Secrets Redaction

- **永不输出密钥内容**：`secrets.json` 含有效的 OpenAI / Claude / NovelAI / AWS 等密钥。
- **硬规则**：日志与报告只允许出现该文件的**存在性/计数**（如 `secrets` 模块计数），不得检查、序列化或回显任何密钥字符串。
- 反向同样成立：转换产物中必须**字节级保留** `secrets.json`（唯一例外是用户主动取消勾选该类目，见 `database-guidelines.md`）。

---

## 禁止事项

- ❌ 在 `src/ui/**` 或 `src/core/**` 中裸调 `console.log` 做业务日志（除 `logger.js` 自身的控制台镜像）——用户看不到控制台，诊断信息必须进日志抽屉。
- ❌ 把用户可控文本（文件名、扩展名、宿主响应）拼进日志后直接注入 DOM（必须经 `escapeHtml()`，由 `npm run check:dom-injection` 强制）。
- ❌ 在报告中记录密钥值、完整聊天正文等敏感内容。
