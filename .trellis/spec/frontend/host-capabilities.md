# Host Capabilities (宿主能力对接规范)

> 本文件从 `component-guidelines.md` 拆出（2026-09-25）——原文件已达 36.7 KB，
> 超过 Trellis `context_injection.max_file_bytes`（32768），继续增长会被**静默截断**
> （即 P-2 那类「截断比不同步更糟」）。宿主能力对接与「组件注入/样式作用域」是不同主题，
> 拆开后两份都远低于上限。
>
> 适用：**任何**要调用宿主能力的场合。相关但不在此文件：宿主 DOM 注入的幂等/自愈语义、
> 注入按钮工厂、CSS 作用域铁律 → 见 [`component-guidelines.md`](./component-guidelines.md)。

---

## Host Native Dialog Adapter (宿主原生弹窗适配器 · 2026-09-25)

### 1. Scope / Trigger

新增或改动任何**确认/输入类对话框**。宿主的原生弹窗与 `window.confirm` 外观、模态层级、键盘行为都不同，
混用会让插件在酒馆里显得「不是酒馆的一部分」。

### 2. Signature

```js
// src/ui/host-bridge.js
export async function confirmDialog(message: string): Promise<boolean>
```

### 3. Contract

- **取能力的唯一合法路径是官方文档记载的上下文对象**：

  ```js
  const ctx = globalThis.SillyTavern?.getContext?.();
  ctx.Popup.show.confirm(header, text)   // → Promise<POPUP_RESULT|null>
  ctx.POPUP_RESULT.AFFIRMATIVE            // === 1
  ```

  据 `docs.sillytavern.app`（Writing Extensions）与两仓源码：
  ST 的 `public/scripts/st-context.js:225` 与 Luker 的 `public/scripts/st-context.js:2663` 都把
  `Popup` / `POPUP_TYPE` / `POPUP_RESULT` 挂在 `getContext()` 上；
  `Popup.show = showPopupHelper`（ST/Luker 的 `public/scripts/popup.js:858`），其 `confirm(header, text, popupOptions)`。
- **不需要、也不要动态 `import()` 宿主模块**：`getContext()` 已经给出全部所需能力。
- 判定式：`result === ctx.POPUP_RESULT.AFFIRMATIVE`；返回 `null`（用户直接关闭弹窗）视为**取消**。
- 标题用插件功能名 `数据包互转`（`CONFIRM_DIALOG_TITLE`），不写解释性文案（R4）。

### 4. Validation & Error Matrix

| 条件 | 行为 |
| --- | --- |
| `Popup.show.confirm` 为函数 **且** `POPUP_RESULT.AFFIRMATIVE` 存在 | 走宿主原生弹窗，`result === AFFIRMATIVE` → `true` |
| 原生返回 `null` / `NEGATIVE`(0) | `false` |
| `POPUP_RESULT` 缺失 | **降级**（不猜常量值——宿主分支间可能不同） |
| `getContext()` 抛错（宿主脚本未就绪） | 捕获 → **降级** |
| 原生弹窗调用抛错 | `console.warn` 后**降级**，绝不上抛给调用方 |
| `window.confirm` 也不可用（纯 Node） | 返回 `true`，不阻断调用方 |

### 5. Cases

- **Good**：8004 Luker 2.7.0 真机取证——`getContext().Popup.show.confirm` 为 `function`、
  `AFFIRMATIVE = 1`、真实唤起后点「取消」返回 `0` 且 promise settle → 适配器映射 `false`。
- **Base**：独立 Web 态（无 `SillyTavern`）→ 直接走 `window.confirm`。
- **Bad**：把 `POPUP_RESULT.AFFIRMATIVE` 硬编码成 `1`，或假设「必须动态 import `popup.js`」而放弃原生路径。

### 6. Tests Required

`test/confirm-dialog.test.js`（7 用例，`globalThis.SillyTavern` 桩 + 可写 `globalThis.window`）断言：
原生返回 AFFIRMATIVE → `true`；返回 `0` / `null` → `false`；无宿主 → `window.confirm` 且**原文案透传**；
原生抛错 → 降级且不抛；`POPUP_RESULT` 缺失 → **不调用**宿主 confirm；双不可用 → `true`；`getContext` 抛错 → 降级。

### 7. Wrong vs Correct

#### Wrong —— 裸用 `confirm()`（组件层直接调）

```js
// src/ui/stash-list.js（旧写法）
if (!confirm(`确定删除选中的 ${selected.size} 个源包吗？`)) return;
```

问题：独立态/插件态外观割裂；且组件无法脱离宿主单测。

#### Correct —— 适配器 + DI 接缝

