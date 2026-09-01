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

## Phase D:PT/TT 合规复核(部分完成)

- [x] D1 镜像测试入 test/mirror.test.js
- [ ] D2 产物在 PT 中手动导入(用户操作):`out/real-l-to-pt.zip` → 确认角色/聊天/扩展可见 → AC5 完成项
- [ ] D3 (可选)cargo test -p tt-adapter-archive 对照布局判定

## Phase E:插件(未开始,E1 调研已完成 → research/plugin-feasibility.md)

- [ ] E0 核心编排循环改为注入 IO 适配器(Node yauzl/yazl 适配器 + 浏览器 zip.js 适配器,同契约)
- [ ] E1 ✅ 已核实:L `POST /api/users/backup` 支持 selection 含 secrets(users-private.js:1061),
      ST 端点无 selection 且默认排除 secrets(users.js:1148)→ L 插件先行,ST 后置
- [ ] E2 L 插件骨架(ST 扩展结构,esbuild bundle core+zip.js),Dev 实例加载冒烟
- [ ] E3 导出方向接线(L→ST/TT/PT),产物与 CLI diff 为空(AC9)
- [ ] E4 README:安装、Termux 用法、ST 手动导入说明、secrets 安全提示
- 验证:AC8(Termux 结构检查 + Node>=18 冒烟)、AC9

## 收尾(Trellis Phase 3)

- [ ] 全量 `npm test` + 真实包矩阵复跑
- [ ] `trellis-update-spec`:把"四平台包布局与导入语义"沉淀进 spec(跨任务复用)
- [ ] 提交、`task.py archive`

## 回滚点

每 Phase 一个提交;Phase B 内部按目标平台拆小提交(B2-B5 各一)。实例与平台代码零接触,回滚永远只涉及本仓库 git。
