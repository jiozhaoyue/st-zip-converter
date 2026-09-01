# 执行计划:酒馆系数据包互转工具

> 每阶段一个 git 提交,可独立回滚;验证命令必须通过才进下一阶段。

## Phase A:骨架 + 流式 IO

- [ ] A1 `package.json`(type:module,engines node>=18,依赖 yauzl/yazl + 测试框架 vitest),gitignore(样本 zip、node_modules)
- [ ] A2 `src/core/read.js` + `write.js`:yauzl 流式读迭代器 / yazl 流式写;单测:小包读写往返字节恒等
- [ ] A3 `src/core/detect.js`:四布局判定(含 PT 原生归档的"不支持"分支);单测覆盖每个分支
- [ ] A4 `fixtures/gen.js` 生成四个平台迷你包(prd R2 内容集),产物入库
- 验证:`npm test`;对两个真实 zip 跑 detect 打印布局判定

## Phase B:映射与转换

- [ ] B1 `layout.js` 目录映射表 + `transform.js`:(from,to) 变换组装(前缀、manifest 合成、extension-sources 合成、丢弃规则、--keep-all)
- [ ] B2 目标 L:manifest/摊平/后缀匹配镜像测试(镜像 users-private.js:305-335 规则)
- [ ] B3 目标 TT:`data/default-user/` 前缀 + TT 私有目录处置
- [ ] B4 目标 PT:TT 布局 + extension-sources 合成(homePage 兜底、https 校验、manifest 缺 display_name/js/css 的警告对齐)
- [ ] B5 目标 ST:摊平 + `_convert/INSTALL.md`
- [ ] B6 `report.js`:模块计数/丢弃清单/警告,human+json
- 验证:`npm test` 全绿;迷你包全 12 方向(st/l/tt/pt 各源 × 各目标,PT 原生归档源除外)往返断言

## Phase C:真实包集成 + CLI

- [ ] C1 `cli.js` 参数与退出码;`--dry-run` 只产出报告不写文件
- [ ] C2 真实包矩阵:两 zip 全方向 dry-run + 实转;AC1/AC2 计数核对;AC7 内存峰值测量(`--max-old-space-size` 观察 process.memoryUsage)
- [ ] C3 AC6 secrets 断言:所有产物含 secrets.json 且字节一致
- 验证:`node cli.js samples/... --to pt --dry-run` 报告人工过目;内存 < 512 MiB

## Phase D:PT/TT 合规复核

- [ ] D1 镜像 PT tauri-tavern 路由断言(import.ts:280-330)入 test(AC5 结构部分)
- [ ] D2 产物在 PT Dev 实例手动导入一次(用户操作),确认角色/聊天/扩展可见 → AC5 完成项
- [ ] D3 (可选)cargo test -p tt-adapter-archive 对照布局判定
- 验证:用户确认 PT 导入结果;其余自动测试绿

## Phase E:插件

- [ ] E1 核实 ST/L 备份端点的前端可达性与 secrets 补齐路径(design §7 风险)
- [ ] E2 ST 扩展骨架(manifest+index+esbuild bundle core),Dev 实例加载冒烟
- [ ] E3 导出方向接线(L→ST/TT/PT、ST→L/TT/PT),产物与 CLI diff 为空(AC9)
- [ ] E4 README:安装、Termux 用法、ST 手动导入说明、secrets 安全提示
- 验证:AC8(Termux 结构检查 + 桌面 Node>=18 冒烟)、AC9

## 收尾(Trellis Phase 3)

- [ ] 全量 `npm test` + 真实包矩阵复跑
- [ ] `trellis-update-spec`:把"四平台包布局与导入语义"沉淀进 spec(跨任务复用)
- [ ] 提交、`task.py archive`

## 回滚点

每 Phase 一个提交;Phase B 内部按目标平台拆小提交(B2-B5 各一)。实例与平台代码零接触,回滚永远只涉及本仓库 git。