```js
// 组件层：只声明接缝，未注入时自行降级，保持可单测
const askConfirm = typeof confirmFn === 'function'
  ? confirmFn
  : (msg) => Promise.resolve(typeof window !== 'undefined' ? window.confirm(msg) : true);
if (!(await askConfirm(`确定删除选中的 ${selected.size} 个源包吗？`))) return;

// 调用方（index.js）：注入 host-bridge 的实现
renderStashList({ /* … */ confirmFn: confirmDialog });
```

**当前接入面（4 处，改动确认 UI 时须一并检查）**：
`src/ui/stash-list.js` 批量删除与行内删除、`src/ui/export-queue.js` 「清空」与「取消在途恢复」。
自查命令（应只剩适配器内部与已知死代码）：

```bash
grep -rn "[^a-zA-Z.]confirm(" src/ui/*.js index.js
```

> **注意**：`src/ui/archive-manager.js:188` 还有一处裸 `confirm()`，但该文件**全仓无引用**（死代码，
> 仅被陈旧产物 `dist/index.html` 的注释提到）——不要把它当作可用参考实现。已另行登记处置。

---

## Host Capability Acquisition (宿主能力获取决策树 · 2026-09-25)

> 定稿于任务 `09-25-luker-native-integration`。适用于**任何**要调用宿主能力的场合。
> 与上一节（Host Native Dialog Adapter）的区别：那节讲「确认对话框」这一具体能力，
> 本节讲**取任何宿主能力的统一路径**，避免每次重新发明。

### 1. 决策树（顺序不可颠倒）

```
取宿主能力
 ├─ 1. globalThis.SillyTavern?.getContext?.()        ← 官方文档路径，**优先**
 └─ 2. 仅当 getContext() 确实未暴露该能力时：
        动态 import('<宿主根绝对路径>')
        · 必须在该行上方注释写明「为何不能走 getContext」+ 实测证据（HTTP 状态码 / 体积）
 └─ 3. 都不可用 → 静默降级（返回 false/null，调用方无需分支）
```

**第二类路径只允许「已注明理由的根绝对路径 import」**——出现任何第三类取法（相对路径
`import()`、猜 `window.xxx` 全局、读宿主源码内部变量）都属违规。

### 2. 根绝对路径为何跨宿主可用

宿主把 `public/` 挂在**站点根**，故 `/scripts/<module>.js` 与插件自身安装位置无关：
ST 装在 `public/scripts/extensions/third-party/**`、Luker 装在 `data/<user>/extensions/**`（平铺），
两者都能取到同一个 URL。实测 `GET https://127.0.0.1:8003/scripts/storage-inspector.js` → **HTTP 200 / 16.4KB**。

**相对路径 `import()` 不可靠**：它随宿主安装形态变化而失效，且四个宿主的插件目录深度不同。

### 3. 形状校验优先于「加载成功」

```js
// src/ui/host-bridge.js
export function hasStorageInspector(mod) {
  return typeof mod?.openStorageInspector === 'function';
}
```

判据必须是「**导出确实是函数**」而非「模块能加载」——只判加载成功会让调用方解除
按钮隐藏后点了没反应，变成**死按钮**。宿主版本升级后导出名可能变化，这一层就是防线。

### 4. 降级反例的正确构造法（**踩过的坑**）

做「模块不可用 → 正确降级」的真机反例时，**不要用 Playwright `route` 把宿主模块 404 掉**：

- 实测：`/scripts/storage-inspector.js` 是**宿主自身的静态依赖**
  （Luker `user.js:17`、`browser-storage-inspector.js:6` 均 `import` 它）。
  404 会让**Luker 自己崩掉**，插件根本不会挂载——测到的是宿主故障，不是本插件降级。
  实测该模式下 `settingsBlock` / `drawerApp` / `statusRow` 全为 `false`。
- **正确做法**：fulfill 一个「**能加载但导出非函数**」的桩，且必须把宿主所需的
  全部命名导出补齐、`contentType` 设为 `text/javascript`：

  ```js
  const stub = 'export const openStorageInspector = null;\n'
             + 'export const mountStorageInspector = null;\n'
             + 'export const createStorageInspector = null;\n';
  await page.route('**/scripts/storage-inspector.js', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: stub }));
  ```

  这样宿主自身照常启动，只让**我们的形状校验**走到降级分支——实测按钮保持 `hidden`、
  点击不唤起、页面不报错。
- **附带结论**：`storage-inspector.js` **仅 Luker 有**（ST / TauriTavern / PureTavern 均无此文件，
  已用 GitHub API 逐个核实）。因此在 Luker 上「模块 404」这条路径**不可能发生**，
  该降级分支实际是为**非 Luker 宿主**准备的。

