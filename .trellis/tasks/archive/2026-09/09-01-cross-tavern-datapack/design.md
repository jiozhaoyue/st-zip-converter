# 技术设计:酒馆系数据包互转工具

> 前置阅读:`prd.md`(范围与决策)、`research/platform-facts.md`(全部代码证据)。

## 1. 总体架构

```
┌─────────────┐   ┌──────────────────────────────────────┐   ┌──────────────┐
│ CLI (Node)  │──▶│  转换核心 core/ (纯 JS ESM,无平台依赖) │◀──│ ST/L 插件     │
│ tavern-convert │  │  detect → read → transform → write   │   │ (复用同一份)  │
└─────────────┘   └──────────────────────────────────────┘   └──────────────┘
```

单一核心,两个入口。核心不知道 CLI 和插件的存在;插件打包时把 core 一起 bundle。

**语言选型:JavaScript(ESM)+ Node ≥18,不用 Python。** 决定性理由:ST/L 插件天然是 JS,核心若用 Python 写,插件侧必须第二实现同一套映射规则,必然漂移(用户决策 1 要求两者都要且语义一致)。Node 在 Termux `pkg install nodejs-lts` 即得,满足手机运行;流式 zip 库(yauzl/yazl)纯 JS 无原生编译,满足 AC8。ST 生态本身是 Node,依赖面一致。

## 2. hub 拓扑与模块划分

hub = ST 用户目录布局(摊平)。所有方向 = 源布局规范化到 hub → hub 适配到目标布局。

```
core/
  detect.js      # 识别源布局:st | l | tt | pt-migration(判定规则见 §3)
  read.js        # yauzl 流式读 zip → async entry 迭代器(path, stream, size)
  layout.js      # 路径映射表:各平台目录名 ↔ hub(ST 布局)目录名
  transform.js   # 按 (from, to) 组装条目变换:前缀、manifest、extension-sources、丢弃清单
  write.js       # yazl 流式写 zip;稳定排序(路径字典序)保证产物可复现
  report.js      # 每模块计数 / 跳过 / 丢弃 / 警告;human + json 两种输出
  cli.js         # 参数解析与调用(--to/-o/--keep-all/--dry-run/--json)
```

映射规则的唯一事实源是 `layout.js` 的表 + 各目标的小合成器,方向数增长不产生 O(n²) 代码:

| 关注点 | hub(ST 布局)表示 | 目标适配 |
|---|---|---|
| 用户目录 | zip 根摊平 | ST:原样;L:原样+manifest.json;TT:加 `data/default-user/` 前缀;PT:同 TT + `_tauritavern/extension-sources/` |
| secrets.json | `secrets.json` | 所有目标保留(L 目标受 selection.secrets=true 覆盖,字节不动) |
| extensions | `extensions/third-party/<名>/` | TT/PT:移到 `data/extensions/third-party/<名>/`(TT 实际布局,PT 的 TT 导入器按此路由);L:`extensions/third-party/`(L 后缀匹配可命中 globalExtensions 目标) |
| 扩展来源 | hub 侧记录于 sidecar `_convert/meta.json` | PT 目标:合成 `data/_tauritavern/extension-sources/{scope}/{名}.json`(scope 缺省 global;字段 `host/repo_path/reference/remote_url/installed_commit`,只有 homePage 时 reference/installed_commit 置空串——PT `readExtensionSource` 允许) |
| TT 私有 | `_tauritavern/{extension-store,mcp,skills,window-state}`、`_cache`、`_css`、`_errors`、`content.log` | 目标 ST/L:默认丢弃(`--keep-all` 保留,原样带路径);目标 TT/PT:extension-sources 保留,其余丢弃并在报告列明 |
| L 引擎旁路 | `_engine_dump.bin`/`_engine_meta.json` | 仅当目标也是 L 且 engineKind 相同才有意义;其余目标丢弃+警告(fs→db 跨模式由 L 自身 cross-mode-restore 处理,不需要我们合成 dump) |
| 派生缓存 | `thumbnails/ backups/ vectors/` | 默认丢弃,`--keep-all` 保留(PT 端本就忽略这三个目录) |

**sidecar `_convert/meta.json`**:记录源平台、转换时间、引擎 kind、扩展来源表等。作用是人工检查与二次转换提示,**不是**往返保真机制——L/TT 导入会把它丢弃(research §3/§5),这点在设计上明示,不做虚假承诺。

## 3. 源布局识别(detect.js 判定顺序)

1. 存在 `data/default-user/` 或 `data/_tauritavern/` 条目 → `tt`(PT 的 TT 迁移包同形,归为 `tt`)
2. zip 根有 `manifest.json` 且含 `schemaVersion`+`selection` → `l`
3. zip 根有 `characters/` 或 `settings.json` → `st`
4. zip 根有 `manifest.json` 且含 per-file `moduleId`/`sha256` → PT 原生归档(v1 报"暂不支持",见 PRD Out of Scope)
5. 其余 → 报错并列出根条目辅助诊断

## 4. 各目标包的硬性合规点(来自 research 证据)

