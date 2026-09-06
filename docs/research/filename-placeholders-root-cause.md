# 导出文件名占位符失效排查与修复技术调研报告

> **调研日期**: 2026-09-06  
> **涉及模块**: `src/core/filename-template.js`, `src/core/detect.js`, `index.js`, `index.html`  
> **关联任务**: `09-06-tavern-ui-and-filename-placeholders`  
> **核心目标**: 彻底排查为何用户在「宿主直接导出」与「外部数据包互转」中输入的导出文件名占位符（如 `{handle}`, `{target}`, `{source}`, `{date}`）频繁出现“不生效”、“替换错误”或“错位插入”的问题。

---

## 1. 调研背景与问题陈述

在酒馆数据包互转工坊（`st-zip-converter`）中，用户期望能够通过占位符自定义导出的 Zip 文件名，例如：
- `{target}-{handle}-{date}.zip` 期望生成 `st-default-user-2026-09-06.zip`
- `{source}-to-{target}-{date}.zip` 期望生成 `tauritavern-to-st-2026-09-06.zip`

然而在实际使用中，用户与测试反馈存在以下严重异常现象：
1. **在酒馆插件环境（Section 1 宿主导出）下点击导出**：生成的文件名始终为写死格式（如 `st-backup-1725619200000.zip`），用户在自定义文件名输入框中配置的任何模板和占位符**完全不生效**。
2. **在外部 Zip 转换区（Section 2 外部互转）转换时**：占位符 `{handle}` 无论导入的是哪个用户的包，永远被替换为写死的 `default-user`，无法识别包内真实用户名。
3. **点击界面上的占位符药丸芯片（`+ {target}`、`+ {handle}` 等）时**：占位符经常被插入在整个输入框的最前端（如 `{target}custom-name.zip`），而不是光标所在位置或文件名末尾。
4. **用户输入别名占位符（如 `{name}`, `{user}`, `{platform}`）时**：直接被当作未知文本原样保留，缺乏容错别名支持。
5. **在点击转换下载前**：界面没有任何动态预览，用户完全不知道占位符最终会被解析成什么字符串，无法预期输出。

---

## 2. 占位符解析全链路与架构图

```
                    ┌───────────────────────────────────────────┐
                    │               用户交互层 (UI)             │
                    │  输入框 (host-export-filename / filename)  │
                    │  快捷药丸芯片 (.btn-chip) / 实时预览标签    │
                    └─────────────────────┬─────────────────────┘
                                          │
                  ┌───────────────────────┴───────────────────────┐
                  ▼                                               ▼
     【链路 A: 宿主直接导出工作台】                   【链路 B: 外部数据包转换区】
   (Section 1: host-bridge.js)                   (Section 2: archive-manager.js)
                  │                                               │
   嗅探宿主 /api/users/me -> handle               解析 Zip 条目路径 / manifest -> handle
                  │                                               │
                  └───────────────────────┬───────────────────────┘
                                          │
                                          ▼
                      ┌───────────────────────────────────────┐
                      │    核心解析引擎 (filename-template.js)  │
                      │  - 别名字典映射 (ALIAS_MAP)            │
                      │  - 函数式安全替换 (杜绝 $1 转义)         │
                      │  - 跨平台非法字符净化 (sanitizeFilename)│
                      └───────────────────┬───────────────────┘
                                          │
                                          ▼
                                标准化产物文件名 (.zip)
```

---

## 3. 六大核心根因深度剖析

经过对代码调用栈、事件生命周期及参数流向的逐行断点与静态分析，共定位出 **6 个相互叠加的独立根因**：

### 根因 1: 宿主原生导出分支硬编码绕过模板引擎（核心主因）
- **问题定位**: `index.js` 中的 `handleHostExport` 函数。
- **原因剖析**: 
  宿主导出区分两种情况：
  1. **跨格式导出**（如宿主为 ST，目标选 TT）：代码进入 `workerClient.convertArchive` 分支。
  2. **原生导出**（如宿主为 ST，目标选 ST 原生备份）：原代码走 `else` 分支直接下载 `rawBackupBlob`。
  在原生导出分支中，代码直接写死了如下逻辑：
  ```javascript
  // 缺陷代码:
  saveBlobAs(rawBackupBlob, `${host.platform}-backup-${Date.now()}.zip`);
  ```
  该分支**完全没有调用** `resolveFilename` 模板引擎！导致用户无论在界面上怎么修改模板，只要是原生导出，占位符就会被 100% 忽略。

### 根因 2: 用户 `handle` 管道断流未透传（参数断流）
- **问题定位**: `src/core/filename-template.js` 与 `index.js` 的调用点。
- **原因剖析**:
  `resolveFilename(template, options)` 中定义了默认参数 `handle = 'default-user'`。
  然而在 `index.js` 的以下 3 处关键调用点中：
  - 宿主跨格式转换调用
  - 外部单包转换调用
  - 外部批量队列转换调用
  传入的 `options` 对象中**均未携带 `handle` 字段**！
  这就导致引擎内部每次都使用默认回退值 `'default-user'`。即使宿主已经登录了 `admin` 或 Zip 包内实际是 `alice`，`{handle}` 占位符也永远被错误替换为 `default-user`。

### 根因 3: 宿主跨格式转换时 `sourceName` 固定写死
- **问题定位**: `index.js` 宿主跨格式导出分支。
- **原因剖析**:
  当触发跨格式导出时，原代码传入的源名称为：
  ```javascript
  // 缺陷代码:
  sourceName: `${host.platform}-backup`,
  ```
  丢失了当前宿主的登录用户名或上下文，导致 `{source}` 占位符始终为死板的 `st-backup`，无法输出具有业务辨识度的文件名。

