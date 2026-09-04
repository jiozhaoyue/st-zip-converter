# Logging & Output Guidelines (Core & CLI)

> Structured reporting, CLI output channels, silence in core, and secret redaction.

---

## Overview

`tavern-convert` adheres to standard Unix command-line conventions and library design:
1. **Core is Silent**: Code under `src/core/` and `src/io/` MUST NOT call `console.log` or write directly to standard I/O streams. All telemetry and diagnostic information are accumulated into a `Report` object.
2. **Channel Separation**:
   - `stdout`: Machine-readable JSON (with `--json`) or formatted human reports.
   - `stderr`: CLI errors, usage hints, or fatal execution exceptions.

---

## The `Report` Abstraction

`src/core/report.js` serves as the centralized logging and event collector:
- **Module Counters**: Tracks counts for `characters`, `chats`, `lorebooks`, `presets`, `assets`, `extensions`, `settings`, `secrets`.
- **Discard Ledger**: Records any file omitted along with the specific reason (e.g. `PT 不支持用户级 extensions`).
- **Warnings List**: Captures anomalies that required fallback synthesis or heuristic repairs.

### 1. Human-Readable Mode (Default)
```
tavern-convert default-user.zip --to pt
==================================================
转换完成: ST -> PT (共 420 个条目)
--------------------------------------------------
角色: 12  | 聊天: 35  | 世界书: 4  | 预设: 8
资产: 150 | 扩展: 3   | 设置: 2    | 密钥: 1 (保留)
丢弃: 18 个条目 (缓存/派生数据, 用 --keep-all 保留)
警告: 1 条
耗时 1.2s, 峰值内存 112 MiB, 输出: out/default-user-pt.zip
```

### 2. Machine-Readable Mode (`--json`)
Emits a single clean JSON document to `stdout`:
```json
{
  "sourceLayout": "st",
  "target": "pt",
  "stats": {
    "elapsedMs": 1240,
    "peakRssBytes": 117440512,
    "outputFile": "out/default-user-pt.zip",
    "dryRun": false
  },
  "modules": {
    "characters": 12,
    "chats": 35,
    "lorebooks": 4,
    "presets": 8,
    "assets": 150,
    "extensions": 3,
    "settings": 2,
    "secrets": 1
  },
  "discards": [
    { "path": "thumbnails/avatar.png", "reason": "派生缓存默认丢弃" }
  ],
  "warnings": [
    "用户级扩展 my-ext 无清单且无来源记录,已合成基础来源"
  ]
}
```

---

## Security & Secrets Redaction

- **Never Print Key Values**: `secrets.json` contains active OpenAI, Claude, NovelAI, or AWS keys.
- **Strict Rule**: Logs and reports MUST only display file existence (`secrets: 1 (保留)`) or count of keys. Never inspect, serialize, or echo token strings into logs or JSON reports.
