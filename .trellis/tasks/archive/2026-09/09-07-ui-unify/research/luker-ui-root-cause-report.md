
---

## 更正（2026-09-07 第二次诊断）：真凶是本插件旧版 CSS 的裸原生类选择器

此前结论不完整。用户截图证实顶栏按钮全部错位后重新排查：

**真正根因**：实例内安装的 st-zip-converter 旧版 `style.css` 含 **19 条无容器前缀的酒馆原生类规则**
（`.menu_button`×3、`.text_pole`×2、`.checkbox_label`×3、`.inline-drawer`×7、
`.flex-container`、`.flex1`、`.badge` 系列）。这些类名是酒馆全站共用：
- `.menu_button` 在 Luker 原生 CSS 出现 39 处（顶栏/抽屉所有按钮）
- `.inline-drawer` 13 处、`.checkbox_label`、`.text_pole` 同理
插件注入后按 CSS 层叠覆盖了**全站所有按钮/抽屉/输入框**——用户截图中的顶栏方块化、换行、边框异常全部由此而来。

**修复前 CSS 首轮只处理了 `:root`/`body`/`*`/滚动条，漏掉了这批类选择器——诊断疏漏，已补全。**

### 本次修复与双向实证

1. 仓库 style.css 全量作用域化：36 + 195 + 21（多行选择器列表段）= **252 条规则**全部加
   `.app-container`（独立模式）/ `.st-converter-drawer-app`（插件态）双前缀。
2. 真机双向验证（Luker 8004）：
   - 注入**修复后** CSS：顶栏按钮/抽屉切换/输入框/checkbox/正文 10 个采样点 computed style **零变化** ✓
   - 注入**实例旧版** CSS：`.inline-drawer-toggle` padding/背景/字号、`.drawer-toggle` 边框等 **5 处被改**——用户截图症状精确复现 ✓
3. 独立 Web 模式回归：统一工作台、待导出区、用量看板、单列表、页面骨架全部正常 ✓
4. 137 项测试全绿。

### 实例复位（唯一正确途径）

实例内 `data/default-user/extensions/st-zip-converter/` 是旧版副本，**必须通过 Git 拉取新版插件**覆盖：
实例的扩展管理器中更新 st-zip-converter（Git URL 安装方式自动 pull 最新 main），
或在扩展管理器界面点击更新。更新后硬刷新（Ctrl+F5）页面，顶栏立即恢复。
（遵守项目规范：不直接向实例目录复制文件。）
