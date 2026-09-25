# 执行清单：8004 实测诊断

> 复选框**随执行实时勾选**（L0-2）。任一阶段失败先落盘部分结果再重试，不空等。
> 全程只读（R1）；脚本一律落 `.trellis/tasks/09-25-live-perf-diagnosis/research/`。

## 阶段 A · 环境与会话准备

- [x] A1 确认 8004 可达且 `GET /version` 返回 Luker 形状；记录 gitRevision 与时间戳
      → Luker 2.7.0 / release / `239b329ea` / 2026-09-06；**8001/8002/8003 全部无响应，现场仅 8004**
- [x] A2 确认插件已加载：`1` 个 `.st-converter-drawer-app`（`#app`）、`#usage-dashboard` ×1、`#env-badge` ×1、`#log-console-mount` ×1；扩展菜单项「数据包互转工坊」存在
- [x] A3 建 Playwright 会话：`launchPersistentContext` + `ignoreHTTPSErrors`，profile 用项目根 `.pw-profile/`（已在 `.gitignore`）
      → 计划中的 `research/` 子目录未采用，改用仓库既有约定路径
- [x] A4 盘点脚本 `pw-a1-survey.cjs` 完成：DOM 21886 / 样式表 137 / 总规则 10760 / 插件规则 365 / 运行中动画 0

## 阶段 B · 基线采样（插件未介入）

- [x] B1 空闲采样：v1 发现窗口覆盖页面加载期（8142ms 长任务、DOM 15k→93k）→ **方法学缺陷，v2 改为先等静止**
- [x] B2 关闭态基线：**15 个 longtask / 3567ms / 最长 912ms；script 0.6129s；宿主 DOM 变动 4520 次 / 80 批**
- [x] B3 非插件嫌疑源点名：`runRegexScript`(宿主正则 102.7ms/10s)、`serializeFrontendLogValue`(宿主日志 43.7ms)、`cloneJsonValue`×2、`getMeasurableMes`(st-acu-visualizer)、`updateIconDisplay`(QR)

## 阶段 C · 插件介入采样

- [x] C1 展开态采样：**0 个 longtask；script 0.0148s；DOM 变动 0 次**（页面已静止，反比关闭态更安静）
- [x] C2 关闭 vs 展开对照表（见 `research/live-report.md` §1）
      → 注意：常规使用中 `#rm_extensions_block` 为 `closedDrawer` + `display:none`，**插件 UI 并不渲染**；对照需诊断性打开面板
- [x] C3 插件注入节点规模：**276 节点 / 36 按钮（可见 13）/ 19 输入控件 / 面板高 1237px**
- [x] C4 MutationObserver 触发条件确认：4 个回调中 3 个 `getElementById` 早退、1 个全文档 `querySelectorAll('.userBackupButton')`
      → **41 次触发在 100µs 采样粒度下 0 次被采到**（亚毫秒级）
- [x] C5 自愈成本：**函数级 Profile 判定为 0ms**；早期「7.86ms/次」的对照设计有缺陷（`detached` 组不触发任何 observer），已作废并记录为方法学教训

## 阶段 D · 归因与结论

- [x] D1 三类归因占比表：启动期 **插件 0.05%**（8ms/16866.5ms）；刺激期 **插件 0%**（0ms/1829.2ms）；交互期 **插件 0.06%**（0.32ms/566.78ms）
- [x] D2 逐条复核 09-07 结论（见 `research/live-report.md` §2）：强化「与插件无关」结论；传输期未复测并如实声明
- [x] D3 卡顿源点名定位：`esm.sh/@chenglou/pretext@0.0.9`（**≈3700ms**，第三方扩展 CDN 依赖）、宿主 `frontend-log-manager.js:25`（1438.5ms）、`script.js:11727`、`regex/engine.js:901`、`st-acu-visualizer/index.js:3566`、`QR/settings.js:57`
- [x] D4 产出 `research/live-report.md`（原始数据 + 对照 + 结论 + 证据链 + 诚实声明未做项）

## 阶段 E · 止血建议清单（交用户逐项裁决）

- [x] E1 建议清单 G-01 ~ G-05 写入 `research/live-report.md` §4（含问题锚点 / 改动面 / 预期收益 / 风险 / 降级方式）
- [x] E2 **用户已逐项确认**（2026-09-25 两轮交互问答）：性能→补测传输期（已完成）；UI 方向→原地精简+原生化；范围→四项全做；任务结构→父+子；配额→入口按钮唤起原生弹窗；文案→只清解释性静态文案；首屏常驻→仅类目选择 G；双入口→并入本任务
- [x] E3 获批项**转由子任务承接**（本任务不改 `src/**`）：
      · UI 精简/去特效/按钮解耦 → `09-25-ui-slim-native`
      · Luker 原生对接（Storage Inspector 等）→ `09-25-luker-native-integration`
      · 传输期与打包优化（含 `index.js:829` 进度条恒 18% 缺陷）→ `09-25-transfer-pack-optimize`

## 交付物

| 产物 | 路径 |
| --- | --- |
| 诊断报告 | `research/live-report.md` |
| 采样脚本 | `research/pw-{a1,bc,bc2,d1,e1,f1,g1,h1,h2}-*.cjs` |
| 原始采样数据 | `research/*.json`（**已 gitignore**：含实例侧真实数据风险，L1-MR-14） |

## 验证命令

```bash
npx --no-install playwright --version     # 1.62.1，不安装
curl -k https://127.0.0.1:8004/version    # 只读，确认宿主形状
npm test                                  # 仅实施阶段需要
npm run check:css-scope && npm run check:dom-injection
```

## 回滚点

- 本任务原则上**不改 `src/**`**；若 E3 获批改动，回滚点 = 改动前的 git 提交（`059257e`）。
