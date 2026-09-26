# 阶段 3 阻塞：Luker `restore-backup` 返回 HTTP 500（成因待服务端日志）

> 日期：2026-09-26 ｜ 发现于 `implement.md` 3.3 首次实跑
> 状态：**阻塞中** ｜ 影响：阶段 3 的 Luker 目标（Dev Luker `:8003` / Real Luker `:8004`）无法推进

## 现象

用 `scripts/instance-sync/restore-luker.cjs` 对 **Dev Luker `:8003`** 做整包恢复：

```
会话就绪：cookie 2 个、CSRF 已取（playwright 1.62.1）
[restore] 上传 619.3 MB（100%）
[restore] HTTP 500
[restore] 响应：<!DOCTYPE html>…<pre>Internal Server Error</pre>
```

- **上传本身完成**（进度打到 100%），响应是 Express 的**默认错误页**（非 JSON）⇒
  错误发生在路由处理内部未被捕获为「带 JSON 体的业务错误」，而是冒到了 Express 的错误处理器。
- **`/restore-backup/probe` 同样 500** ⇒ 不是某一个端点的问题。

**未被写入的证据**：同步前后未观察到目标目录变化；且 500 出现在
`restoreUserBackupArchive` 内部的 `analyzeRestoreArchive` 前后，属**写入之前**的阶段
（见下方已排除项与源码行号）。⚠️ 但**未逐字节核对**目标目录，故不能断言「绝对未写入」。

## 已逐项**实测排除**的原因

| 假设 | 实验 | 结论 |
| --- | --- | --- |
| 包不是合法 zip | Luker 自带的 **yauzl** 打开我们的包 → `END_OK entries=7750` | ❌ 排除 |
| 包与 yauzl 的**读取**不兼容（如 data descriptor / zip64） | 用 yauzl **逐条 `openReadStream` 并读内容** → **12/12 成功，字节数逐条与声明的 `uncompressedSize` 完全相等** | ❌ 排除 |
| 包内有 zstd(Method 93) 条目而 Luker 不支持 | 扫描 `compressionMethod` 分布：产包 **deflate 8 × 7553 + store 0 × 197**；源包 **deflate 8 × 8683** —— **零 zstd** | ❌ 排除 |
| 条目名非法（绝对路径 / `..` / 控制字符 / 超长） | 全量扫描 7750 条：**可疑 0 条**，最长名 146 字符，非 ASCII 1282 条（均为正常中文路径） | ❌ 排除 |
| multer 的文件大小上限 | `src/server-main.js:607` 只设了 `limits: { fieldSize: 500 * 1024 * 1024 }` —— 那是**文本字段**上限；`fileSize` **未设**（无限制） | ❌ 排除 |
| `multerMonkeyPatch` 改坏文件名 | `src/middleware/multerMonkeyPatch.js` 全文只有「latin1→utf8 解码 `originalname`」，且有 try/catch 兜底 | ❌ 排除 |
| 只怪 probe 端点 | `POST /restore-backup` 主路径**同样 500** | ❌ 排除 |
| 缺少 `_engine_meta.json` 导致不被接受 | `users-private.js:636-638` 注释明确：**legacy fs-only 包（无该文件）在 fs 引擎服务器上正常解包**；且我们**没有走 probe**（`--skip-probe`），主路径**不调用** `readEngineMetaFromZip`（该函数只在 `:1197` probe 里用） | ❌ 排除 |
| selection 键名写错导致「至少选一个类目」 | 键名**逐字取自** `src/users.js:83` 的 `USER_BACKUP_SELECTION_DEFAULTS`（settings/secrets/characters/chats/lorebooks/presets/assets/extensions/globalExtensions/vectors），全 true | ❌ 排除 |

