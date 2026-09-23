/**
 * UI 层共享 HTML 转义工具
 *
 * 存在原因（安全）：用户可控数据（上传 ZIP 内的文件名 / 扩展名、宿主返回文本、错误消息、
 * 包内 JSON 字段）**不得**直接进入 `innerHTML`。本模块提供统一转义入口，覆盖元素上下文
 * 与**属性上下文**所需的引号字符，供 `src/ui/**` 复用。
 *
 * 历史教训：`log-console.js` 曾自带只转义 `& < >` 三个字符的私有实现——缺引号转义意味着
 * 一旦该值落入属性位置（如 `title="${...}"`），仍可越出属性边界注入事件处理器。故本模块
 * 统一覆盖 5 个字符，且全仓只此一处实现（见 `.trellis/spec/guides/code-reuse-thinking-guide.md`）。
 *
 * 配套守卫：`npm run check:dom-injection`（`scripts/dom-injection-guard.js`）会扫描
 * `src/ui/**` 与根 `index.js`，凡 `innerHTML` / `insertAdjacentHTML` / `outerHTML` 赋值中
 * 出现未转义插值即报错退出。
 */

/**
 * 转义 HTML 特殊字符（元素上下文 + 属性上下文通用）。
 * @param {unknown} value 任意值；`null` / `undefined` 视为空串
 * @returns {string} 可安全插入 HTML 文本位置或双引号属性位置的字符串
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 判断字符串是否为可安全展示的远程地址（仅允许 http / https）。
 *
 * 用于渲染期把关：`javascript:` / `data:` 等协议不得进入 DOM 输出。
 * @param {unknown} value 待校验值
 * @returns {boolean}
 */
export function isSafeHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

/**
 * 标注「可信静态 HTML 片段」——**仅限本仓内写死的字面量或已验证的可信产物**。
 *
 * 本函数是恒等函数（原样返回），存在的意义是**把「这段 HTML 是可信的」写进代码**，
 * 让 `npm run check:dom-injection` 能放行、让 reviewer 能用 grep 一眼看全部豁免点：
 *
 *   grep -rn "trustedStaticMarkup(" src/ index.js
 *
 * 命名故意冗长刺眼：**凡见到它，就必须人工确认入参不含任何变量/外部输入**。
 * 传入用户可控数据（文件名、包内 JSON、宿主响应正文）一律视为违规。
 *
 * @param {string} markup 可信的静态 HTML 片段
 * @returns {string} 原样返回
 */
export function trustedStaticMarkup(markup) {
  return markup;
}

