# 执行计划:酒馆系数据包互转工具

> 每阶段一个 git 提交,可独立回滚;验证命令必须通过才进下一阶段。

## Phase A:骨架 + 流式 IO ✅(2026-09-02,提交 34f44f5)

- [x] A1 `package.json`(type:module,engines node>=18,依赖 yauzl/yazl + 测试框架 vitest),gitignore(样本 zip、node_modules)
- [x] A2 `src/core/read.js` + `write.js`:yauzl 流式读迭代器 / yazl 流式写;单测:小包读写往返字节恒等
- [x] A3 `src/core/detect.js`:四布局判定(含 PT 原生归档的"不支持"分支);单测覆盖每个分支
- [x] A4 `fixtures/gen.js` 生成四个平台迷你包(prd R2 内容集),产物入库
- 验证:`npm test` ✓;对两个真实 zip detect:l 442ms / tt 50ms ✓

## Phase B:映射与转换 ✅(2026-09-02,提交 a38a226)

- [x] B1 `transform.js`:源路由 + 四目标适配(前缀、manifest 合成、extension-sources 合成、丢弃规则、--keep-all)
- [x] B2-B5 各目标单测 + B6 `report.js`(模块计数/丢弃清单/警告,human+json)
- 验证:26 测试全绿 ✓(fix:检测遍历与主循环分两次开 zip——yauzl 中央目录游标不可倒回)

## Phase C:真实包集成 + CLI ✅(2026-09-02,提交 7e1df02)

- [x] C1 `cli.js`:detect 子命令、--to/-o/--keep-all/--dry-run/--json、退出码
- [x] C2 真实包 8 方向 dry-run + 实转全过;AC7 内存:初版 884MiB 超标,根因是 yazl addBuffer
      异步 deflateRaw 请求积压,改 addReadStreamLazy 惰性流直通后 **74-250MiB** ✓
- [x] C3 AC6:8 产物 secrets 字节与各自源包一致(verify-secrets.mjs),条目数与报告吻合 ✓
- 附加:D1 PT/L 路由镜像测试(mirror.test.js,AC5 结构部分 + AC3)✓

## Phase D:PT/TT 合规复核(自动化部分完成)

- [x] D1 镜像测试入 test/mirror.test.js
- [x] D2 代理:真实产物逐条目过 L/PT 真实路由规则(test/real-samples.test.js);
      往返 CRC 完整性(test/roundtrip.test.js:l→st→l、tt→pt→tt 全条目一致)。
      剩余人工项:把 out/real-l-to-pt.zip 在 PT 里实机导入一次,确认角色/聊天/扩展可见(AC5 终验)
- [x] D3 结论:本机无 MSVC 链接器(VS2022 目录空),cargo test 不可行——上一会话
      "工具链全齐"结论只查了版本号,有误;TT 侧由往返 CRC + 实机导入覆盖;
      tt-adapter-archive 的 layout.rs 在 Real/TauriTavern/src-tauri/crates(Dev 检出无 Rust 侧)

## Phase E:插件 ✅(2026-09-03,提交 e3bd76a;平台内 UI 冒烟待人工)

- [x] E0 convert/detect 拆为纯核心 + IO 适配器注入(node-io / zipjs-io,同契约);
      核心去 Buffer 化;zip.js 适配器与 CLI 产物逐条目 MD5 同构(test/zipjs-io.test.js,AC9 自动化)
- [x] E1 已核实:L `POST /api/users/backup` selection 含 secrets(users-private.js:1061);
      ST 端点无 selection 默认排除 secrets(users.js:1148)→ 插件内做 ST secrets 提示
- [x] E2 插件构建:src/plugins/plugin.js 共享逻辑 + esbuild define 平台标识,
      dist/plugins/{st,luker}/{index.js,manifest.json}(自包含 IIFE ~158KB,zip.js wasm 内联)
- [x] E3 AC9 自动化部分:插件路径产物与 CLI 产物逐条目 MD5 一致;plugin.test 冒烟
      (无 DOM 求值、平台标识、manifest 规范)。剩余人工项:Dev 实例加载插件实机导出一次
- [x] E4 README:安装、Termux 用法、插件安装与 ST secrets 说明、安全提示
- [x] AC8:test/termux.test.js(生产依赖闭包无原生模块 + 192MiB 堆上限 CLI 转换)

## 收尾(Trellis Phase 3)

- [x] 全量 `npm test`(58/58)+ 真实包矩阵复跑 + secrets 校验(verify-secrets.mjs 8/8)
- [x] spec 沉淀:.trellis/spec/guides/tavern-datapack-formats.md(布局/导入语义/环境教训)
- [ ] `task.py archive`:等两项人工终验通过后归档(PT 实机导入、Dev 实例插件加载)

## 回滚点

每 Phase 一个提交;Phase B 内部按目标平台拆小提交(B2-B5 各一)。实例与平台代码零接触,回滚永远只涉及本仓库 git。