### 5. 现存宿主能力面与获取方式（逐个取证）

| 能力 | 获取方式 | 备注 |
| --- | --- | --- |
| 确认对话框 | `getContext().Popup.show.confirm(header, text)` | 官方文档路径；见上一节 |
| 存储面板 | **根绝对路径** `import('/scripts/storage-inspector.js')` → `openStorageInspector({ kind: 'self' })` | 无 window 挂载、`getContext()` 未暴露；`dataSource` 形状见宿主 JSDoc：`{kind:'self'}` 或 `{kind:'any',target}`；面板 mutator 为 `ThrowingMutator`（**只读**） |
| 扩展安装器 | `getContext().openThirdPartyExtensionMenu(suggestUrl?)` | **单 URL 语义**；宿主**无「列出全部扩展」API**、**无原生删除 UI**（`deleteExtension` 只是 API） |
| 扩展 manifest | `getContext().getExtensionManifest(name)` | 接受短名或 `third-party/<name>`；返回深拷贝或 `null` |
| 跨扩展 API | `getContext().getExtensionApi(name)` / `registerExtensionApi(name, api)` | 本仓暂不需要 |

### 6. 宿主能力差异用「显式声明表」，禁止布尔推导

```js
// src/ui/host-bridge.js
const BACKUP_SELECTION_SUPPORT = Object.freeze({ st: false, luker: true, tt: false, pt: false });

export function hostSelectionCapability(platform) {
  const declared = BACKUP_SELECTION_SUPPORT[platform];
  return {
    supported: declared === true,
    known: declared !== undefined,        // 区分「确认不支持」与「未取证」
    reason: declared === true ? '宿主透传勾选' : '全量导出后插件内过滤',   // 状态读数
  };
}
```

**为何禁止 `platform === 'luker'` 这类推导**：新增宿主时会**静默**走入错误分支，
且无法区分「确认不支持」与「没验过」。`known: false` 让调用方知情；
未列出的宿主一律走**保守路径**（结果正确，只是多传字节），绝不乐观放行。
`reason` 是状态读数（非解释性文案），可直接展示——受用户裁决 12 约束，不要写成解释句。

---

## UI 控件的合宪性：任何控件必须有消费点（2026-09-25）

> 定稿于任务 `09-25-transfer-pack-optimize`。**新增 UI 控件前先问：谁读它的值？**

`#incremental-mode-check`（「增量合并」）曾长期存在于 J 区，但取证发现
**没有任何代码读取它的 `.checked`**——勾选它只让折叠摘要多出四个字，**行为零变化**。
它还与「差量补丁」及恢复写入的 `mode: 'merge'` 三者撞名，最终被移除。

### 判定「死控件」的取证方法（三步，缺一不可）

1. **查值读取点**：`grep` 控件 id —— 若只出现在「元素查找 / 摘要文字 / change 监听」三处，
   而没有 `?.checked` 或 `.value` 的**读取**，高度可疑；
2. **排除泛读**：确认全仓没有 `querySelectorAll('input[type=checkbox]')` 这类
   批量读取后再统一处理的代码（本仓为零命中）；
3. **排除持久化**：确认它不在工作区状态保存/恢复的字段里
   （`grep -n <flag> src/ui/*.js src/storage/*.js`）。

三条都排除后，才能判定为死控件。**不要只凭「搜不到引用」就下结论**——
引用可能藏在批量读取或状态恢复里。

### 处置约定

- **移除控件本身 + 同步 `REQUIRED_TEMPLATE_IDS`**（否则 `check:template-source` 必失败）；
- **不删其未接线的实现**：在实现处加「⚠ 未接线：无任何调用方」+ 接线前置条件，
  避免后来者误以为功能已上线（先例：`incrementalMergeArchives()`）；
- **加反向断言**防复活：三个位置（模板 / `REQUIRED_TEMPLATE_IDS` / `index.html`）
  任一出现该 id 即测试失败，写法见 `test/single-template-source.test.js`。

### 概念撞名禁令

**同一 UI 内不得出现同名异义的概念**，日志与进度文案同受此约束。
消歧改动**只动中文展示名，协议值一字不动**——例如恢复写入的
`mode: 'merge' | 'overwrite'` 是宿主端点契约，改名只限「合并写入 / 覆盖写入」这类展示文案。

### 文档不要写死节点数

「三态各产出 N 个必需节点」中的 N 由 `scripts/single-template-source.js` 的
`REQUIRED_TEMPLATE_IDS` 决定。**spec 与文档里不要写死数字**——否则每次增删节点
都要回头改一遍文档，且极易漏改（本项目已发生一次：41 → 40）。
