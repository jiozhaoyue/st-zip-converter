/**
 * `file://`（双击打开）形态的**边界登记**
 *
 * 本仓用户级规则里有 `htmlc2r`（双击即运行）这一前端偏好，本仓的独立形态是否满足它
 * 此前**从未被验证过**，本 spec 就是来把这件事测清楚、并把结论钉成契约的。
 *
 * ## 为什么值得单独一条
 *
 * 构建产物用的是 `base: './'` + `<script type="module">`。而**现代浏览器对 `file://` 下的
 * ES Module 有一道硬门**：模块脚本按 CORS 语义加载，`file://` 的 origin 是 `null`
 * ⇒ 模块请求被拒。也就是说「双击 index.html」与「HTTP 提供同一份产物」**不是同一件事**，
 * 而用户会以为它们是一件事。
 *
 * ## 判定口径
 *
 * 本 spec 不断言「它一定能跑」——那是给产品加能力，不是单条 E2E 能决定的事。
 * 它断言的是**已登记的边界**：在当前架构下双击打开**不会**得到可用工作台，
 * 且失败原因**可归因为模块加载被拒**（而不是本插件的逻辑错误）。
 * 若将来有人把它做通了，这条会**转红**，从而强制一次显式决策（要么更新契约，要么回退）。
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

module.exports = {
  name: '`file://` 双击形态：边界登记（模块加载被 CORS 拒）',
  async run(t, h, ctx) {
    const distIndex = path.join(ctx.repoRoot, 'dist', 'index.html');
    t.ok('L1 构建产物存在（前置门）', fs.existsSync(distIndex), distIndex);

    const fileUrl = pathToFileURL(distIndex).href;
    const { page, rec } = h;

    // 直接导航到 file://（与 HTTP 形态是两回事）
    await page.goto(fileUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(2500);

    const state = await page.evaluate(() => ({
      url: location.href,
      protocol: location.protocol,
      // 骨架 <div id="app"> 是 index.html 自带的，所以它一定在；
      // 关键是 bootstrap() 有没有把它填上内容
      appChildren: (document.getElementById('app') || { children: [] }).children.length,
      appText: ((document.getElementById('app') || {}).textContent || '').trim().slice(0, 120),
      hasBadge: Boolean(document.getElementById('env-badge')),
      hasFileInput: Boolean(document.getElementById('file-input')),
      // 那层「友好提示」是**经典脚本**（非 module）装的 —— 它在 file:// 下能正常加载
      noticeLoaded: Boolean(document.querySelector('script[src*="file-protocol-notice"]')),
    }));
    t.log(`  · 读数：${JSON.stringify(state)}`);
    t.eq('L2 确实在 file:// 协议下（读数有效，不是跑成了 HTTP）', state.protocol, 'file:',
      state.url);

    // 失败必须**可归因**：要么是模块脚本被 CORS 拒（本架构的既有边界），
    // 要么是别的明确原因。这里把两个可能的读数都记下来。
    const moduleBlocked = [
      ...rec.consoleErrors.map((e) => e.text),
      ...rec.pageErrors.map((e) => String(e)),
      ...rec.failedRequests.map((f) => `${f.url} ${f.error}`),
    ];

    t.eq('L3 【边界登记】当前架构下双击打开**不会**得到可用工作台（`#app` 仍为空）',
      state.appChildren, 0, JSON.stringify(state));
    t.eq('L4 【边界登记】工作台控件未就绪（`#file-input` 不存在）', state.hasFileInput, false,
      JSON.stringify(state));
    t.ok('L5 失败原因**可归因**于模块/资源加载（不是本插件的逻辑错误）',
      moduleBlocked.length > 0, JSON.stringify(moduleBlocked.slice(0, 4)));
    t.ok('L6 【友好提示】`#app` 里给出了**可照做的说明**（而不是白屏）',
      /HTTP|npm run dev|不能靠/.test(state.appText), JSON.stringify(state.appText));
    t.log('  · 说明：独立形态需要经 **HTTP(S) 提供**（`npm run dev` / 任意静态服务器 / 云托管）。'
      + '云子路径形态由 `workbench.e2e.cjs` 覆盖；本 spec 钉住「双击」这条边界与那层提示。');
  },
};
