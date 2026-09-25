# Real Luker 原生数据包导出读数（`implement.md` 1.5–1.7 → AC-1）

> 日期：2026-09-26 ｜ 脚本：`scripts/instance-sync/export-backups.cjs`
> 通道依据：`research/backup-channel-probe.md`（探针实测 `chunked`、无 `content-length` ⇒ 必须真流式）

## 导出结果

| 项 | 值 |
| --- | --- |
| 实例 | `real-luker`（`:8004`） |
| 产物 | `C:\Users\caocaobi\Downloads\backup-real-luker-20260926-010422.zip` |
| 记录 | `C:\Users\caocaobi\Downloads\backup-real-luker-20260926-010422.json` |
| 压缩后体积 | **1602.7 MB** |
| **未压缩总计** | **3840.6 MB** |
| 条目数 | **8683** |
| 耗时 | **247.1 s** |
| sha256 | `cbf2e63c4efc6e039f9975e5381a28f81b38c3e1c2fa...`（全值见 `.json` 记录） |
| 服务端提供的文件名 | `default-user-20260926-010422.zip` |

## 完整性核对（**不是靠「体积看着差不多」**）

对源目录 `Instance/Real/Luker/data/default-user` 的只读清单快照读数
（`pre-sync-manifest-real-luker.json`）：**7986 个文件 / 3731.3 MB**。

| 对照项 | 读数 | 判定 |
| --- | --- | --- |
| 未压缩总量 | 包 3840.6 MB vs 快照 3731.3 MB | ✅ 同量级（差值为 `du`/`stat` 取整 + 快照跳过了 `_cache`/`_webpack`/`_errors`/`node_modules`/`.git`） |
| 条目数 | 包 8683 vs 快照 7986 | ✅ 包更多 697 条 —— 快照**故意跳过 `.git` 与缓存目录**，包则全部收录 |
| 一级构成 | 见下表 | ✅ 与源目录逐项对得上 |

包内一级目录构成（未压缩）：

| 一级条目 | 条目数 | 未压缩 |
| --- | --- | --- |
| `backups/` | 111 | **2479.5 MB** |
| `chats/` | 1029 | 667.4 MB |
| `extensions/` | 6597 | 341.5 MB |
| `user/` | 191 | 152.8 MB |
| `characters/` | 430 | 107.9 MB |
| `OpenAI Settings/` | 76 | 36.8 MB |
| （根文件） | 3 | 21.8 MB |
| `worlds/` | 21 | 21.1 MB |
| `backgrounds/` | 23 | 11.2 MB |
| 其余 8 类 | — | <1 MB |

⇒ **AC-1 达成**：包存在、命名可辨识实例与日期、附 `bytes/entryCount/sha256` 记录、量级与源一致。

## 一个必须记下的现象：导出速率会「塌方」

| 阶段 | 速率 |
| --- | --- |
| 前 ~880 MB（`chats/` `characters/` 等活数据） | ≈ **7 MB/s** |
| 进入 `backups/` 之后 | ≈ **0.9 MB/s**（降到 1/8） |

原因：`backups/` 是 111 个**已经 deflate 过**的历史备份包（2479.5 MB），
服务端仍在按设置再压一遍 —— 对已压缩数据做 deflate 是纯 CPU 消耗且几乎不减小体积。
**这是 K-1 的实测形态**，不是故障。

> 对后续的影响：若还要重复导出，`backups/` 是唯一的时间黑洞。
> 但用户要求的是**原生全量备份**（安全性优先），故本次不做裁剪；
> 而**同步**侧已按 U-4 把它排除（见 `pack-build-readings.md`），同步载荷不含这块。

## 纪律核对

- 全程对实例**只读**：只调 `POST /api/users/backup` 这一个读端点；`Instance/**` 未被写入（I-1 / I-5）。
- 产物先写 `backup-real-luker.partial`，成功后才 `rename` 为终名 ——
  **中断不会留下「看着像完整包」的半截文件**。
- 浏览器只用于**取会话**（cookie + `/csrf-token`），字节由 Node 侧 https 流式接收直写磁盘，不经浏览器内存。
