/**
 * 小工具链：**只读扩展清单导出** · **日志面板展开/折叠** · **进度读数收尾**
 *
 * 三者都是"用户会点、但此前没有断言"的边角：
 *  - 清单导出是**审阅/分享**入口（清单契约 D-2）：产物是 **JSON、且不含扩展代码**；
 *  - 日志面板的**折叠态不追加行**是既有实现（矩阵踩过并记进规范），故它的展开/折叠语义值得钉住；
 *  - 进度读数收尾：转换结束后必须是 100%（而不是停在中间）。
 *
 * 「不含扩展代码」的判据是**精确**的：夹具里那个扩展的入口内容就是
 * `// fixture extension entrypoint` 这一行 —— 清单 JSON 里**不该出现它**。
 */

const common = require('../lib/common.cjs');

/** 日志面板当前的展开态与行数 */
async function readLogPanel(page) {
  return page.evaluate(() => {
    const body = document.getElementById('log-console-body');
    const rows = document.querySelectorAll('#log-stream-container > *').length;
    const text = (document.getElementById('log-stream-container') || {}).textContent || '';
    return {
      hasBody: Boolean(body),
      expanded: Boolean(body) && getComputedStyle(body).display !== 'none',
      rows,
      textLen: text.trim().length,
    };
  });
}

module.exports = {
  name: '小工具链：只读扩展清单 / 日志面板 / 进度收尾读数',
  async run(t, h, ctx) {
    const { page, rec } = h;
    t.ok('N1 工作台就绪', Boolean(await ctx.waitForReady(page)));

    const fixtures = await common.ensureFixtures(ctx.fixtureDir);
    await page.setInputFiles('#file-input', fixtures['fixture-st.zip']);
    t.ok('N2 计划就绪', await common.waitForPlan(page));

    // ============ ① 只读扩展清单导出 ============
    // ⚠️ 该按钮在**折叠区** `#fold-extension` 里 ⇒ 不展开它「不可见」，点击会 30 s 超时
    //    （首版就是这么假红的）。展开后还要**回读可见性**作为前置门。
    await page.click('#fold-extension .inline-drawer-toggle').catch(() => {});
    await page.waitForTimeout(400);
    const btnVisible = await page.evaluate(() => {
      const el = document.getElementById('btn-export-ext-manifest');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    t.ok('N2b 展开折叠区后清单按钮**真实可见**（前置门：否则点击必然超时）', btnVisible);

    const btn = await page.evaluate(() => {
      const el = document.getElementById('btn-export-ext-manifest');
      return el ? { present: true, disabled: el.disabled, title: el.title || '' } : { present: false };
    });
    t.ok('N3 清单导出按钮存在且可用（夹具里那个扩展被识别到了）',
      btn.present && btn.disabled === false, JSON.stringify(btn));
    t.ok('N4 按钮提示写明「不含扩展代码」（这是该能力的契约）',
      /不含扩展代码/.test(btn.title), `title=${btn.title}`);

    const rowsBefore = await page.$$eval('.eq-name', (els) => els.length);
    await page.click('#btn-export-ext-manifest');
    const names = await common.waitForQueue(page, rowsBefore + 1, 60_000);
    t.ok('N5 点一下即产出清单并进待导出区',
      Array.isArray(names) && names.length >= rowsBefore + 1, JSON.stringify(names));
    const manifestName = (names || [])[rowsBefore] || '';
    t.ok('N6 清单产物名是 `.json`（不是 zip —— 不写包）', /\.json$/i.test(manifestName),
      `name=${manifestName}`);

    const out = await common.downloadNthRow(page, rowsBefore, ctx.fixtureDir, 'ext-manifest.json');
    const fs = require('fs');
    t.ge('N7 清单文件非空（读数有效）', fs.statSync(out).size, 2, `bytes=${fs.statSync(out).size}`);
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* 下面断言会报 */ }
    t.ok('N8 清单是**合法 JSON**', Boolean(manifest),
      manifest ? `keys=${JSON.stringify(Object.keys(manifest).slice(0, 6))}` : '解析失败');
    const raw = fs.readFileSync(out, 'utf8');
    t.ok('N9 清单里含被识别的扩展名（`test-extension`）', /test-extension/.test(raw),
      raw.slice(0, 160));
    t.ok('N10 【关键】清单**不含扩展代码实体**（夹具扩展入口那一行不该出现）',
      !raw.includes('fixture extension entrypoint'), raw.slice(0, 200));

    // ============ ② 日志面板：展开/折叠语义 ============
    const before = await readLogPanel(page);
    t.ok('N11 日志面板容器存在（读数非空）', before.hasBody, JSON.stringify(before));
    await page.click('#btn-toggle-log');
    await page.waitForTimeout(400);
    const expandedNow = await readLogPanel(page);
    t.ok('N12 点「日志」后展开（`#log-console-body` 可见）', expandedNow.expanded,
      JSON.stringify(expandedNow));
    t.ok('N13 展开后**真的读到日志行**（折叠态是不追加行的 —— 这条同时守住那个坑）',
      expandedNow.textLen > 0 && expandedNow.rows > 0, JSON.stringify(expandedNow));
    await page.click('#btn-toggle-log');
    await page.waitForTimeout(400);
    const collapsed = await readLogPanel(page);
    t.ok('N14 再点一次折叠回去（切换语义）', collapsed.expanded === false, JSON.stringify(collapsed));

    // ============ ③ 进度读数收尾 ============
    await page.selectOption('#target-select', 'st');
    // ⚠️ 队列里**已经有**清单那一行 ⇒ `waitForQueue(1)` 会立刻返回（等于没等）。
    //    必须以"当前行数 + 1"为门槛（首版就是这么在 70% 时读了瞬时值 ⇒ 假红）。
    const rowsBeforeConvert = await page.$$eval('.eq-name', (els) => els.length);
    await page.click('#btn-convert');
    const queued = await common.waitForQueue(page, rowsBeforeConvert + 1, 120_000);
    t.ok('N15 转换完成并出产物', Array.isArray(queued) && queued.length >= rowsBeforeConvert + 1,
      JSON.stringify(queued));
    // 进度收尾要**有界等待**（不能读瞬时值）
    const settled = await page.waitForFunction(() => {
      const el = document.getElementById('progress-percent');
      return Boolean(el) && /100/.test(el.textContent);
    }, null, { timeout: 60_000 }).then(() => true).catch(() => false);
    const progress = await page.evaluate(() => ({
      percent: (document.getElementById('progress-percent') || {}).textContent || '',
      label: (document.getElementById('status-label') || {}).textContent || '',
      fillWidth: (() => {
        const f = document.getElementById('progress-bar-fill');
        return f ? f.style.width : null;
      })(),
    }));
    t.ok('N16 进度收尾读数 = 100%（有界等待，不是读瞬时值）',
      settled && /100/.test(progress.percent), JSON.stringify(progress));
    t.ok('N17 状态行给出了收尾文案（非空）', progress.label.trim().length > 0,
      JSON.stringify(progress));

    t.eq('N18 全流程零未捕获页面异常', rec.pageErrors.length, 0, JSON.stringify(rec.pageErrors.slice(0, 2)));
  },
};
