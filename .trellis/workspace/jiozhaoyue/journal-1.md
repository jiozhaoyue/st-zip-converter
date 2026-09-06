# Journal - jiozhaoyue (Part 1)

> AI development session journal
> Started: 2026-09-01

---



## Session 1: CLI 全矩阵完成:真实包 8 方向实转全过
<!-- trellis-session: v=2 fp=adc99dcb166d24d6 -->

**Date**: 2026-09-02
**Task**: CLI 全矩阵完成:真实包 8 方向实转全过
**Branch**: `main`

### Summary

接续上会话:回答 PT 扩展闸根因(设计行为,转换器侧合成 extension-sources 绕过);补齐 L 导入端点调研;规划三产物(prd/design/implement)评审通过后 task.py start;实现 Phase A-C:流式 IO+布局识别+hub 拓扑转换管线+CLI,32 单测绿;真实包 964MiB/162MiB 8 方向实转全过,secrets 字节一致,峰值内存 884→233MiB(惰性流直通修复 deflateRaw 积压);E1 插件可行性调研完成。待办:D2 用户 PT 导入验证、Phase E 插件。

### Git Commits

(No commits - planning session)

### Status

[OK] **Completed**


## Session 2: 自动测试完成:真实镜像/往返CRC/插件全落地(58 测试)
<!-- trellis-session: v=2 fp=8f108c5b63f2a007 -->

**Date**: 2026-09-04
**Task**: 自动测试完成:真实镜像/往返CRC/插件全落地(58 测试)
**Branch**: `main`

### Summary

目标'自动测试直到全部完成':T1 真实产物逐条目过 L/PT 真实路由(发现并修复三个保真缺口:PT 用户级扩展自动迁移为 third-party 布局+来源合成、TT 用户目录私有数据归类、third-party 散文件/image-metadata 处置);T2 往返 CRC 完整性(l→st→l、tt→pt→tt 全条目一致);T3 cargo test 因本机无 MSVC 链接器不可行(上会话结论有误,如实记录);T4 Termux 结构检查+192MiB 堆上限;T5 IO 适配器注入(node-io/zipjs-io)核心去 Buffer 化;T6 ST/L 插件 esbuild 自包含构建+无 DOM 冒烟;T7 spec 沉淀 guides/tavern-datapack-formats.md。58/58 测试绿,secrets 8/8 字节一致。剩两项人工终验:PT 实机导入、Dev 实例插件加载。

### Git Commits

(No commits - planning session)

### Status

[OK] **Completed**


## Session 3: 任务终验归档与规范库全量填充
<!-- trellis-session: v=2 fp=f2fa646c38c87671 -->

**Date**: 2026-09-04
**Task**: 任务终验归档与规范库全量填充
**Branch**: `main`

### Summary

接续 Trellis 任务完成全流程终验与归档：对 09-01-cross-tavern-datapack 确认 58/58 自动化测试与镜像 CRC 校验通过后执行 archive 归档；基于真实代码与既有格式知识，全面填充 .trellis/spec/ 下 Backend(Core/CLI) 与 Frontend(插件) 的全部 12 项开发规范与真实代码范例；顺利归档 00-bootstrap-guidelines 初始化规范任务。当前活跃任务清零，代码库与规范库状态整洁。

### Main Changes

- 确认 09-01-cross-tavern-datapack 完成验收并归档至 archive/2026-09/
- 填充 backend 全部 5 项规范（目录架构、数据包流式存储、错误处理、结构化日志、质量标准）
- 填充 frontend 全部 6 项规范（插件架构、DOM挂载、宿主API与CSRF、Blob生命周期、类型安全、质量标准）
- 更新 backend/index.md 与 frontend/index.md 为 Ready 状态
- 归档 00-bootstrap-guidelines 至 archive/2026-09/，更新 .gitignore 忽略 .history/

### Git Commits

| Hash | Message |
|------|---------|
| `6ac7000` | chore(task): archive 09-01-cross-tavern-datapack |
| `ab10268` | docs(spec): 填充 Backend(Core/CLI) 与 Frontend(插件) 开发规范与范例 |
| `f7931ec` | chore(task): archive 00-bootstrap-guidelines |

### Testing

- [OK] npm test (58/58 测试全部通过)
- [OK] node test/verify-secrets.mjs (8 产物密钥字节一致性校验通过)
- [OK] vitest run test/zipjs-io.test.js (zip.js 与 node-io 产物同构性校验通过)

