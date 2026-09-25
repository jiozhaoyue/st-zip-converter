# 本次实测读数汇总（自包含，供 implement / check 阶段直接引用）

> 环境：Windows 11，Dev Luker 8003 / Real Luker 8004，认证态（持久化 profile
> `.pw-profile-dev`，Playwright 走全局安装）。插件哈希 `f26dcd5`。
> 原始证据同目录；**2.3 MB 级的三份 `dom-audit-*-{on,off,off2}.json` 是全树指纹原始数据，
> 仅供复算，不要塞进上下文**（超过 Trellis `context_injection.max_file_bytes` 会被静默截断）。

## 1. 宿主 toastr 通知：与本插件无关（三条独立证据）

| 证据 | 读数 |
| --- | --- |
| 静态 | `grep -rni toastr src/ index.js` → **0 命中** |
| 动态动作矩阵（8003） | 6 个插件入口动作全部 **0 条 toast**（`action-toast-matrix-8003.json`） |
| 结构 | 宿主「Extension updates available」（`extensions.js:2006/2028`）只对 `manifest.auto_update === true` 生效；本仓 `manifest.json` **无该字段** |

实测抓到的真凶在 8004（页面加载期）：
`toastr.success('数据库已加载！','数据库')` ← `shujuku-rebuild/index.js:99221 showToastr_ACU`
← `…:130578` ← `…:192694`，经 `Zero/index.js:39` 调 `window.toastr`；
DOM 形态 `div.toast.acu-toast.acu-toast--success`。**属另一仓**。
不确定性：`--fetch` 之后重跑 8004 未再复现（疑与该扩展 DB 加载条件有关），本任务不对"何时必弹"下结论。

## 2. DOM 写操作归因（8003，决定性）

仪器 `pw-dom-write-audit.cjs`：在页面脚本前劫持 DOM 写 API，按**调用栈**归属到脚本。
非侵入性已核：插桩后控制台错误与不插桩基线**逐条一致**
（`Failed to load resource 404`×2 + `SyntaxError: Unexpected reserved word` +
`TypeError: $(...) is not a function` + `Uncaught SyntaxError: Identifier 'SPresetSettings' has already been declared`）。

| 指标 | 读数 |
| --- | --- |
| 整页 DOM 写操作 | **22425** |
| 本插件所为 | **17** |
| ↳ 写自己容器内 | 13 |
| ↳ 写宿主元素 | 4（**全部在声明锚点上**） |
| ↳ 改动宿主既有节点属性/class | **0** |
| ↳ 删除宿主既有节点 | **0** |

4 次宿主写入（`dom-writes-8003-verdict.json`）：

| op | 宿主锚点 | 插入节点 |
| --- | --- | --- |
| appendChild | `#extensions_settings2` | `#st-zip-converter-settings-panel.st-converter-drawer-wrapper` |
| appendChild | `#extensionsMenu` | `#st-zip-converter-menu-item.list-group-item.flexify-horizontal.interactable` |
| insertBefore | 账号弹层 `.flex-container` | `#st-zip-converter-native-btn.menu_button.menu_button_icon` |
| insertBefore | 账号弹层 `.flex-container` | `#st-zip-converter-native-btn-quick-fetch.menu_button.menu_button_icon` |

**仪器自身的两个坑（复用时别再踩）**：
1. `home()` 未对 **DocumentFragment** 做守卫 → `fragment.tagName.toLowerCase()` 抛错，
   打断 jQuery 的 IIFE，整页 `jQuery is not defined`（插件行为也被带崩）。
   修法：按 `nodeType` 分支命名；且 `record()` 全程 try/catch——**仪器影响被测对象就等于没测量**。
2. 宿主自身写操作上万次，若与插件记录**共用同一上限**，上限必被宿主吃满、把插件挤出窗口
   （首轮 6000 条全是宿主、`pluginOps=0`）。修法：插件全量、宿主只计数 + 限量样本。
3. Chrome 的 `DOMTokenList` **不暴露 owner**（`ownerElement`/`_element` 都没有）→
   `classList.*` 的 target 记成 `null`，会被误判为"写在宿主元素上"。
   修法：重定义 `Element.prototype.classList` getter 建 `WeakMap<list, element>`，
   **不要返回 Proxy**（getter 仍返回 Chrome 原 list 实例，语义不变）。

