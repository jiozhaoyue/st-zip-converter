# Error Handling Guidelines (Core & CLI)

> Error classification, exit codes, report warnings, and stream teardown.

---

## Overview

`tavern-convert` differentiates between **fatal errors** (which abort the pipeline and yield non-zero exit codes) and **conversion warnings** (which are collected into the conversion `Report` without stopping progress).

---

## Error Classification & Exit Codes

| Exit Code | Condition | Behavior / Output |
|:---:|---|---|
| `0` | Successful execution or `--help` | Outputs human summary or JSON report to `stdout`. |
| `1` | Conversion or Runtime Error | Writes failure message and stack trace to `stderr`. |
| `2` | CLI Usage / Argument Error | Writes syntax error message followed by USAGE guide to `stderr`. |

### 1. Usage Errors (Exit Code 2)
Handled via `failUsage(message)`:
```javascript
function failUsage(message) {
  process.stderr.write(`错误: ${message}\n\n${USAGE}`);
  process.exit(2);
}
```
Triggered when:
- Unknown or missing `--to` target platform.
- Missing input path or invalid arguments in `detect` subcommand.

### 2. Fatal Conversion Errors (Exit Code 1)
Pipeline will throw an `Error`:
- Input file does not exist or is unreadable.
- Corrupted zip archive / invalid Central Directory signature.
- Attempting to convert from an unsupported source layout (e.g. PureTavern's native archive format `pt-archive` which uses per-file SHA256 hashes instead of Tavern directories).
- Write failure (e.g. read-only filesystem or full disk).

---

## Non-Fatal Warnings & Report Aggregation

Not all anomalies should abort conversion. Many platform differences (like extension format mismatches) are resolved via conversion policies and tracked in the `Report`:

```javascript
// Collecting non-fatal anomalies into the report
report.warn(`用户级扩展 ${name} 无清单且无来源记录,已合成基础来源(homePage 兜底)`);
report.recordDiscard(entryName, 'PT 目标丢弃用户级私有缓存');
```

- **Report Output**: Warnings and discards are listed in the final report (capped in preview, fully preserved in JSON).
- **Graceful Fallbacks**:
  - Missing extension source metadata in PT target: synthesize fallback `extension-sources/<name>.json` with a placeholder URL (`https://github.com/unknown/<name>`) and add a warning.
  - Conflicting third-party extension names: keep the third-party version, drop the duplicate user-level extension, and record the action.

---

## Stream Cleanup & Resource Teardown

1. **Deterministic Reader Closure**: Always ensure `reader.close()` is called to close underlying file descriptors or release buffer memory.
2. **Aborted Writers**: If an error occurs midway through writing:
   - Close the output stream.
   - Do not leave corrupted partial archives without alerting the user.
3. **Promise Rejections**: The CLI main entrypoint catches uncaught promise rejections:
   ```javascript
   main().catch((error) => {
     process.stderr.write(`转换失败: ${error?.stack ?? error}\n`);
     process.exit(1);
   });
   ```