> 附带发现（**与本次 500 无关，但记下**）：`/restore-backup/probe` 对**不含 `_engine_meta.json`** 的包
> 会**挂住** —— `readEngineMetaFromZip`（`:1145`）用 yauzl `lazyEntries` 遍历，但**没有处理
> zipfile 的 `end` 事件**，遍历完所有条目后 promise 既不 resolve 也不 reject（其内部的
> `if (!meta)` 分支因此**永远到不了**）。所以 probe 端点对 legacy fs-only 包不可用 ——
> **但这解释不了 500**（我们已用 `--skip-probe` 绕开，且实测主路径**不调用**该函数）。

## 缺口：**服务端错误日志**

`POST /restore-backup` 的 catch 会 `console.error` 出真实堆栈
（`users-private.js:1300` 之后的 catch 块），但 **Dev Luker 是外部进程启动的**
（`start-instance.cjs` 报「端口 8003 已在监听 —— 不重复启动」），
其 stdout **不在** `test-results/instance-logs/` 下，本会话**拿不到**。

⇒ **要定位这个 500，必须拿到那份日志。**

## 可选的下一步（待用户裁决）

| 方案 | 说明 | 代价 / 风险 |
| --- | --- | --- |
| **A. 用户查看终端窗口** | 那个外部启动 Dev Luker 的终端里应有 `Restore failed …` 堆栈 | 零风险；需要用户在场看一眼 |
| **B. 允许我停掉外部 Dev Luker，由我重启并捕获日志** | 重启后日志落 `test-results/instance-logs/dev-luker.log`，即可自动定位 | 偏离 AC-11（「不得关闭非本次启动的实例」）；会打断用户可能在用的环境 |
| **C. 改用 Real Luker `:8004` 诊断** | 它有 S0 完整备份，出问题可 `mode=overwrite` 回滚 | 若 500 发生在**部分写入之后**，真实数据会被部分改动；且 E2E 纪律上 Real 属红线区 |
| **D. 降级为「产包 + 人工说明」** | 与 TT 同形态交付，Luker 侧由用户手动恢复 | 阶段 3 的自动同步目标落空，登记为残留 |

## 本轮已就绪的部分（与该阻塞无关，可复用）

- `scripts/instance-sync/restore-luker.cjs` —— 流式 multipart 上传（**整包不进内存**），
  支持 `--probe-only` / `--skip-probe` / `--mode` / `--selection`
- `scripts/instance-sync/lib/instance-session.cjs` —— 会话获取共享模块
  （`export-backups.cjs` 已改为共用，消灭了重复实现）
- `scripts/instance-sync/diff-report.cjs` 新增 `--pre-manifest`：
  以「同步前全量清单 ⊆ 同步后清单」判**零删除** —— 比只看「目标独有」更强，
  且**无需先算出独有子集**
- `scripts/instance-sync/snapshot-manifest.cjs` 新增 `--out`：可临拍快照而不覆盖既有基线

## 一份**已取得的有效读数**：同步前基线（3.2 的空转对照）

对 Dev Luker 跑 `diff-report`（同步**前**）：

```
[dev-luker] T1 包→目标覆盖率 37.458%（2903/7750，缺 4847） ❌
[dev-luker] T2b 同步前全量清单 3238 条 → 现存 3095 条 / 被删 143 条 ❌
[dev-luker] T3 包内 角色卡 430 / 聊天 1029 / 世界书 21　目标 角色卡 73 / 聊天 818 / 世界书 14
```

⇒ **T1 正确报出「目标缺什么」，退出码 1** —— 这正是 3.2 要的「先证明判定会报差异」。

⚠️ **T2b 的 143 条「被删」需要正确解读**：它比较的是 **1:04 拍的那份旧基线**与现在，
而**我尚未做任何同步** ⇒ 这 143 条是**实例自身在这段时间内的变动**
（样本为 `backgrounds/test-animation_*.html` 这类临时件），**与同步无关**。
**教训**：T2b 必须用**同步前临拍**的快照做基线（本次已改用 `snapshot-manifest.cjs --out` 临拍
`t2-pre-dev-luker.json`），否则会被环境的自然变动污染成假告警。
