# Authority 云端传输设计草案

## 现状与痛点

- `putArtifact()`：blob → `arrayBuffer()` 全量入内存 → 4MB 分块 → base64 → `storage.blob.put` 逐块。大文件内存峰值 = 全量字节 + base64 字符串，云端还要 +33% 网络体积。
- `getArtifact()`：逐块取回再合并，同样全量入内存。

## 目标路径

```
putArtifact v2: Blob.stream() → transfer/init → append(流式块) → storage/blob/commit-transfer
getArtifact v2: storage/blob/open-read → mode=transfer 时流式读取
```

回退：老版 Authority 无 transfer 时保持现有 base64 分块。

## 探测与降级

- `session.init` 返回的 `limits` / `features` 决定是否启用 transfer 路径。
- 任何一步失败 → 回退 base64 路径 → 再失败 → 仅告警（镜像语义不变）。

## 研究前置

OQ-1：确认 SDK 侧 transfer 调用形状（Authority 官方文档 `http-api.md` §6.2 与 SDK client 文档）。