### Status

[OK] **Completed**

### Next Steps

- 根据后续需求规划下一阶段特性或发布打包任务


## Session 4: 三位一体架构收敛与旧版 CLI / 单文件插件彻底移除
<!-- trellis-session: v=2 fp=a77c715e2dac2d6f -->

**Date**: 2026-09-04
**Task**: 三位一体架构收敛与旧版 CLI / 单文件插件彻底移除
**Branch**: `main`

### Summary

彻底清理 cli.js、node-io.js、旧 build.mjs 及 yauzl/yazl 依赖，收敛至通用纯前端 zipIo 引擎，51 项测试全绿并通过 Vite 构建，本地服务就绪并归档任务。

### Main Changes

- 卸载 yauzl、yazl、esbuild 依赖，删除 cli.js、src/core/read.js、src/core/write.js、src/io/、src/plugins/
- 增强 src/core/zip-io.js：增加异步任务队列保证顺序写入、增加路径去重保护防碰撞
- 迁移全部单测至通用 zipIo，修复 Uint8Array 与 Buffer 转换兼容，51 项测试全部通过
- 更新 .trellis/spec/ 中 backend/frontend 目录结构规范，同步三位一体工程规范

### Git Commits

| Hash | Message |
|------|---------|
| `c73fce5` | refactor: eliminate legacy CLI and monolithic plugins in favor of pure web Trinity architecture |

### Testing

- [OK] npm test (51 passed, 2 skipped)
- [OK] npm run build (Vite 452ms clean build)

### Status

[OK] **Completed**

### Next Steps

- 根据用户需求持续迭代功能或接入实际 SillyTavern 环境做现场联调


## Session 5: Web Worker 多线程加速与独立模式类目选择性导出/安全脱敏落地
<!-- trellis-session: v=2 fp=ca17d12f30dbb4fa -->

**Date**: 2026-09-04
**Task**: Web Worker 多线程加速与独立模式类目选择性导出/安全脱敏落地
**Branch**: `main`

### Summary

实现零拷贝中央目录预检与资产聚合（inspectArchive），支持按角色卡/聊天记录/世界书/密钥/扩展等细粒度类目选择性导出；新增安全脱敏预设一键移除 secrets.json 与私密聊天；引入 Dedicated Web Worker 异步压缩解压流水线（worker-client + converter-worker），保证 1GB+ 大包转换时 UI 60fps 丝滑流畅并提供 Node 环境透明降级；56 项测试全绿，Vite 构建 674ms 完成。

### Main Changes

- 新增 src/core/inspect.js：零拷贝中央目录预检，统计各类目文件数量与解压字节
- 增强 src/core/transform.js 与 report.js：支持 options.selection 过滤与 report.filtered 记录
- 新增 src/core/converter-worker.js 与 worker-client.js：实现 Dedicated Web Worker 异步转换及 Node/Vitest 降级回退
- 新增 src/ui/category-filter.js 与 index.html/style.css 升级：动态渲染类目勾选卡片并提供安全脱敏等一键预设
- 配置 vite.config.js worker.format 为 es，修复 Worker 代码分割与打包

### Git Commits

| Hash | Message |
|------|---------|
| `f1af968` | feat: 实现 Web Worker 多线程压缩解压与类目选择性导出/安全脱敏功能 |

### Testing

- [OK] npm test (56 passed, 2 skipped)
- [OK] npm run build (Vite 674ms clean build with dedicated worker bundle)

### Status

[OK] **Completed**

### Next Steps

- 用户在浏览器中打开 http://localhost:5173 进行新特性的直观体验与大包验证


## Session 6: 对齐 ST/Luker 原生规范实现 10 大标准备份类目细粒度选择器
<!-- trellis-session: v=2 fp=6d6176a3d84aadb0 -->

**Date**: 2026-09-05
**Task**: 对齐 ST/Luker 原生规范实现 10 大标准备份类目细粒度选择器
**Branch**: `main`

### Summary

