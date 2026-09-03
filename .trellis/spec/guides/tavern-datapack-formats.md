# 酒馆系数据包格式与互转(跨任务知识)

> 来源:09-01-cross-tavern-datapack 任务的读码调研(全部结论有 file:line 证据,见任务
> research/platform-facts.md)。做任何涉及四平台数据搬移的后续任务,先读本文件再动手。

## 包布局速查

- **ST**:zip 根摊平 ST 用户目录,无 manifest;官方备份默认排除 secrets.json。
- **L**:同 ST 摊平 + `manifest.json` `{schemaVersion:1, createdAt, handle, selection}`(src/users.js:1496)。
- **TT**:`data/` 根,用户数据在 `data/default-user/`,TT 私有在 `data/_tauritavern/`(extension-sources/mcp/skills/window-state)+ `data/_cache _css _errors`。
- **PT**:自家归档(per-file moduleId/sha256 清单)或 TT 布局;**摊平布局整包不可见**(readUserPath 返回 null)。

## 导入语义(最易踩的坑)

1. **L 恢复不解析包内 manifest.json**(users-private.js:311 显式跳过),selection 来自恢复请求;条目按"路径后缀"匹配目标目录 → 未知文件安全跳过,`data/default-user/` 前缀的包也能直接吃(这就是 tt→l 能通的原因)。
2. **L 备份类目映射**(users.js getUserBackupTargets:1363):settings 类目含 `backups/` 目录;assets 含 `user/files|images|workflows`;`extensions/`(用户级)属于 selection.extensions;`image-metadata.json` 不在任何类目 → L 备份天然不含它。
3. **PT 目录表没有 `extensions/`**(tauri-tavern data-tree.ts):default-user/extensions/** 会被 PT 丢弃;第三方扩展只认 `data/extensions/third-party/<name>/` 且必须有来源记录(extension-sources 或 manifest homePage,须 https),否则跳过并警告 —— 这是设计(重装式迁移),不是 bug。
4. **PT 的 wasm/流式细节**:zip.js v2.9 wasm 以 base64 内联,可整体 esbuild 打包;ZipReader 必须显式包 BlobReader。

## 转换工具的既有约定(本仓库)

- hub 布局 = ST 摊平;`data/default-user/` 前缀进出;TT 私有/派生默认丢弃(`--keep-all` 保留)。
- PT 目标:用户级 `extensions/<name>/` 自动迁移为 third-party 布局 + 合成来源记录(homePage 兜底),同名冲突保留第三方副本;third-party 根下散文件丢弃。
- L 目标:`image-metadata.json` 丢弃(L 类目不含);`_engine_dump.bin/_engine_meta.json` 仅 L→L 透传。
- IO 适配器注入:node-io(yauzl/yazl)与 zipjs-io(zip.js)必须产物同构(test/zipjs-io.test.js 逐条目 MD5 把关)。
- secrets 任何方向不剥离(用户硬性要求),产物含 API 密钥属预期。

## 环境教训

- 本机(开发机)无 MSVC 链接器(VS2022 目录为空),`cargo test` 无法链接——TT 的 Rust 侧
  (Real/TauriTavern/src-tauri/crates,含 tt-adapter-archive 的 import/layout.rs)验证只能靠
  往返 CRC 测试或实机导入;只查 `--version` 不代表工具链可用。
- yauzl 中央目录游标不可倒回:一次遍历只能消费一次,检测与主循环必须分别 open。
- yazl addBuffer 的异步 deflateRaw 请求会在 zlib 线程池无限积压(峰值 884MiB 教训),
  大包必须用 addReadStreamLazy 惰性流直通。
