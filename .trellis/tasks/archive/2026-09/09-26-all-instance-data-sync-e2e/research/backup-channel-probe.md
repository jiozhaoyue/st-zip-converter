# 备份通道探针读数（`implement.md` 1.4）

> 日期：2026-09-26 ｜ 目标：Real Luker `:8004` ｜ Playwright 1.62.1（本机全局，未新装）
> 脚本：`scripts/instance-sync/probe-backup-channel.cjs`
> 方法：**在页面上下文发请求**（cookie 同源自带），读到响应头 + **首块**后立即 `abort()`，
> **不下载全量**。

## 原始读数

```json
{
  "status": 200,
  "content-disposition": "attachment; filename=\"default-user-20260926-010000.zip\"",
  "content-type": "application/zip",
  "transfer-encoding": "chunked",
  "x-response-time": "23.194ms",
  "firstChunkBytes": 43,
  "hexHead": "50 4b 03 04",
  "asciiHead": "PK\u0003\u0004",
  "isZipMagic": true,
  "elapsedMs": 82
}
```

## 结论

| 判定项 | 结果 |
| --- | --- |
| 端点可用 | ✅ `200`，无需额外配置（`backups.allowFullDataBackup` 未被关闭） |
| 返回确为 zip | ✅ 首 4 字节 `50 4b 03 04` = `PK\x03\x04` |
| 服务端响应快 | ✅ `x-response-time` 23 ms（首块 82 ms 内到达） |
| **有 `content-length` 吗** | ❌ **没有** —— `transfer-encoding: chunked` |
| 会话/CSRF | ✅ `.pw-profile` 登录态有效（`handle=default-user`），`GET /csrf-token` 可取令牌 |
| 文件名模式 | `default-user-YYYYMMDD-HHMMSS.zip`（服务端本地时间） |

## 对导出实现的决定性影响

**没有 `content-length` ⇒ 不能先分配再下载，必须真流式。** 三条候选：

| 方案 | 评估 |
| --- | --- |
| (a) 页面内 `fetch` → `page.exposeBinding` 逐块回传 Node 写盘 | ⚠️ 3.8 G 逐块跨进程序列化（base64/structured clone）开销大、易成瓶颈 |
| **(b) 取 cookie + CSRF → Node 侧 `https.request` 流式落盘** | ✅ **采用**：`context.cookies()` 取会话，`/csrf-token` 取令牌，`rejectUnauthorized:false` + `Cookie`/`X-CSRF-Token` 头，`pipe(fs.createWriteStream)`。不经浏览器内存，无序列化开销 |
| (c) 触发宿主 UI 的导出按钮 + Playwright `download` 事件 | ⚠️ 走浏览器下载管线，3.8 G 级不稳（K-1）；且依赖 UI 选择器，脆 |

**采用 (b)**，实现在 `scripts/instance-sync/export-backups.cjs`。

## 附：探针未造成副作用

`abort()` 发生在 43 字节处，服务端会收到连接中断；**没有产生下载文件**，
**没有写入任何实例目录**，`data/default-user/` 全程只读（符合 I-1）。
