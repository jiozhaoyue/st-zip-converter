# 执行计划：宿主精确识别与 Luker UI 异常排查

## 前置

- [ ] Playwright 可用性确认（npx playwright --version；不可用则 npm i -D playwright + npx playwright install chromium）
- [ ] 双实例运行方式确认（Instance/Real/SillyTavern 与 Instance/Real/Luker 的启动端口；只读访问，不改实例）

## Phase 1：实测探测（design 假设验证）

- [ ] 1.1 Playwright 脚本探测 ST 实例：`GET /version` 响应形状、`globalThis.SillyTavern` 形状、特征端点清单 → 记入 `research/st-host-probe.md`
- [ ] 1.2 同上探测 Luker 实例：`/version`、`globalThis.lukerContext`、Luker 特有端点 → 记入 `research/luker-host-probe.md`
- [ ] 1.3 Luker UI 异常快照：注入插件 CSS 前后样式 diff，定位冲突选择器 → 记入 `research/luker-ui-anomaly-report.md`
- [ ] ⛓ 评审门：探测结论固化后才进入 Phase 2（若 /version 假设不成立，先修订 design.md §verifyHostPlatform）

## Phase 2：detectHost 重写

- [ ] 2.1 重写 `src/ui/host-bridge.js` `detectHost()`（按 design §1 协议，删死信号，加 confidence）
- [ ] 2.2 新增 `verifyHostPlatform()`（按 Phase 1 实测结论实现版本/端点特征比对）
- [ ] 2.3 fetchHostBackup 增加导出后软校验（manifest.json 有无 vs platform）
- [ ] 2.4 index.js 初始化链路接入 verifyHostPlatform，徽标/日志/默认目标格式（'luker'→'l'）跟随修正
- [ ] 2.5 新增 `test/detect-host.test.js` 判定矩阵单测

## Phase 3：宿主能力适配

- [ ] 3.1 ST 宿主路径：全量拉回 + 插件内 selection 过滤（复用 transform.js），UI 标注说明
- [ ] 3.2 Luker 宿主路径：selection 透传测试锁定（mock 端点单测）
- [ ] 3.3 restoreToHost 双平台 FormData 差异实测确认（research 记录），必要时修正

## Phase 4：Luker UI 异常修复

- [ ] 4.1 按 Phase 1.3 定位结果作用域化 `src/style.css`（收窄到插件根容器前缀）
- [ ] 4.2 Playwright 复测：注入后 diff 归零/仅剩预期差异

## Phase 5：验证与交付

- [ ] 5.1 `npm test` 全绿（105 项 + 新增）
- [ ] 5.2 `npm run build` 无报错
- [ ] 5.3 Playwright 双实例终验：platform 识别正确、导出包形状正确、UI 异常消失
- [ ] 5.4 spec 更新判断（trellis-update-spec）：宿主识别协议写入 .trellis/spec/guides/ 或 frontend 规范
- [ ] 5.5 提交（batched commit 计划 → 用户确认）→ 推送 origin/main

## 回滚点

- 每个 Phase 一个 commit 粒度；Phase 2 为核心，回滚 revert 该 commit 即可。

## 验证命令

```bash
npm test
npm run build
npx playwright test tests/e2e/host-detect.spec.js   # 双实例需本地起服务
```