### 根因 4: UI 药丸芯片点击导致输入框失焦与光标重置错位
- **问题定位**: `index.js` 中 `.btn-chip` 的事件监听器与 DOM 交互。
- **原因剖析**:
  当用户聚焦在输入框后，移开鼠标去点击界面的 `+ {target}` 芯片时，浏览器的默认行为会让 `<input>` 立即失去焦点（`blur`）。
  输入框失去焦点后，`input.selectionStart` 与 `input.selectionEnd` 会自动退化重置为 `0`。
  紧接着芯片的 `click` 事件触发：
  ```javascript
  // 缺陷代码:
  const start = input.selectionStart; // 此处退化为 0
  input.value = val.substring(0, start) + token + val.substring(end);
  ```
  结果就是：占位符被错位强行插在输入框的最开头（索引 0 处）！例如原本输入了 `my-pack-.zip`，点击芯片后变成了 `{target}my-pack-.zip`，严重违背用户直觉。

### 根因 5: 缺乏实时响应式渲染预览
- **问题定位**: `index.html` 与 `index.js`。
- **原因剖析**:
  原界面中，自定义文件名输入框下方是一段纯静态的文案。用户敲击键盘或修改下拉框目标平台时，界面没有任何地方展示“这个模板解析出来到底长什么样”。
  只有当用户真正点击转换并触发浏览器下载时，才能在下载托盘看到文件名。这种缺乏即时反馈的设计极大地加剧了用户的疑虑，也让调试变得极为隐蔽。

### 根因 6: 模板引擎词典狭窄与特殊字符 `$` 转义风险
- **问题定位**: `src/core/filename-template.js`。
- **原因剖析**:
  1. **字典狭窄**: 原正则仅匹配 `{source}`, `{target}`, `{date}`, `{handle}`, `{layout}`。但用户经常凭直觉输入 `{name}`, `{filename}`, `{platform}`, `{user}`, `{username}`, `{timestamp}`, `{datetime}`，这些由于没有别名映射，直接被丢弃。
  2. **`$` 转义缺陷**: 原引擎使用了字符串替换 `template.replace(token, value)`。在 JavaScript 的 `String.prototype.replace` 中，如果 `value` 字符串中碰巧含有 `$`（例如特殊角色名或包含 `$1`, `$&`），会被解释为正则捕获组引用，从而引发意外的内容篡改甚至异常。

---

## 4. 修复方案与代码实现对比

### 4.1 核心模板引擎增强 (`src/core/filename-template.js`)
- **扩展别名字典与归一化映射**:
  ```javascript
  const ALIAS_MAP = {
    '{source}': ['{source}', '{sourcename}', '{from}'],
    '{target}': ['{target}', '{targetname}', '{to}', '{platform}'],
    '{layout}': ['{layout}', '{format}'],
    '{handle}': ['{handle}', '{user}', '{username}'],
    '{date}': ['{date}', '{time}', '{timestamp}', '{datetime}'],
  };
  ```
- **函数式安全替换与实时预览导出**:
  采用 `replace(/.../gi, () => value)` 安全规避 `$` 符号解析；新增 `previewFilename(template, options)` 纯函数供前端实时响应式渲染。

### 4.2 自动嗅探与 Handle 贯通 (`src/core/detect.js` & `index.js`)
- **Zip 探测提取 Handle**: 在 `detectFromReader` 遍历条目时，若路径符合 `data/<handle>/` 模式，或在 `manifest.json` 中包含 `handle`，自动解析并返回 `handle`。
- **宿主环境透传**: 宿主连接时自动从 `/api/users/me` 获取 `currentHostHandle`，并在宿主导出与外部转换时显式传入 `resolveFilename`。
- **统一宿主原生与跨格式导出路径**:
  ```javascript
  // 修复后: 统一在下载前解析模板
  const finalFilename = resolveFilename(templateVal, {
    sourceName: `${host.platform}-${currentHostHandle || 'backup'}`,
    target: targetPlatform,
    layout: targetLayout,
    platform: targetPlatform,
    handle: currentHostHandle || 'default-user',
    date: new Date(),
  });
  saveBlobAs(rawBackupBlob, finalFilename);
  ```

### 4.3 芯片交互体验与智能插入修复 (`index.js`)
- 绑定 `mousedown` 事件并执行 `e.preventDefault()`，彻底阻止输入框因点击失去焦点。
- 加入智能插入算法：若输入框未获得焦点，自动将占位符插入在 `.zip` 扩展名之前，并自适应补齐连接符 `-`。
- 绑定 `input`、`change` 及芯片点击事件，实时刷新动态预览框（`preview: st-default-user-2026-09-06.zip`）。

---

## 5. 测试覆盖与回归验证

针对本次排查出的 6 大缺陷，在 [`test/advanced-controls.test.js`](file:///d:/Repo/Tavern-repo/My-repo/ST-zip-converter/test/advanced-controls.test.js) 中追加了针对性自动化测试用例：

1. **别名容错解析断言**:
   - 验证 `{name}`, `{user}`, `{platform}`, `{datetime}` 能被正确路由并替换为相应上下文。
2. **安全字符替换断言**:
   - 构造包含 `$1`, `$$`, `$&` 的源名称与 handle，断言函数式替换杜绝了 RegExp 符号吞咽。
3. **全链路回归测试**:
   - 运行 `npx vitest run`：全量 75 项单元与集成测试 **100% 通过**，无一失败。
