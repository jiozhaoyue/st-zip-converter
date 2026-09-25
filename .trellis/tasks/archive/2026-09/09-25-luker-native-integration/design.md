# 技术设计：Luker 原生能力对接（T3）

## 1. 边界

**改动面**：`src/ui/host-bridge.js`（宿主适配器：全部新增能力落此处，L0-9）、
`src/ui/usage-dashboard.js`（配额读数降级路径）、`index.js`（接线）、
可能新增 `src/ui/host-storage-inspector.js`（若 `host-bridge.js` 已过大则单独成模块）。
**不动**：`src/core/**`（转换/打包/分卷逻辑）、`src/storage/**`、`src/vendor/**`。
**不引入**：新依赖、UI 框架、外部 CDN（G6 / R5.5）。

## 2. 宿主能力获取策略（R5.2）

**唯一决策树**（顺序不可颠倒）：

```
取宿主能力
 ├─ 1. globalThis.SillyTavern?.getContext?.()  ← 官方文档路径，优先
 │      · 弹窗面：Popup / POPUP_TYPE / POPUP_RESULT（T2 已用）
 │      · 扩展管理面：openThirdPartyExtensionMenu / getExtensionManifest / extension_settings
 │      · 其它：accountStorage / storage
 └─ 2. 仅当 getContext() 未暴露该能力时：
        动态 import('<宿主根绝对路径>')
        · ①存储 Inspector：import('/scripts/storage-inspector.js')
        · 必须在该行上方注释写明「为何不能走 getContext」+ 实测证据（HTTP 200）
 └─ 3. 都不可用 → 静默降级（返回 false/null，调用方无需分支）
```

**为何根绝对路径可行**：Luker/ST 把 `public/` 挂在站点根，实测
`GET https://127.0.0.1:8003/scripts/storage-inspector.js` → **HTTP 200**。
该路径与插件安装位置无关（ST 在 `public/scripts/extensions/third-party/**`、
Luker 在 `data/<user>/extensions/**` 均可），故优于相对路径 `import()`——
后者随宿主安装形态变化而失效。

**已知不确定**：`openStorageInspector(dataSource)` 的 `dataSource` 形状未取证。
设计上把「取模块」与「取 dataSource」分开：取模块成功但构造 dataSource 失败时，
仍按降级处理（保持按钮隐藏），不得抛出到调用方。

## 3. ① 存储配额接线

### 现状（T2 留下）

`workbench-template.js:51` 已有：

```html
<button type="button" class="menu_button menu_button_icon wb-storage-btn"
        id="btn-storage-inspector" hidden>
  <i class="fa-solid fa-hard-drive"></i><span>存储</span>
</button>
```

仅抽屉态渲染（`isDrawer`），**默认 `hidden`**。

### 目标

```js
// src/ui/host-bridge.js
/**
 * 宿主原生存储面板入口适配器。
 * 优先 getContext()（Luker 未暴露 storage inspector）；
 * 未暴露时经**宿主根绝对路径**动态 import——实测 /scripts/storage-inspector.js HTTP 200。
 * @returns {Promise<boolean>} 能力是否可用（决定按钮是否解除 hidden）
 */
export async function isStorageInspectorAvailable()

/**
 * 唤起宿主原生存储面板。
 * @returns {Promise<boolean>} 是否成功唤起
 */
export async function openStorageInspector()
```

- `index.js` 在抽屉挂载后调用一次 `isStorageInspectorAvailable()`；为真才解除 `hidden`。
- 点击 `#btn-storage-inspector` → `openStorageInspector()`；返回 `false` 时保持静默
  （按钮本就不该可见，故无需用户可见报错）。
- **不得**在不可用时恢复自绘配额条（R1.3）。

## 4. ② 备份管理器真机确证

T2 探针点过 `#user-settings-button` / `#sys-settings-button` / `#extensionsMenuButton` /
`#user-settings-block`（`research/pw-probe-anchors.cjs`），`.userBackupButton` 计数始终为 0。
本任务需**先取证再改代码**：

