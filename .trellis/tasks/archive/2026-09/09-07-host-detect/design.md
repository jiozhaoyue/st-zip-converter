# 技术设计：宿主精确识别与 Luker UI 异常排查

## 1. detectHost 重写（src/ui/host-bridge.js）

### 现状（缺陷）

```js
// 第 28-35 行：window.luker 与 #luker-app 在 Luker 实例中均不存在 → 恒 false
// window.SillyTavern 两实例均存在 → Luker 恒被判为 st
```

### 新判定协议

```js
export function detectHost() {
  // 1. Luker 专属信号优先：globalThis.lukerContext（Luker public/script.js:313-316 发布）
  //    注意惰性 getter：typeof 读取会触发 getContext()，需 try/catch
  let lukerCtx = null;
  try {
    lukerCtx = (typeof globalThis.lukerContext === 'object' && globalThis.lukerContext) || null;
  } catch { /* getter 未就绪，忽略 */ }
  if (lukerCtx) return { platform: 'luker', isPlugin: true, confidence: 'frontend' };

  // 2. ST 信号：globalThis.SillyTavern（两实例都有，但走到这里说明 lukerContext 不在 → st）
  if (typeof globalThis.SillyTavern !== 'undefined') return { platform: 'st', isPlugin: true, confidence: 'frontend' };

  // 3. 独立模式
  return { platform: 'standalone', isPlugin: false, confidence: 'none' };
}
```

- `#extensionsMenu` DOM 信号保留为辅助（ST 也有）；`#luker-app`、`window.luker` 死信号删除。
- `confidence` 字段供日志与 verifyHostPlatform 决策使用。

### verifyHostPlatform()（新增异步校验）

```js
export async function verifyHostPlatform(platform) {
  // GET /version → { version } (假设：ST 与 Luker 均实现；须 Playwright 实测)
  // 实测结论回填 research/host-detection-and-luker-ui.md
  // 策略：
  //   端点可达 → 比对版本号特征（Luker 2.x vs ST 1.x 不可靠，改用响应形状/字段特征，
  //              或 Luker 特有端点探测如 lukerContext 相关 API —— 以实测为准）
  //   端点不可达 → 保留前端判定，logger.info 记录跳过原因
  //   结果冲突 → 以端点为准 + logger.warn
}
```

- 实测前不硬编码版本判断规则；implement 阶段先跑 Playwright 探测，把响应样本记入 research 再定实现。
- 调用点：`index.js` 初始化（第 405-445 行宿主环境识别段）在 `detectHost()` 后异步调用，更新徽标与 `host.platform`。

### 导出后软校验（fetchHostBackup 内）

- 拿到 blob 后用 `zipIo.openReader` 只扫第一个条目名（中央目录零拷贝，inspect.js 已有该模式）：
  - platform='luker' 且无 manifest.json → warn。
  - platform='st' 且有 manifest.json → warn。
- 校验失败不阻断流程，仅告警。

## 2. 宿主能力适配

### ST 全量导出 + 插件内过滤

```
ST 宿主: fetchHostBackup('st') → 全量 zip（端点忽略 selection）
       → transform(blob, { targetLayout: 'st', selection })  // 插件内类目过滤
       → 待导出区
Luker 宿主: fetchHostBackup('luker', selection) → 端点侧过滤 → 原生直出
```

- UI 文案：ST 宿主下类目面板标注"过滤在导出后由插件执行（ST 端点仅支持全量导出）"。
- 复用 transform.js 现有 selection 过滤路径（与外部互转同一代码，满足解耦复用要求）。
- 备份聊天过滤（backups/ 默认剔除）在 ST 路径同样走插件过滤，行为与现状一致。

### 恢复路径

- `restoreToHost(zip, { platform })`：Luker → platform 'l'；确认 Luker `/api/users/restore` 对 FormData 字段（handle/mode/incremental）的接受度与 ST 一致（实测确认，差异记入 research）。

## 3. Luker UI 异常排查方案

1. Playwright 连接本地 Luker 实例 → 未启用插件基线截图 + computedStyle 抽样（body、按钮、输入框、滚动条）。
2. 通过 Git 安装本插件（实例侧只读，安装走扩展管理器或克隆到扩展目录由用户/流程完成——遵循"禁止直接写入实例目录"，Playwright 测试用临时 profile + 扩展管理器安装，或注入测试脚本模拟）。
   - 备选（首选）：不安装，直接在 Playwright 中 evaluate 注入插件 CSS/JS 到页面，观察样式变化——可完全复现"插件污染宿主"类问题。
3. diff 前后样式表规则命中数，定位冲突选择器。
4. 修复：`src/style.css` 所有规则收窄到插件根容器选择器前缀（如 `#st-zip-converter-root` 或现有挂载点 id）；全局 reset 类规则移除或作用域化。
5. 宿主侧根因（若与插件无关）→ 输出 `research/luker-ui-anomaly-report.md`，不动实例。

## 4. 测试设计

- `test/detect-host.test.js`（新）：
  - mock globalThis 组合矩阵：{lukerContext} → luker；{SillyTavern} → st；{lukerContext+SillyTavern} → luker；{} → standalone。
  - lukerContext getter 抛错 → 回退 st（若 SillyTavern 存在）。
- Playwright（`tests/e2e/` 或 scripts/，不进 npm test）：
  - `host-detect.spec.js`：双实例 platform 断言 + `/version` 探测样本采集。
  - `luker-ui-anomaly.spec.js`：注入前后快照 diff。

## 5. 兼容与回滚

- 纯插件侧改动，无数据迁移。
- 回滚点：单 commit，revert 即可。
- 对 ui-unify 的影响：`host.platform` 语义修正后，ui-unify 的统一工作台宿主分支（R2 的 ST 过滤路径）才可靠——这是排序 host-detect 在前的原因。