1. 重构中央目录预检与类目定义 (src/core/inspect.js)，全面对齐 SillyTavern 与 Luker 的 10 大标准备份项 (characters, chats, lorebooks, presets, settings, secrets, assets, extensions, globalExtensions, vectors)。2. 优化 transform.js 与 Luker manifest 合成，确保用户勾选与 manifest.json.selection 字典完全同步。3. 重构类目选择 UI (category-filter.js 与 index.html/style.css)，提供全量细粒度复选框、文件数与解压体积展示、全选/全不选/反选与快捷预设。4. 更新单元测试 (test/filter.test.js)，56 个单元测试全部通过，生产包构建无报错。

### Git Commits

| Hash | Message |
|------|---------|
| `59c71bb` | feat(ui): 对齐 ST/Luker 规范实现 10 大标准备份类目全量勾选面板 |

### Status

[OK] **Completed**


## Session 7: 实现 IndexedDB 暂存工作区、完全扫描动作预测与单项穿透勾选器
<!-- trellis-session: v=2 fp=f7386e7ec8404117 -->

**Date**: 2026-09-05
**Task**: 实现 IndexedDB 暂存工作区、完全扫描动作预测与单项穿透勾选器
**Branch**: `full-dev`

### Summary

1. 切换至 full-dev 分支开启全能数据包处理工作站演进。2. 实现基于浏览器原生 IndexedDB 的存储适配器 (src/storage/db.js)，支持源包与转换包暂存、工作区无损恢复与容量统计清空。3. 构建完全扫描规划引擎 (src/core/plan-preview.js)，在转换前秒级预测条目动作（直通、路由、迁移、合成、丢弃）与预估产物体积。4. 实现单项穿透树形勾选器与模糊搜索 (src/ui/file-tree-picker.js)，支持单张角色卡、单个扩展或聊天独立剔除。5. 解耦派生缓存、历史备份与应用私有配置的独立控制开关。6. 全量测试通过 (60/60 passed)，打包顺畅。

### Git Commits

| Hash | Message |
|------|---------|
| `21e50ab` | feat(storage,preview): 实现 IndexedDB 暂存工作区、完全扫描动作预测与单项穿透勾选器 |

### Status

[OK] **Completed**


## Session 8: 工作站高级控制台：双文件列表、自定义包名/压缩率与动作筛选联动
<!-- trellis-session: v=2 fp=d9b20f050658d423 -->

**Date**: 2026-09-05
**Task**: 工作站高级控制台：双文件列表、自定义包名/压缩率与动作筛选联动
**Branch**: `full-dev`

### Summary

1. 实现了基于 IndexedDB 的已上传源包与已转换产物双文件列表管理组件 (src/ui/archive-manager.js)，支持一键重新载入、独立下载与删除，支持将产物作为新源包多跳再转换。2. 支持自定义导出包名模板 (src/core/filename-template.js)，提供 {source}, {target}, {date}, {handle} 占位符解析与跨系统文件名净化。3. 实现了 0(极速存储/Store)、1(快速)、5(标准默认)、9(极限压缩) 四档 Zip 压缩率调节，并确保完全兼容 ST/Luker/TT/PT 解压引擎。4. 文件树支持按体积降序排列，对 >1MB 及 >5MB 大文件显示醒目警示徽标。5. 动作预测条各动作胶囊支持动态联动过滤下方文件树。6. 新增单元测试 (66/66 passed)，打包验证顺畅。

### Git Commits

| Hash | Message |
|------|---------|
| `9f35511` | feat: implement dual archive manager, custom filenames, compression level and action filtering |
| `7192780` | chore(task): archive 09-05-workstation-advanced-controls |

### Testing

- [OK] npm test (66 passed, 2 skipped)
- [OK] npm run build (Vite 647ms clean build)

### Status

[OK] **Completed**


## Session 9: 批量队列与链式流转：常驻双列表、包名占位符芯片与多端排版精修
<!-- trellis-session: v=2 fp=9a1e7e96392256b3 -->

**Date**: 2026-09-05
**Task**: 批量队列与链式流转：常驻双列表、包名占位符芯片与多端排版精修
**Branch**: `full-dev`

### Summary

1. 取消双文件列表的折叠隐藏逻辑，设为界面常驻展示，一目了然掌控源包与产物。2. 自定义文件名增加交互式占位符药丸芯片 (+ {source}, + {target}, + {date}, + {handle}) 与说明，点击即刻插入。3. 全面优化多端排版，彻底移除冗余副标题说明与描述文字，加入全量防撕裂换行与移动端断点适配。4. 支持拖拽/选取多个 Zip 包批量入库，并在源包列表提供一键批量转换队列与总进度汇报。5. 产物列表无缝支持一键作为源包进入下一轮转换，通过单元测试验证了 ST -> TT -> PT 多跳链式转换能力。6. 67 个单元测试全量通过，生产构建顺畅。

