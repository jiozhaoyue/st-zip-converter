# 插件可行性调研(Phase E1,2026-09-02)

## 平台备份端点

| 平台 | 端点 | selection 支持 | secrets | 插件数据源结论 |
|---|---|---|---|---|
| L | `POST /api/users/backup`,body `{handle, selection}`(`Dev/Luker/src/endpoints/users-private.js:1061`,selection 解析 :1081) | ✅ 10 类全可选 | ✅ selection.secrets=true 即含 | **理想**:拉全选 zip 即为合法 L 包,喂给转换核心即可 |
| ST | `createBackupArchive(handle, response)`(`Dev/SillyTavern/src/users.js:1148`) | ❌ 无 selection 参数 | ❌ 默认排除 secrets.json | **降级**:插件产出 hub 包 + 明确警告"secrets 需经 CLI 或手动补齐" |

- L 端点还有 `backups.allowFullDataBackup` 配置开关(:1063),关闭时 403——插件要处理该错误并提示。
- L 的 `restore-backup` 端点(:1227)支持 selection + overwrite/merge;插件不做导入端(L 原生 UI 已覆盖)。

## 浏览器侧 zip IO(插件与 Node 核心的分叉点)

- 核心读侧 yauzl 只能读文件路径(Node),浏览器插件拿到的备份是 Blob。
- 大包约束同 CLI(964 MiB 级):浏览器不能用 fflate 的 `unzip`(整包驻留内存)。
- **选型 `@zip.js/zip.js`**:Blob 随机访问 + Web Streams 流式逐条目,内存模型与 yauzl 等价;写侧同库流式 writer。
- 因此需要把 transform.js 的编排循环从"直接 new ZipReader/ZipWriter"改为注入 IO 适配器(两平台各一套适配器,entries()/read()/openStream()/addLazy() 同契约)。映射/合成/报告逻辑不动——它们本就 IO 无关。

## 插件形态决议(待实现)

1. **先做 L 插件**(用户主力平台、真实数据所在):ST 扩展标准结构,UI 内"导出为 ST/TT/PT"三按钮 → fetch `/api/users/backup`(selection 全 true)→ IO 适配器转换 → 触发下载。esbuild 打包 core + zip.js。
2. ST 插件后置:数据源缺 secrets,价值低于成本;若做,复用同一适配器,导出时报告警告。
3. 版本同锁:插件与 CLI 版本一致发布,规则不漂移。

## 风险

- zip.js 的流式 writer 与 yazl 的 addLazy 语义对齐(惰性泵)需要在适配器里验证;若 zip.js 不支持,退化为"逐条目顺序写"仍然可行(浏览器内存仍受控)。
- ST 生态第三方扩展的 CSRF/鉴权:fetch 同源带 cookie,ST 端点要求 CSRF token(`X-CSRF-Token`),从页面上下文取——实现时核实 L 是否同样要求。