1. 在 Dev 8003 用 Playwright 枚举页面上所有可见的可点击入口，逐步展开，定位
   `.userBackupButton` / `.userBackupManager .backupActionRow` 的真实出现条件；
2. 记录「进入路径」（点击哪些元素、需要哪些先后顺序）；
3. 据此修正 `mountNativeBackupButton` 的注释与锚点假设（R2.2）；
4. 若确证「该锚点在此宿主版本下根本不存在」→ 记录结论并把该注入点标为**宿主版本相关**，
   不得留「看起来在工作实则永不触发」的代码而无说明。

## 5. ③ 扩展管理：只做盘点（R3）

本任务**不实施替换**。产出 `research/extension-manager-surfaces.md`，覆盖：

| 待盘点 | 问题 |
| --- | --- |
| `openThirdPartyExtensionMenu()` | 打开的是哪个弹层？能否带参定位到某个扩展？是否只读？ |
| `getExtensionManifest(name)` | 返回结构；与插件自绘的 `buildExtensionManifest`（`src/core/extension-manifest.js`）是否重叠 |
| `getExtensionApi` / `registerExtensionApi` | 跨扩展 API 注册表；插件能否用它消费/暴露能力 |
| `extension_settings` | 与插件自己的 `data/default-user/settings.json` 读写面是否冲突 |
| 自绘 `discover/install/delete` | 哪些可替换、哪些必须保留（如跨实例迁移需要「装到当前实例」） |

**R3.3 硬约束**：`third-party/third-party` 嵌套异常探测是 L1-MR-12 事故防线，无论结论如何都保留。

## 6. ④ selection 语义显式化

现状：`index.js` 依 `hostSupportsSelection` 布尔决定是否走转换过滤，推导散落。

目标：在 `host-bridge.js` 以**数据表**表达，单一求值点：

```js
/** 宿主平台码 → 是否支持 /api/users/backup 的 selection 透传（显式声明，非推导） */
const BACKUP_SELECTION_SUPPORT = Object.freeze({ st: false, luker: true, tt: false, pt: false });

export function hostSelectionCapability(platform) {
  const supported = BACKUP_SELECTION_SUPPORT[platform];
  return {
    supported: supported === true,
    // 状态读数（非解释性文案）：UI 可直接展示
    reason: supported === true ? '宿主透传勾选' : '全量导出后插件内过滤',
    known: supported !== undefined,   // 未知宿主 → known:false，走保守路径（全量 + 过滤）
  };
}
```

- **未知宿主必须走保守路径**（`supported: false`），与现状一致。
- 单测覆盖 `st` / `luker` / `tt` / `pt` / 未知 五态。

## 7. 兼容性与回滚

| 风险 | 缓解 |
| --- | --- |
| 动态 `import()` 根绝对路径在非 ST 系宿主（TauriTavern / PureTavern）404 | `import()` 包 try/catch，失败即降级；不阻断主路径 |
| 宿主版本升级后 `/scripts/storage-inspector.js` 路径或导出名变化 | 特性检测到「导出不是函数」即降级；不假设导出一定存在 |
| ② 确证结论可能推翻 T2 的锚点假设 | 先取证后改注释；若锚点不存在，如实记录而非硬改选择器 |
| ③ 盘点结论可能指向大改 | 本任务只出建议，实施留待第二道门禁 |

**回滚点**：改动前分支 tip `90c360d`；全部改动集中在 `host-bridge.js` +
接线，回滚即 `git revert` 对应提交。

## 8. 与其它任务的接缝

- **T2 遗留**：② 的真机确证、① 的按钮行为，均在本任务闭环。
- **T4（`09-25-transfer-pack-optimize`）**：④ 的显式化是 T4「上下传链路收敛」的输入——
  本任务只把语义显式化，不改默认值/流程。
- **父任务 AC**：「Luker 原生对接项在非 Luker 宿主或端点不可达时静默降级，
  主路径功能不缺失（有测试或实机证据）」——由 R5.1 + 各对接面的降级测试满足。
