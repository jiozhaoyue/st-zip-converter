# Host DOM Write Scope（宿主 DOM 写入作用域 · 2026-09-26）

> 与 [`component-guidelines.md`](./component-guidelines.md) 的「CSS Scoping Mandate」是**互补**的两件事：
> CSS 守卫管「样式不许越界」，本页管**「往宿主 DOM 里写东西不许没交代」**。
> 本页自包含：所有读数与 file:line 内联在此。**注意** `.gitignore:57` 排除了
> `.trellis/tasks/**/research/*.json`，所以原始读数 JSON 不进库——**数字必须写在文档里**，
> 不得写成"详见任务目录的 xxx.json"（那在别的机器上就是悬空引用）。

## 1. Scope / Trigger

新增或改动**任何往宿主页面写 DOM 的代码**时读本页：注入宿主 UI 的入口按钮/面板、
挂到 `document.body` 的自绘浮层、下载用的临时锚点。

## 2. 契约：允许写哪些宿主位置（**穷举**）

| 宿主锚点 | 允许插入的节点 | 代码位置 |
| --- | --- | --- |
| `#extensions_settings2`（或旧版 `#extensions_settings`） | `#st-zip-converter-settings-panel.st-converter-drawer-wrapper` | `src/ui/host-bridge.js` `mountSettingsDrawer()` |
| `#extensionsMenu`（`.list-group` 优先，`#options` 兜底） | `#st-zip-converter-menu-item.list-group-item` | `src/ui/host-bridge.js` `registerMenuButton()` |
| `.userBackupButton` 的父元素（账号弹层 / 管理面板每用户行） | `#st-zip-converter-native-btn` / `-quick-fetch`（`menu_button menu_button_icon`） | `src/ui/host-bridge.js` `mountNativeBackupButton()` |
| `.userBackupManager .backupActionRow` | `#st-zip-converter-luker-manager-btn` | `src/ui/host-bridge.js` `mountLukerBackupManagerButton()` |
| `document.body`（**须显式标记**） | 自绘模态覆盖层、下载用临时 `<a>` | `index.js` 模态、`src/ui/{view,export-queue,stash-list,log-console}.js` 下载锚点 |

**禁止**（任一命中即失败）：往白名单之外的宿主节点 `appendChild`/`insertBefore`/`insertAdjacentHTML`；
对**非本插件节点**做 `setAttribute`/`classList.*`/`style.*`；`removeChild`/`remove()` 删宿主既有节点。

**豁免标记**：语句所在行或其**上一非空行**写 `// dom-scope:allow <理由>`；
整文件写 `dom-scope:allow-file <理由>`。当前真仓只有 6 处标记（4 个下载锚点 + 2 个自绘模态）。

**为什么锚点只授予"插入自己的节点"、不授予"改动锚点本身"**：
运行期判定的首个版本只看「目标在不在锚点上」，于是 `classList.add` 打在 `#extensionsMenu`
上会被判**合规**——等于允许插件改宿主菜单项的 class。已改为按操作类型分开判：
**插入类才看锚点，改动类/删除类只认「目标是不是自己的节点」**。

## 3. 静态守卫 `npm run check:dom-scope`

`scripts/dom-scope.js`（与 `css-scope.js` 同构：`export checkDomScope(code, file)` + CLI + 退出码语义）。
词法扫描屏蔽注释与字符串内容但**保留偏移**，以便回原文取选择器字面量。判定：

1. 写入对象是 `document.body`/`documentElement`/`head` → 需显式标记；
2. 写入对象是 `document.querySelector/getElementById/getElementsBy*` 直接链式调用
   → 选择器字面量必须在 `ANCHOR_SELECTORS` 内（`getElementById` 的 id 归一成 `#id` 再比）；
3. 写入对象是其他任何 `document.*` → 需标记；
4. 写入对象以局部变量起头 → 放行（**刻意的边界**，见下）。

**已知盲区（如实记录）**：模板字面量整体被屏蔽（含 `${}` 内部）；多行链式写法只识别第一段；
`el.style.x = y` 与 `classList` 打在谁身上静态不可判。**这些靠运行期仪器兜**——
静态守卫只负责"别让新的裸写入混进来"，不假装覆盖全部。

## 4. 运行期仪器（真正回答"有没有动别人的元素"）

`.trellis/tasks/09-25-all-instance-plugin-sync/research/pw-dom-write-audit.cjs`
（**注意该目录已归档**；归档后脚本仍在库内，路径随归档移动）：

- 在**任何页面脚本之前**劫持 DOM 写 API（`appendChild`/`insertBefore`/`removeChild`/`replaceChild`/
  `setAttribute`/`removeAttribute`/`Element.remove`/`classList.add|remove|toggle`），
  按**调用栈**把每次写入归属到具体脚本（栈里含 `st-zip-converter` 即判为本插件所为）。
- 分流：插件所为**全量记录**，宿主只计数 + 限量样本（宿主加载期就有两万多次写，共用上限必被吃满）。
- 自带 `--selftest`：把**合成**操作序列喂给同一个判定函数，断言四类违规都能抓到。
  **这一步不可省**——只看真实读数报 0 违规，无法区分"没违规"与"判定失灵"。