## 3. CSS 命中域（8003，确定性、零噪声）

仪器 `pw-dom-intrusion-audit.cjs`：让**浏览器自己解析** `style.css`，
对每条规则的每个逗号分支做 `querySelectorAll`，统计命中在插件容器之外的数量。

| 指标 | 读数 |
| --- | --- |
| `style.css` 规则数 | **343** |
| 命中插件容器之外的规则 | **0** |
| `body` 的 class + 内联 style（屏蔽插件 vs 正常加载） | **逐字节相同** |
| `html` 同上 | **逐字节相同** |

**仪器自身的坑**：现代 Chrome 里普通 `CSSStyleRule` 也带一个**空但 truthy** 的 `cssRules`
（CSS 嵌套支持）→ `if (r.cssRules)` 会把每条规则当嵌套组递归进空表，统计恒为 0。
必须写成「先看 `selectorText`，再看 `cssRules.length`」。

## 4. 对照组有效性（闸门读数）

| 模式 | 插件是否加载 | 插件资源请求 | 产物节点数 |
| --- | --- | --- | --- |
| `--mode=off`（route abort 掉 URL 含 `zip-converter` 的资源） | `pluginLoaded=false` | 4 个被拦 | 0 |
| `--mode=on` | `pluginLoaded=true` | 正常 | 3（设置面板 / 抽屉 `#app` / 菜单项） |

插件实际服务路径：`/scripts/extensions/third-party/st-zip-converter/…`
（注意：Luker 把装在 `data/default-user/extensions/<name>/` 的**本地**扩展也映射到
`third-party/` 路径下——排查"装没装"时不要按目录名找 URL）。

## 5. 宿主 `id="app"` 争用：不存在（清掉上一任务的 OQ-4）

`Instance/Dev/Luker` 全仓 `grep -rn 'id="app"' public/` → **0 命中**；
`getElementById('app')` / `querySelector('#app')` → **0 命中**。
但 `index.js:86 main(appRoot = document.getElementById('app'))` 的**默认参数兜底**仍是潜在路径
（插件态若先命中第三方 `#app`，整棵工作台会挂到别人容器里）——见 prd R6。

## 6. 插件 DOM 产物完整清单（8003，未开账号弹层时）

| 节点 | 落点父链 |
| --- | --- |
| `div#st-zip-converter-settings-panel.st-converter-drawer-wrapper` | `#extensions_settings2` < `.extensions_block` < `#rm_extensions_block.drawer-content.closedDrawer` < `#extensions-settings-button.drawer` < `#top-settings-holder` |
| `div#app.st-converter-drawer-app` | `#st_zip_converter_settings.inline-drawer` < `…settings-panel` |
| `div#st-zip-converter-menu-item.list-group-item…` | `#extensionsMenu.options-content` |

打开账号弹层后追加两个：`#st-zip-converter-native-btn`、`#st-zip-converter-native-btn-quick-fetch`
（父均为弹层内 `.flex-container`）。

## 7. 道具与复跑方式

```bash
# 动作矩阵（哪个插件动作触发宿主 toast）
node pw-action-toast-probe.cjs                 # 8003；--fetch 会真实拉 Dev 数据包
DEV_URL=https://127.0.0.1:8004 node pw-action-toast-probe.cjs

# DOM 写归因（谁改了 DOM）
node pw-dom-write-audit.cjs          # 采集
node pw-dom-write-audit.cjs --analyze # 归因与断言

# CSS 命中域 + 全树指纹对照
node pw-dom-intrusion-audit.cjs --mode=off
node pw-dom-intrusion-audit.cjs --mode=off --tag=off2   # 抖动基线
node pw-dom-intrusion-audit.cjs --mode=on
node pw-dom-intrusion-audit.cjs --diff
```

## 8. 遗留

- `action-toast-matrix.json`（无端口后缀的那份）是**首次运行被覆盖后留下的旧文件**
  （内容为 8004 首轮），已被 `-8003/-8004` 两份取代；保留仅作轨迹，**不作为证据**。
- 8001/8002（ST）当前未监听，本任务不擅自启动；ST 实机实测待用户授权。