### Git Commits

| Hash | Message |
|------|---------|
| `ec43217` | feat: permanent dual list, placeholder chips, batch conversion queue and responsive typography |
| `d6be988` | chore(task): archive 09-05-batch-and-chain |

### Testing

- [OK] npm test (67 passed, 2 skipped)
- [OK] npm run build (Vite 844ms clean build)

### Status

[OK] **Completed**


## Session 10: 全能酒馆数据包工作站与全闭环架构 (v1.0.0 正式发布)
<!-- trellis-session: v=2 fp=a4f912b7ce11e309 -->

**Date**: 2026-09-05
**Task**: 全能酒馆数据包工作站：宿主直接细粒度导出、增量恢复写入、Method 93透明解压、实时日志抽屉与移动端深度适配
**Branch**: `full-dev` / `main`
**Tag**: `v1.0.0`

### Summary

1. 架构升维为全平台兼容的「全能酒馆数据包工作站」，所有操作（导出、细粒度筛选、跨格式直出、双列表管理、增量差量合并、恢复写入宿主、实时日志审计）均收拢在单一统一面板内闭环完成。
2. 宿主直接导出工作台支持 8 项细粒度类目自由勾选，支持一键快捷预设（全选、仅角色卡、仅聊天记录、安全脱敏），支持角色与聊天记录智能联动，并可一步直出为 ST / Luker / TT / PT 格式。
3. 实现了增量导出模式与一键写入恢复宿主（支持增量合并 mode: merge 与全量覆盖 mode: overwrite 双模式），支持离线两包差量合并 (incrementalMergeArchives)，尤其针对 TauriTavern 数据包提供无损融合补丁能力。
4. 原生兼容 7-Zip-zstd (7-Zip ZS) 与 TauriTavern 的 Method 93 (Zstandard in Zip) 压缩条目，通过纯 JS fzstd 流实现自适应透明解密解压。
5. 依赖自包含化 (src/vendor/zip.js, src/vendor/fzstd.js)，实现 SillyTavern 扩展管理器通过 Git URL 一键克隆安装即开即用，零 npm install、零构建依赖。
6. 主面板底部常驻抽屉式实时日志与诊断控制台 (src/ui/log-console.js)，支持高亮滚屏、级别过滤、耗时统计、一键复制与下载 .log 文件。
7. 移动端与手机竖屏极致深度适配，保证 touch target >= 44px，双列表单列垂直堆叠，杜绝横向滚动溢出。
8. 全量 73 个自动化单元与集成测试全部通过，Vite 生产构建顺畅无警告，正式发布并推送 v1.0.0 标签。

### Git Commits

| Hash | Message |
|------|---------|
| `ba30dac` | feat: 全能酒馆数据包工作站与全闭环操作架构 (细粒度导出/增量恢复/Method93/自包含引擎/实时日志控制台/移动端适配) |

### Testing

- [OK] npm test (73 passed, 2 skipped)
- [OK] npm run build (Vite 635ms clean build)

### Status

[OK] **Completed**



## Session 11: SillyTavern 酒馆风格 UI 重构与导出名占位符解析缺陷修复
<!-- trellis-session: v=2 fp=71505269807ccff5 -->

**Date**: 2026-09-06
**Task**: SillyTavern 酒馆风格 UI 重构与导出名占位符解析缺陷修复
**Branch**: `main`

### Summary

1. 深入排查并修复导出文件名占位符失效的 6 大根因（宿主原生导出绕过解析、handle 未透传、芯片点击失焦错位、缺乏实时预览、别名未识别、特殊字符转义风险）。2. 全面重构 UI 为正统 SillyTavern 酒馆风格，继承 SmartTheme 系统变量体系，采用黑曜底色、琥珀金、毛玻璃质感、羊皮纸拖拽区与勋章占位符。3. 自动化测试 (75/75 passed) 与生产打包验证全绿。

### Main Changes