### 实测读数（Dev Luker 8003，认证态，2026-09-25/26，插件 `f26dcd5` 与 `1640118` 两版一致）

| 指标 | 读数 |
| --- | --- |
| 整页 DOM 写操作 | **22425**（另一轮 23860） |
| 本插件所为 | **17** |
| ↳ 写自己容器内 | 13 |
| ↳ 写宿主元素 | **4，全部在声明锚点上** |
| ↳ 改动宿主既有节点属性/class | **0** |
| ↳ 删除宿主既有节点 | **0** |
| `style.css` 规则数 / 命中插件容器之外 | **343 / 0** |
| `body` 与 `html` 的 class+内联 style（屏蔽插件 vs 正常加载） | **逐字节相同** |

4 次宿主写入：`#extensions_settings2` ← 设置面板；`#extensionsMenu` ← 菜单项；
账号弹层 `.flex-container` ← `native-btn` / `native-btn-quick-fetch`（`insertBefore`）。

## 5. 仪器自身的坑（复用时别再踩，全部实付过代价）

1. **`home()` 未守卫 DocumentFragment** → `fragment.tagName.toLowerCase()` 抛错，打断 jQuery 的
   IIFE，整页 `jQuery is not defined`（被测插件的行为也被带崩）。**仪器影响被测对象就等于没测量**：
   采集器必须全程 try/catch，且按 `nodeType` 分支取名。
2. **宿主与插件共用记录上限** → 上限被宿主吃满、插件记录被挤出窗口（首轮 6000 条全是宿主、
   `pluginOps=0`）。必须按归属分流。
3. **`DOMTokenList` 不暴露 owner**（Chrome 无 `ownerElement`/`_element`）→ `classList.*` 的 target
   记成 `null`，会被误判为"写在宿主元素上"。修法是重定义 `Element.prototype.classList` 的 getter
   建 `WeakMap<list, element>`，**不要返回 Proxy**（保持 getter 返回原 list 实例，语义不变）。
4. **`CSSStyleRule.cssRules` 在现代 Chrome 是空但 truthy** → `if (r.cssRules)` 会把每条普通规则
   当嵌套组递归进空表，CSS 命中域统计恒为 0。必须"先看 `selectorText`，再看 `cssRules.length`"。

## 6. 静态守卫自身的两个缺陷（由负例测试逼出，已修）

1. **可选链静默漏报**：`document.querySelector('#evil')?.appendChild(x)` 报 0 违规——
   对象表达式收集在 `?` 处断掉，目标变空串被跳过。
2. **锚点白名单形同虚设**：取选择器字面量时算错了 `(` 的位置（取到了**写入方法**的括号，
   而它位于对象表达式**之后**），于是永远取不到字面量、白名单从不生效。
   真仓当时"通过"只是因为它恰好全走局部变量——**这正是"0 违规不等于没违规"的活证据**。

**强制约定**：新增/改动守卫时必须同时给出负例回归（`test/dom-scope.test.js` 现有 13 例，
含 6 类负例 + 4 类正例 + 不误报 + 真仓现状断言）。

## 7. Wrong vs Correct

```js
// Wrong —— 裸写宿主 body，且没交代为什么
document.body.appendChild(overlay);

// Correct —— 确属必要（模态必须挂 body 才能全页覆盖），显式写明理由
document.body.appendChild(overlay); // dom-scope:allow 自绘模态覆盖层必须挂 body 才能全页覆盖（放进扩展抽屉会被其 overflow/transform 裁剪）

// Wrong —— 往任意宿主节点塞东西
document.querySelector('#someThirdPartyWidget').appendChild(btn);

// Correct —— 落点用声明过的锚点，或先在本地变量里收敛后由运行期仪器归因
const row = document.querySelector('.userBackupManager .backupActionRow');
row.insertBefore(btn, row.firstChild);
```

## 8. 跨宿主安装落点（2026-09-26 取证，供"把插件装到各实例"时用）

| 宿主 | 第三方扩展落点 | 机制要点 |
| --- | --- | --- |
| SillyTavern | `public/scripts/extensions/third-party/<name>/`（宿主 `.gitignore` 已忽略，克隆不弄脏实例仓） | `grep .gitignore:18/:54` |
| Luker | `data/default-user/extensions/<name>/`（**平铺，绝不嵌套 `third-party`**） | 服务路径同样映射到 `/scripts/extensions/third-party/<name>/`——**排查"装没装"不要按目录名找 URL** |
| TauriTavern | `data/default-user/extensions/<name>`（local）/ `data/extensions/third-party/<name>`（global），同名 local 优先 | `ExtensionDEV.md:36-39`、`docs/CurrentState/ThirdPartyExtensions.md:133`；其安装由 Rust gitoxide 建**受管 embedded repo**，手工 clone 只得 `unmanaged` 状态；且 data root 是**运行期可选**的 |
| PureTavern | **无服务端扩展目录**——包存在浏览器 Profile 的 M13 blobs，`local`/`global` 只是标签 | `apps/web/src/features/extensions/README.md:3/:54/:56`；安装来源只支持远程 URL（jsDelivr/GitHub/GitLab/`.zip`） |

**结论**：TT 与 PT **不能**用"往目录里 git clone"来安装；只能在宿主启动后经其自己的扩展管理器用 Git URL 安装。
