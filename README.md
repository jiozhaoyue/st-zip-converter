# tavern-convert

酒馆系(SillyTavern / Luker / PureTavern / TauriTavern)导出数据包互转工具。

一份转换核心,两种入口:

- **CLI**(Node ≥18,桌面 / Termux 均可)
- **ST/L 平台内插件**(规划中,见下"路线")

## 原理(30 秒版)

四个平台的包本质上是同一种数据的两种摆放:ST/L 是摊平的用户目录,TT 是多套一层
`data/default-user/` 前缀,PT 不认摊平但认 TT 布局。本工具以 ST 摊平布局为中枢做
路径层改写,不改动角色卡/聊天/世界书内容,secrets 始终携带。细节见
`.trellis/tasks/09-01-cross-tavern-datapack/research/platform-facts.md`。

## 安装

```bash
npm install        # 依赖 yauzl/yazl,纯 JS,无原生编译
```

Termux(安卓):

```bash
pkg install nodejs-lts
# 然后 npm install 同上
```

## 用法

```bash
# 转换(L 导出包 → PT 可导入的 TT 布局包)
node cli.js default-user-xxxx.zip --to pt

# 只看识别结果
node cli.js detect tauritavern-data-xxxx.zip

# 只出报告不写文件
node cli.js xxx.zip --to tt --dry-run

# 机器可读报告(JSON,含峰值内存)
node cli.js xxx.zip --to l --json

# 保留派生缓存与 TT 私有目录(默认丢弃并在报告列明)
node cli.js xxx.zip --to st --keep-all
```

`--to` 目标:

| 目标 | 产物 | 平台侧如何导入 |
|---|---|---|
| `st` | 摊平用户目录包(+ `_convert/INSTALL.md` 说明) | ST 无整包导入,解压覆盖到 `data/<handle>/`(先备份) |
| `l` | 摊平 + `manifest.json` | L 内"恢复备份"选择该 zip,类目全选 |
| `tt` | `data/default-user/` 布局 | TT 导入(三种布局策略自动识别) |
| `pt` | TT 布局 + 合成的 `extension-sources` 来源记录 | PT 数据导入(选 TT 迁移包) |

## 安全说明

- 本工具**不剥离 secrets.json**(用户明确要求);产物含 API 密钥,请勿外传。
- 从 PT 目标包导入后,扩展来源记录会让 PT 走"正常安装"通道;没有来源且 manifest
  无 https homePage 的扩展,PT 会跳过并在导入报告里提示重装(PT 的设计行为)。

## 已验证(2026-09-02,真实数据包)

- 964 MiB L 包与 162 MiB TT 包,8 个方向实转全过
- secrets 字节一致;条目数与转换报告吻合
- 峰值内存 74-250 MiB(手机可用量级)
- `npm test`:32 个单测(含 PT/L 导入路由镜像断言)

## 路线

- [x] CLI 全矩阵(`--to st|l|tt|pt`)
- [ ] L 平台内插件(导出为其余平台格式;调研见任务 research/plugin-feasibility.md)
- [ ] ST 插件(受平台端点限制,secrets 需 CLI 补齐)
