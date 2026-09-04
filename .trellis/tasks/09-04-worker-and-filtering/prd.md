# Web Worker 多线程加速与独立模式类目选择性导出 PRD

## 1. 背景与目标 (Background & Goal)

在将项目重构成“三位一体”纯前端 Web 架构（`st-zip-converter`）后，用户在独立 Web 运行环境和超大包场景下面临两项核心痛点：
1. **脱敏提取与跨平台瘦身需求**：用户通常拥有数千张角色卡、聊天记录或私密密钥（`secrets.json`）。当用户只想把“角色卡包”或“世界书”转成其他平台格式分享给朋友时，酒馆原生导出往往是全量的，缺乏灵活细粒度提取手段。转换器需要在独立 Web 模式下提供秒级识别、类目勾选（角色卡/聊天/世界书/密钥/扩展）与脱敏导出。
2. **超大包（1GB+）UI 阻塞问题**：在纯主线程执行 gzip/deflate 压缩计算时，当压缩包含数千张 PNG 图片的大包时，主线程容易掉帧甚至出现短暂假死。需要引入 Web Worker 异步多线程流式处理，确保 UI 始终 60fps 流畅。

---

## 2. 用户故事 (User Stories)

- **US1**: 作为独立 Web 用户，当我把一个 500MB 的酒馆备份包拖入网页后，界面能瞬间（<1秒）扫描目录并呈现分类清单（如：角色卡 120 张、聊天 45 份、世界书 8 本、密钥 1 个），我可以自由勾选排除敏感密钥或只导出角色卡。
- **US2**: 作为酒馆插件用户，在酒馆内我依然享有默认一键快捷导出；若需要高级脱敏，我可展开“筛选类目”按需选择。
- **US3**: 作为处理超大包（1GB+）的用户，在转换数千个文件时，网页进度条丝滑推进，界面不卡死，可以随时取消，转换完成后立即触发下载。

---

## 3. 功能需求 (Requirements)

### R1: 零拷贝中央目录预检与类目聚合 (`src/core/inspect.js`)
- 利用 `@zip.js/zip.js` 的中央目录只读解析，不解压文件体，在 100ms 内统计各资产类目的文件数与解压体积：
  - `characters`: 角色卡（`characters/`, PNG/JSON）
  - `chats`: 聊天记录（`chats/`, JSONL）
  - `worlds`: 世界书（`worlds/`, JSON）
  - `settings`: 用户设置（`settings.json`, `OpenAI Settings/`, `presets/`）
  - `secrets`: 敏感密钥（`secrets.json`）
  - `avatars`: 用户头像（`User Avatars/`）
  - `extensions`: 第三方扩展（`extensions/third-party/` 或 TT 的 `data/extensions/third-party/`）
- 返回聚合数据结构：`{ [category]: { count: number, sizeBytes: number, available: boolean } }`。

### R2: 转换引擎支持类目选择性过滤 (`src/core/transform.js`)
- `convert(source, dest, options)` 扩充 `options.selection`:
  - 默认值：全部为 `true`（全量导出，完全向后兼容）。
  - 若某项设为 `false`（例如 `selection.secrets = false` 或 `selection.chats = false`）：
    - 路由阶段直接将该条目跳过（`entry.skip()`），不产生流读取开销。
    - 报告标记为 `filtered(path, '用户在选择器中排除了此类目')`。
  - 对于 ST/L 导出的 `manifest.json`，若有 selection 字段，同步更新其导出的 selection 元数据。

### R3: Web Worker 异步流水线 (`src/core/converter-worker.js`)
- 实现基于标准 Web Worker 的转换服务：
  - 主线程与 Worker 之间通过消息协议通讯：
    - 主线程 -> Worker: `{ type: 'start', sourceBlob, target, options }`
    - Worker -> 主线程: `{ type: 'progress', current, total, filename }`
    - Worker -> 主线程: `{ type: 'done', report, resultBlob }`
    - Worker -> 主线程: `{ type: 'error', message }`
  - 环境自适应降级：当运行在 Node.js 单测环境或不支持 Worker 的受限环境时，透明回退为主线程执行。

### R4: UI 交互呈现 (`src/ui/file-drop.js` & `src/ui/view.js`)
- 文件加载后，在目标选择器上方优雅呈现“数据包内容与脱敏提取”折叠/展示面板。
- 提供【全选】、【仅角色卡】、【仅角色与世界书】、【排除私密密钥】等一键预设。
- 每个类目带有徽标展示数量与体积。

---

## 4. 验收标准 (Acceptance Criteria)

- [ ] **AC1**: `inspectArchive(source)` 能在 200ms 内准确统计四个平台（ST/L/TT/PT）测试包中的各资产类目数量与字节大小。
- [ ] **AC2**: `convert(..., { selection: { secrets: false, chats: false } })` 产物中绝对不包含 `secrets.json` 和 `chats/` 条目，转换报告中记录为 filtered。
- [ ] **AC3**: 默认全选时，所有 4 种平台包的转换结果与改动前完全 100% 同构，无任何破坏性回归。
- [ ] **AC4**: Web Worker 正常承载转换任务并通过 postMessage 实时上报进度；在 Node.js vitest 环境下自动化测试正常执行。
- [ ] **AC5**: UI 界面呈现自适应类目勾选框，在独立 Web 模式下流畅切换过滤条件并成功导出。
- [ ] **AC6**: Vite 构建 `npm run build` 无告警，单测套件 100% 绿灯。