- **→L**:条目相对用户目录摊平(L 恢复按路径后缀匹配目标,users-private.js:305-335);manifest.json 写 `{schemaVersion:1, createdAt, handle:"default-user", selection:全true}`,导入端不解析它但保真有益;secrets.json 必须在包内。
- **→TT**:严格 `data/default-user/` 前缀;TT `import/layout.rs` 的 `DataRoot` 策略识别 `data/` 根,`SillyTavernUserRoot` 兜底摊平——我们统一走 DataRoot 形态,不依赖兜底。
- **→PT**:default-user 内层与 ST `USER_DIRECTORY_TEMPLATE` 逐字一致(data-tree.ts 注释);extensions 放 `data/extensions/third-party/`(import.ts:296 路由);extension-sources 每扩展一条 JSON,`remote_url` 必须 https 非空;manifest 必含 `display_name` 与 `js/css` 之一,不满足的扩展按 PT 同款警告列入报告(与 PT 行为对齐,静默丢字节是反目标)。
- **→ST**:摊平原样;附 `_convert/INSTALL.md` 说明手动铺到 `data/<handle>/` 与 secrets 位置。ST 无导入端点是平台限制,报告里也提示一遍。

## 5. 流式与大包(AC7)

- 读:yauzl `lazyEntries` 逐条目;写:yazl `addReadStreamLazy` **惰性流直通**——泵到该条目时才打开源流,yazl 严格顺序泵保证同一时刻只有一条 yauzl 读流,内存与条目大小无关(实测 964 MiB 包峰值 ~233 MiB)。
- 实现教训(2026-09-02):初版"逐条目 read 成 Buffer 再 addBuffer"在真实 2 GiB 解压量下峰值 884 MiB——根因不是磁盘背压,而是 yazl addBuffer 的异步 `deflateRaw` 请求在 zlib 线程池上无限积压,每条待压缩 buffer 都滞留。惰性流直通后 yazl 自己的管道背压生效,问题消失。
- 只有元数据小文件(manifest/来源记录/扩展 manifest)读入 Buffer;合成条目为小 JSON。
- 顺序稳定:输出条目保持**源条目顺序**(实现修订:设计初稿的"按目标路径字典序"要求全包驻留内存排序,与 AC7 冲突,已放弃;同输入同输出由源顺序保证),合成条目按名排序追加尾部。压缩字节随 zlib 版本浮动,不做跨机器字节级承诺。

## 6. 测试策略

1. **合成固件**(进 git):脚本生成四个迷你包(各含 2 角色卡/1 聊天/1 世界书/settings/secrets/1 扩展),覆盖全部方向的往返断言:条目集合、字节恒等(secrets/角色卡)、manifest 字段、extension-sources 内容。
2. **镜像测试**(不依赖平台运行):把 L 的后缀匹配逻辑(users-private.js:305-335)和 PT 的路由规则(tauri-tavern-import.ts:280-330、readExtensionSource)抽成测试断言,对产物 zip 逐条目验证"目标平台会把它路由到预期位置/类目"。平台代码升级时只改这份镜像。
3. **真实包集成**(不进 git):工作区两个真实 zip 跑全矩阵 `--dry-run` + 实转,校验报告计数与 AC7 内存。CI 之外本地跑。
4. **TT 布局识别**(可选加分):`cargo test -p tt-adapter-archive` 现成用例,人工核对布局策略对产物的判定。
5. **插件**:Dev 实例 UI 加载冒烟 + 导出产物与 CLI 产物 diff 为空。

## 7. 插件设计(ST / L)

- 形态:ST UI 扩展(第三方扩展标准结构,`manifest.json` + `index.js`,JSZip 在浏览器端打包)。L 兼容 ST 扩展生态,同一份插件代码双端安装验证。
- 数据获取:浏览器侧无法直接读服务端用户目录,走平台既有备份端点拉取(与 UI"备份"按钮同源),拿到 zip Blob 后调用 core 做布局变换,再触发下载。
  - 已知风险:ST 的 `createBackupArchive` 是服务端流式接口,前端可 fetch;L 同构。该路径拿到的 ST 包缺 secrets.json(平台默认排除)——插件端对 ST 源追加调用 settings/secrets 既有端点补齐,或提示用户用 CLI 处理 secrets(报告里明示)。此细节在实现期核实,若端点不可达,插件降级:仅生成 hub 包,secrets 交给 CLI/手动。
- 打包:esbuild 把 core 打进扩展单文件;CLI 与插件版本号同锁,发布一起出。

## 8. 仓库布局(本工作区)

```
luker-tt-datatran/
  cli.js  package.json  README.md
  src/core/...          # 上述 core 模块
  src/plugins/st/...    # ST/L 共用扩展源码
  fixtures/             # 合成迷你包生成脚本与产物
  test/                 # 单测 + 镜像测试
  samples/              # 真实包路径引用(gitignore,不入库)
```

两个真实 zip 已在工作区根,保持原地,gitignore 掉;工具直接相对引用。

## 9. 风险与开放点

| 风险 | 处置 |
|---|---|
| ST 前端拿不到 secrets(备份端点默认排除) | §7 的补齐/降级方案;CLI 路径无此问题(直接读文件) |
| L selection 的 assets/extensions 类目目录清单随版本变化 | 镜像测试以 Dev/Luker 当前代码为准;版本差异在 README 标明支持范围 |
| PT capability 未加载时扩展仍被整段跳过(其内部状态,转换器无法控) | 报告提示"若 PT 未启用扩展特性,扩展不会被导入";AC5 由用户手动确认兜底 |
| Termux 上 1 GiB 级包的存储余量 | 文档提示预留 2.5× 空间;`--dry-run` 先行 |
| zip64(964 MiB 包可能触发) | yauzl/yazl 均支持 zip64;集成测试覆盖 |

## 10. 回滚

纯新增仓库,不触碰实例与平台代码;按 implement.md 阶段提交,任一阶段回滚 = git revert 对应提交。
