# Font Awesome 6.5.1（本地副本）

> **勿升级改动**（`L1-MR-11`：第三方库以本地副本形式随附，安装即用、无需构建）。

## 为什么在这里

独立 Web 形态（`index.html`）此前从 **cdnjs 外链** Font Awesome。后果有二：

1. 违反用户级全局规则 **`nocdn`（零外部依赖）**；
2. **离线 / 内网 / 云部署不可达 CDN 时，全部图标失效** —— 而插件态不受影响
   （酒馆宿主自带 FA），所以这个缺口只在独立形态暴露，平时看不见。

实测读数（`npm run e2e:web` 的「跨源请求」信息项，2026-09-28 之前）：
`https://cdnjs.cloudflare.com/.../all.min.css` + `.../fa-solid-900.woff2` 两条跨源请求。
改为本地副本后该读数应归零。

## 内容与取舍

| 文件 | 说明 |
| --- | --- |
| `css/all.min.css` | 上游 `6.5.1/css/all.min.css` **原样**（102,641 字节） |
| `webfonts/*.woff2` | 四个字族各一份：`fa-brands-400` / `fa-regular-400` / `fa-solid-900` / `fa-v4compatibility` |
| `LICENSE.txt` | 上游 MIT 许可（Fonticons, Inc.） |

**只随附 `.woff2`，没有 `.ttf`**：上游 CSS 的 `src:` 里 woff2 排在前、ttf 是回退，
现代浏览器只请求 woff2。CSS 里的 `.ttf` 引用**保留原样**（副本不改），
它不会被请求，因此也不会产生 404。若将来确需支持只认 ttf 的老浏览器，
再补 `.ttf` 副本即可。

## 来源

- 包：<https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/>
- 许可：<https://github.com/FortAwesome/Font-Awesome/blob/6.5.1/LICENSE.txt>
- 拉取日期：2026-09-28