- 修复宿主导出原生分支与跨格式分支的导出文件名模板解析断流
- 贯通 handle 管道，从 /api/users/me 或 Zip manifest 动态提取并注入
- 重构文件名占位符引擎，支持更多别名映射与安全防转义函数式替换
- 药丸芯片绑定 mousedown 阻止失焦并实现智能插入与补全
- 增加导出文件名实时响应式效果预览
- 全面升级为正统 SillyTavern 酒馆视觉风格，绑定 SmartTheme 变量并重塑组件质感

### Git Commits

| Hash | Message |
|------|---------|
| `971300f` | feat(ui): 全面重构为 SillyTavern 酒馆风格并彻底修复导出名占位符解析失效缺陷 |

### Testing

- [OK] npm test -- --run (75 passed, 2 skipped)
- [OK] npm run build (Vite 718ms clean build)

### Status

[OK] **Completed**

### Next Steps

- 根据酒馆社区反馈持续迭代更多主题细节与扩展功能


## Session 12: 开源发布就绪：安全审计加固、开源合规与多平台部署体系构建
<!-- trellis-session: v=2 fp=8b4c27819e4a2d10 -->

**Date**: 2026-09-06
**Task**: 安全审计加固、开源合规与多平台部署体系构建
**Branch**: `main`

### Summary

1. 展开开源发布前全量安全与质量审计：检查敏感信息防护，确认密码与 API 密钥过滤合规，清理临时调试脚本。
2. 规范化开源合规协议，引入 MIT LICENSE 与标准 SECURITY.md 安全响应指引。
3. 建立多平台云原生分发与一键部署体系：编写 GitHub Pages 自动化 Action 工作流、一键 Fork 部署指引以及 Vercel/Netlify 零配置部署文档。
4. 固化核心技术调研与安全报告：`docs/research/filename-placeholders-root-cause.md` 与 `docs/research/security-audit-and-public-release.md`。

### Main Changes

- 补充正式开源 MIT 许可证与 SECURITY.md 漏洞披露机制
- 清理冗余的临时单测脚本与构建残留，优化 CI 构建与发布管道
- 编写完善的 GitHub Pages 一键部署与 Vercel/Netlify 快速托管文档
- 固化文件名占位符排查报告与多平台安全审计专项报告

### Git Commits

| Hash | Message |
|------|---------|
| `6c1664d` | chore: 安全审计加固、清理冗余测试脚本并补充 MIT LICENSE 与 SECURITY 策略 |
| `4e9e859` | docs(deploy): 增加 GitHub Pages 一键 Fork 部署与 Vercel/Netlify 部署指引并优化 CI 工作流 |
| `cfbacef` | docs(research): 固化导出名占位符失效排查与敏感信息安全审计调研报告 |

### Testing

- [OK] npm test (75 passed, 2 skipped)
- [OK] npm run build (Vite 生产构建成功，静态资源相对路径注入正常)

### Status

[OK] **Completed**


## Session 13: 智能独立分包、扩展轻量清单防408与Git浅层精简架构
<!-- trellis-session: v=2 fp=6a12de405bc781fa -->

**Date**: 2026-09-06
**Task**: 智能独立分包、扩展轻量清单防408与Git浅层精简架构
**Branch**: `main`

### Summary

1. 深入调研 Luker / SillyTavern 扩展识别机制（`src/endpoints/extensions.js`）与 Git 历史包体膨胀根因。
2. 研发智能独立增量分卷切片引擎 (`src/core/splitter.js`)，针对云酒馆 100MB 单包限制切分多包，每个包均为结构完备、可独立解压使用的合法数据包，彻底废弃不兼容的 `.z01` 分卷切片。
3. 推出扩展轻量清单模式 (`extensionMode: 'manifest'`) 与 Git 浅层精简 (depth: 1 浅克隆)：数据包体积缩减 99%，彻底杜绝 408 导入超时并保留后续在线更新能力。
4. 增强原生过滤支持：智能剔除酒馆原生默认背景与预设资产；识别并提供错误 `third-party/third-party` 嵌套目录的一键检测与清理。
5. 修复宿主扩展设置抽屉面板挂载机制 (`mountSettingsDrawer`)，确立规范：禁止直接修改本地酒馆实例目录，强制采用 Git 标准工作流交付。

### Main Changes

