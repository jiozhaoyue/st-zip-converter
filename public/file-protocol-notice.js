/**
 * `file://` 形态的**友好提示**（经典脚本，非 module）
 *
 * 为什么只能放在这里：独立态用 `<script type="module">`，而浏览器对 `file://` 下的模块脚本
 * 按 CORS 语义加载（origin 为 `null`）⇒ **必然被拒**。实测读数（2026-09-28）：
 * `Access to script at 'file:///…/assets/index-*.js' from origin 'null' has been blocked by CORS policy`。
 *
 * 这条**架构边界**（ESM + Worker 的必然结果，不是缺陷）本身没问题，问题是用户双击
 * `dist/index.html` 时只看到**白屏**，无从判断原因。**经典**脚本（非 module）在 file:// 下
 * 能正常加载，故由它把原因与做法写进 `#app`。
 *
 * 约束（三条都要守）：
 *  1. **只为 file:// 服务**：HTTP(S) 形态下**立即返回、一个字节都不动**
 *     （否则就会成为「第二份工作台 UI」—— 违反单一模板源铁律 `L1-MR-10`）；
 *  2. **不碰任何业务 id / 类**：只往 `#app` 里放一段说明文字（用 `textContent`，不走 innerHTML）；
 *  3. **自己不能抛**：任何异常都吞掉（它只是提示层，绝不能反过来把页面弄坏）。
 *
 * 边界登记与实测见 `e2e/standalone/specs/file-protocol.e2e.cjs` 与
 * `.trellis/spec/guides/standalone-web-and-cloud-e2e.md`。
 */
(function fileProtocolNotice() {
  try {
    if (typeof location === 'undefined' || location.protocol !== 'file:') return; // HTTP(S)：什么都不做

    var mount = function () {
      var app = document.getElementById('app');
      if (!app) return;
      // dom-scope:allow `#app` —— 独立态骨架容器（index.html 自带），此处只放纯文本提示，
      // 不注入任何业务节点/id/类（单一模板源铁律 L1-MR-10）。
      app.textContent = ''
        + '这个页面不能靠「双击」打开：浏览器禁止 file:// 下的 ES Module 脚本加载（origin 为 null）。\n\n'
        + '请经 HTTP(S) 打开：\n'
        + '  · 本机开发：仓库根目录执行 npm run dev，再打开它给出的地址；\n'
        + '  · 已构建产物：npm run preview，或用任意静态服务器指向 dist/；\n'
        + '  · 云端：直接把该目录当静态站点托管（子路径亦可，资源是相对引用的）。';
      app.setAttribute('style', 'white-space:pre-wrap;font:14px/1.8 system-ui,"Segoe UI",sans-serif;'
        + 'padding:32px;color:#e8e8e8;background:#1c1c1f;min-height:100vh;box-sizing:border-box;');
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mount, { once: true });
    } else {
      mount();
    }
  } catch (_e) {
    // 提示层自身的任何异常都不该影响页面：吞掉
  }
}());
