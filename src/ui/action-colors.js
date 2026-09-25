/**
 * 动作语义 token → CSS 变量（呈现层解析）
 *
 * `src/core/plan-preview.js` 的动作标签只给**语义 token**（`copy`/`route`/…），
 * 颜色属于呈现层，集中落在 `style.css` 的容器令牌块（`--st-action-*`，跟宿主主题走）。
 * 本模块是两者之间唯一的桥——**core 里不得再出现颜色字面量**。
 *
 * 为什么返回 `var(...)` 而不是取真实色值：
 * 这些值只被写进 `style.borderColor` / `style.color` / `style.background` 这类
 * **CSS 声明**，浏览器会在计算值时自行替换 `var()`，无需 JS 侧读色。
 * （与 `host-bridge.js` 的 `themeAccent()` 不同——那里是 `style.color = <真实值>` 的场景，
 * 例如需要把颜色交给 Canvas 或做字符串拼接，才必须读真值。）
 *
 * @param {string} token 动作 token（见 `ACTION_TOKENS`）
 * @returns {string} 形如 `var(--st-action-copy)` 的 CSS 变量引用
 */
const TOKEN_VARS = {
  copy: 'var(--st-action-copy)',
  route: 'var(--st-action-route)',
  migrate: 'var(--st-action-migrate)',
  synth: 'var(--st-action-synth)',
  drop: 'var(--st-action-drop)',
  filter: 'var(--st-action-filter)',
};

export const ACTION_TOKEN_VARS = Object.freeze({ ...TOKEN_VARS });

/**
 * @param {string|undefined} token 动作 token
 * @param {string} [fallback='filter'] 未知 token 的兜底（对应原实现的 `#9ca3af`/`#6b7280` 灰）
 * @returns {string} CSS 变量引用；token 未知时返回兜底
 */
export function actionTokenVar(token, fallback = 'filter') {
  return TOKEN_VARS[token] || TOKEN_VARS[fallback];
}
