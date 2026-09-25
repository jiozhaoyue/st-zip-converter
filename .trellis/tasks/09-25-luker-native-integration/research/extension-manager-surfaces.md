# T3 阶段 4 · ③ 扩展管理可对接面盘点与建议清单

> 取证方式：GitHub API 读 `funnycups/Luker` `public/scripts/extensions.js` + `st-context.js`
> + 本仓 `src/ui/host-bridge.js` 现状。**本文件只出建议——替换实施须经用户逐项确认**（R3.1 / R3.2）。

## 1. 本插件当前的扩展相关流程（现状取证）

全部集中在 `src/ui/host-bridge.js`，且**唯一触发路径是「写回宿主」之后**：

```
restoreToHostInner()                       host-bridge.js:716
  └─ 恢复成功后，若包内含扩展
       └─ renderExtensionInstallerModal(entries, …)   :919  ← 自绘安装弹层
            ├─ discoverHostExtensions()              :809  GET /api/extensions/discover
            ├─ deleteExtensionViaHost('third-party') :1148 POST /api/extensions/delete  ← 嵌套异常修复
            └─ installExtensionViaHost({url,branch}) :1218 POST /api/extensions/install
```

| 本仓函数 | 端点 / 机制 | 用途 |
| --- | --- | --- |
| `discoverHostExtensions()`（:809） | `GET /api/extensions/discover` | 列出宿主已装扩展（供打包/比对） |
| `installExtensionViaHost()`（:833） | `POST /api/extensions/install` | 从 URL 安装单个扩展 |
| `deleteExtensionViaHost()`（:896） | `POST /api/extensions/delete` | 删除扩展 |
| 嵌套异常探测（:748 附近） | `GET /api/extensions/discover` | 检出 `third-party/third-party`（**L1-MR-12 事故防线**） |
| `renderExtensionInstallerModal()`（:919） | 自绘弹层 | 安装交互 UI |

> 注：`discoverHostExtensions` / `installExtensionViaHost` / `deleteExtensionViaHost` / `renderExtensionInstallerModal`
> **均未被 `index.js` 直接引用**，只在本模块内部互相调用——即扩展管理没有独立入口，
> 只作为「写回宿主」的后置步骤存在。

## 2. 宿主侧可对接面（Luker 源码取证）

| 能力 | 签名 | 语义 | 能否替代本仓流程 |
| --- | --- | --- | --- |
| 原生安装器弹层 | `openThirdPartyExtensionMenu(suggestUrl = '')` → `Promise<void>`（`extensions.js:2657`） | 渲染 `installExtension` 模板的弹层：URL + 可选分支/tag；管理员多一个「Install for all users」；安装成功后重载扩展设置并广播 `EXTENSION_SETTINGS_LOADED` | **可替代安装步骤**（`suggestUrl` 正好用于把我们解析出的扩展 URL 预填进去） |
| 扩展 manifest | `getExtensionManifest(name)` → `object\|null`（`:525`） | 深拷贝某扩展的 manifest；接受短名或 `third-party/<name>` 全名 | 部分替代 `discoverHostExtensions` 的**单扩展**查询；但**没有「列出全部」的原生 API** |
| 跨扩展 API 注册表 | `registerExtensionApi(name, api)` / `getExtensionApi(name)`（`:50` / `:62`） | 扩展间能力共享；`getContext().getExtensionApi(name)` | 与本插件当前需求**无关**（我们不需要消费别的扩展的能力） |
| 扩展设置对象 | `extension_settings`（`getContext()` 暴露） | 宿主侧扩展设置聚合对象 | 与我们自己的 `settings.json` 读写面**不冲突**，但也没有替代关系 |
| 原生删除 UI | — | `deleteExtension(name, shouldClean)`（`:1558`）是**API 而非 UI**，无对应弹层 | **无可替代**；且本仓用的是端点直调 |

## 3. 建议清单（**逐项待确认，未确认不得实施**）

| # | 建议 | 理由 | 风险 / 代价 |
| --- | --- | --- | --- |
| **③-A** | **安装步骤改为委托原生**：`renderExtensionInstallerModal` 的「安装」动作改为调用 `openThirdPartyExtensionMenu(extUrl)`，把 URL 交给宿主原生安装器 | 原生 UI 自带进度/错误处理与「装给所有用户」权限语义，比自绘弹层更贴合宿主；也少维护一套安装交互 | 会**丢失批量安装**（原生弹层一次一个 URL）；自绘弹层当前能列出包内全部扩展逐个装。若保留批量，需在原生弹层外再包一层循环 UI——那就没省下什么 |
| **③-B** | **保留全部现状不动**（仅本盘点归档） | 现有流程是「写回宿主」的后置步骤，触发点明确、批量安装是真实需求；原生安装器是**单 URL** 语义，替代后批量体验反而变差 | 继续维护自绘弹层 |
| **③-C** | **仅替换安装的「跳转」语义**：自绘弹层里每个扩展旁加一个「用宿主原生安装器打开」的入口，`openThirdPartyExtensionMenu(extUrl)`；默认仍走批量自装 | 兼顾两者：批量仍可用，遇到安装失败/需管理员权限时用户可切原生入口 | 多一个入口，UI 复杂度略增（受「零解释性文案」约束，只能用图标 + `title`） |
| **③-D** | 用 `getExtensionManifest(name)` 替掉部分 `discoverHostExtensions` 调用 | 减少一次全量 `discover` 请求 | 原生**无列表 API**，仍需 `discover` 拿全集；收益仅限单个查询场景，本仓暂无该场景 |

**我的推荐：③-B（保留现状）+ ③-C 作为可选增强。**
理由：原生安装器是**单 URL** 语义，而本仓扩展安装的真实场景是「从数据包里批量装回」，
替代会**净损失**批量能力；而 ③-C 在不损失批量的前提下给了用户一条原生通路，
代价只是一枚图标按钮。③-A 与 ③-D 净收益为负或接近零。

### 无论选哪项都**必须保留**的（R3.3 硬约束）

1. **`third-party/third-party` 嵌套异常探测**（`host-bridge.js:748` 附近）——L1-MR-12 事故防线，
   实测该嵌套会让该目录下**所有**子插件失效。**无原生替代**。
2. **`deleteExtensionViaHost('third-party', false)` 的修复动作**（`:1148`）——与上面配套的修复路径。

## 4. 待证（若后续选择 ③-A / ③-C 才需要）

- `openThirdPartyExtensionMenu(suggestUrl)` 的 `suggestUrl` 是否真的会**预填**到输入框
  （源码只显示形参透传给 `renderTemplateAsync('installExtension', …)`，未见显式使用；
  需实机验证）。
- 原生安装器在**非管理员**用户下的行为（`isCurrentUserAdmin` 为 false 时按钮文案变为 `Install`）。

## 5. 结论对 T4 的输入

- ③ 与 T4（`09-25-transfer-pack-optimize`）无重叠：T4 关注上下传与打包默认值，
  ③ 关注安装交互。**但**「写回宿主后自动弹扩展安装」这一后置步骤的**触发时机与默认行为**
  属于 T4 的「闭环收敛」范围，建议在 T4 一并裁决，本任务不动。
