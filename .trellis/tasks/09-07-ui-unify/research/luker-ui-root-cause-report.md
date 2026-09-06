# Luker 8004 真机 UI 异常诊断报告（2026-09-07）

> 方法：Playwright 真机采样 + 网络拦截 + 主题变量/布局几何/交互响应实测

## 结论：UI 异常不是单一故障，是【主题被改 + movingUI 拖拽模式开启 + 8 份字体主题叠加 + 第三方扩展层】四个因素叠加

### 根因 1（主因）：movingUI 拖拽模式处于开启状态
- `powerUserSettings.movingUI = true`（主题 "Dark Lite"）
- body 常驻 class `movingUI` → Luker 把所有抽屉/面板切换为可拖拽的 absolute 定位体系（`rm_api_block`、`AdvancedFormatting`、`WorldInfo`、`user-settings-block`、`Backgrounds`、`PersonaManagement`、`rm_extensions_block` 全部 position:absolute/fixed）
- movingUIState 里保存了 `gallery` 面板的拖拽坐标（`{bottom:0, left:76, right:1284, top:334, margin:unset}`）
- **症状表现**：面板位置不跟随正常布局流、抽屉内容错位、拖动过的元素"飘"在奇怪位置。这就是"UI 变得很奇怪"的主体感受来源。

### 根因 2：8 份字体主题同时叠加
- 页面加载了 8 份 `fontsapi.zeoseven.com/*/main/result.css`（8 个不同字体主题包），29 个 @font-face，字体请求 69 个
- 多份字体主题互不知道对方存在，全部往 body 上抢字体族/字号变量
- **症状表现**：字体渲染时好时坏、字号/行高不一致、页面文字观感"奇怪"

### 根因 3：第三方扩展样式层冲突（21 份第三方 CSS）
- 19 个第三方扩展同时在跑，`silly-tavern-reminder` 与 `chat-companion-stats` 的 CSS **被加载了 2 份**（重复注入）
- `tavern-menu-manager`（magic-panel-wrapper）挂了 z-index=100000 的全屏 fixed 层（目前 pointer-events:none 未遮挡点击，但任何子状态变化都会瞬间挡住全屏）
- `Acsus-Paws-Puffs` 一家就有 27 条全局性滚动条规则
- **症状表现**：菜单/弹窗样式互相覆盖、局部样式突变

### 根因 4（环境噪音）：SD 后端 500 错误
- `/sd/samplers`、`/sd/models`、`/sd/get-model` 等 5 个端点 500（SD WebUI 未启动或配置失效），console.error 反复刷错误，但不影响布局

### 排除项
- **本插件 st-zip-converter 无责**：已按新协议作用域化样式，真机验证对宿主零污染；其脚本仅加载 1 份。
- 无扩展 JS 双实例（extensionLoadCounts 全部 =1）；CSS 重复只是同一扩展注入两次样式标签。
- 无 500/404 涉及主题系统本身；`--SmartTheme*` 变量值与 "Dark Lite" 主题定义一致（未被外部覆盖）。

## 强制复位方案（按顺序执行，效果从轻到重）

### 方案 A：关闭 movingUI + 清除拖拽坐标（针对性复位，首选）
在酒馆页面左上角"用户设置"图标 → 「用户设置」面板 → 找到 **"移动式 UI"（MovingUI）** 开关 → **关闭**。
或直接在浏览器控制台（F12）执行：
```js
// 1) 关闭 movingUI 并清掉保存的拖拽坐标
const ctx = globalThis.lukerContext;
const pu = ctx.powerUserSettings;
pu.movingUI = false;
pu.movingUIState = {};          // 清除 gallery 等面板的被拖拽坐标
ctx.saveSettingsDebounced();    // 保存
location.reload();
```

### 方案 B：字体主题去重
8 份 zeoseven 字体主题来自"字体管理"类扩展或自定义主题叠加。保留 1 个想用的，其余禁用：
- 检查 `st-zip-converter` 之外哪个扩展在注入 zeoseven 字体链接（实测注入源在扩展样式层）
- 或控制台执行（临时验证效果）：
```js
document.querySelectorAll('link[href*="zeoseven"]').forEach((l, i) => { if (i > 0) l.disabled = true; });
```

### 方案 C：扩展样式冲突定位（二分法）
控制台逐组禁用第三方 CSS 后观察 UI 恢复情况：
```js
// 逐个禁用/启用，定位打架的扩展
document.querySelectorAll('link[rel=stylesheet]').forEach(l => { if (l.href.includes('third-party')) l.disabled = !l.disabled; });
```
重点怀疑：`tavern-menu-manager`（全屏 fixed 层）、`silly-tavern-reminder` 与 `chat-companion-stats`（重复注入 CSS）。

### 方案 D：主题完全重置（终极复位）
用户设置 → 主题选择器 → 切换到任意内置主题再切回 "Dark Lite"（让 power_user 主题状态完整重放）；如仍异常，按住 Ctrl 启动/刷新或清理 `data/default-user/` 下 settings.json 的 `movingUIState` 字段（实例文件操作须走 Git/备份流程）。

### 方案 E：SD 500 错误（独立问题）
启动 SD WebUI 后端或在扩展里禁用自动连接，消除 console 刷屏。

---

## 追加验证（复位实测结果 · 同日补充）

1. **官方复位入口已确认**：Luker 用户设置面板有 `#movingUIreset` 按钮（"Reset MovingUI panel sizes/locations"），真机点击后 `movingUIState` 从 `{gallery:{...}}` 变为 `{}` —— **拖拽坐标污染已清除**。
2. **定位机制澄清**：`.drawer-content` 的 `position:absolute` 是 Luker 基础样式固有设计（style.css:5821），与 movingUI 无关；movingUI 的实际影响是给可拖拽面板（gallery 等）注入 top/left/right/bottom/margin 内联坐标。此前"7 个 absolute 面板"是基础设计，非故障。
3. **复位效果判定**：`movingUIState` 清空 + gallery 坐标清除 = 飘移面板回到默认位置。**用户感知的"UI 奇怪"中由面板漂移贡献的部分应立即恢复**。
4. 残余项：movingUI 总开关仍为 true（是否保持拖拽模式由用户偏好决定，非故障）；字体主题叠加与扩展样式冲突为观感问题，按报告方案 B/C 处理。

### 最终给用户的复位操作（按优先级）

1. **酒馆页面内**：用户设置（左侧抽屉人形图标）→ 移动式 UI 区域 → 点击 **"Reset MovingUI panel sizes/locations" 按钮**（真机已验证有效）。
2. 若字体观感异常：保留一个字体主题，禁用其余 zeoseven 字体链接（来源为字体管理类扩展配置）。
3. 若弹窗/菜单样式怪异：按二分法禁用第三方扩展 CSS 定位冲突（重点：silly-tavern-reminder、chat-companion-stats 重复注入；tavern-menu-manager 全屏层）。
4. SD 后端 500 与 UI 无关，属独立配置问题。