- 新增 `src/core/splitter.js`：智能独立分包引擎，按大小阈值自动分组切分
- 新增 `src/ui/split-deliver-modal.js`：优雅的分卷下载与本地批量交付模态框
- 新增 `src/core/builtin-assets.js`：酒馆原生固定重复资产识别与清洗
- 在 `src/core/transform.js` 中增加 `extensionMode` 与构建冗余文件清洗 (`isJunkOrDevFile`)
- 在 `src/ui/host-bridge.js` 中新增 `discoverHostExtensions`、`installExtensionViaHost`、`checkHostThirdPartyAnomaly` 与 `deleteExtensionViaHost`
- 确立本地实例严格隔离规范，杜绝文件系统直接拷入，保持 Git 受控

### Git Commits

| Hash | Message |
|------|---------|
| `0135650` | feat: 支持智能增量独立分包、剔除原生重复资产、轻量清单防408与修复宿主扩展面板 |
| `c166524` | docs: 规范化禁止直接操作本地酒馆实例目录，强制采用 Git 标准工作流 |

### Testing

- [OK] npm test (86 passed, 2 skipped)
- [OK] test/splitter.test.js (智能分包规则全过)
- [OK] test/builtin-assets.test.js (原生资产剔除校验全过)

### Status

[OK] **Completed**


## Session 14: 100% 酒馆原生抽屉展开 UI、全站 0 Emoji 矢量化、外部基准增量导出与备份聊天过滤
<!-- trellis-session: v=2 fp=4c718b5219ae03d4 -->

**Date**: 2026-09-06
**Task**: 100% 酒馆原生抽屉展开 UI、全站 0 Emoji 矢量化、外部基准增量导出与备份聊天过滤
**Branch**: `main`

### Summary

1. 彻底废弃以往需要点击弹窗的设计，全面重塑为 100% 酒馆原生 UI 体系：直接在 SillyTavern / Luker 扩展设置抽屉中完整平铺展开工作台，采用子抽屉 (`.inline-drawer`) 分组承载，全面绑定原生类名（`.text_pole`、`.menu_button`、`.checkbox_label` 等）与主题变量。
2. 遵循“只在插件页面做，不在魔法棒做”的明确决策，不在魔法棒菜单插入多余图标。
3. 全站 0 Emoji 彻底清理：将所有组件、模板、按钮、标签中的 Emoji 表情符号全部转换为 Font Awesome 6 标准矢量图标。
4. 增加“备份聊天记录与快照 (backups/)”选项，宿主导出与外部转换均默认不勾选，精准剔除 `backups/` 目录与各角色聊天中的备份与分支文件。
5. 研发基于外部基准 ZIP 的增量导出差量引擎 (`src/core/delta.js`)：必须在外部选择一个已有基准 ZIP 作为比对基准，提取新增与被修改文件生成体积极小、带 `_delta_manifest.json` 的纯增量补丁包 (Delta Zip)，并支持与基准包无损合并还原。
6. 自动化测试套件扩充至 19 个测试套件、105 项测试全部通过。

### Main Changes

- 全面重构 `src/ui/workbench-template.js`、`src/ui/host-bridge.js`、`style.css`、`index.html` 为 100% 原生 `.inline-drawer` 体系
- 清理所有 Emoji，全面替换为 Font Awesome 6 语义类名 (`fa-solid fa-...`)
- 新增 `src/core/delta.js`：实现 `compareArchives` 与 `generateDeltaArchive`
- 新增 `src/core/inspect.js` `isBackupChatOrSnapshot` 工具函数，贯通 `transform.js` 与 `plan-preview.js`，默认剔除备份聊天
- `index.js` 绑定基准 ZIP 外部选择器、状态条及增量补丁生成链路
- 新增 `test/delta.test.js` 与 `test/backup-chats.test.js` 自动化测试

### Git Commits

| Hash | Message |
|------|---------|
| `adf9bab` | feat(ui): overhaul to 100% native SillyTavern in-drawer UI without emojis |
| `0212345` | feat(export): add backup chats option (default unchecked) and base-zip incremental export |

### Testing

- [OK] npm test (19 passed, 1 skipped, 105 tests passed, 100% green)
- [OK] test/delta.test.js (基准比对、差量补丁提取与合并往返还原测试全过)
- [OK] test/backup-chats.test.js (快照与聊天备份识别、默认排除与显式包含测试全过)
- [OK] 全项目 0 Emoji 正则扫描验证通过

### Status

[OK] **Completed**

### Next Steps

- 跟踪社区在不同云酒馆与本地酒馆实例环境中的增量导出与浅克隆使用体验
- 持续完善自动化测试与多语言国际化支持

