/**
 * 批量转换（暂存区多选 → 逐个转换）—— U-7 入口的独立形态覆盖
 *
 * 为什么值得单独一条：批量路径与单包路径**共用同一套转换参数面**（类目/排除/压缩/模板），
 * 但它多了一层「子项游标 + 每子项重置断点清单」的编排（`index.js` 的批量核），
 * 而实例矩阵里的 M-10 只能验证「行数增长」——**产物内容**那条没验过。
 *
 * 本用例的**判别力设计**：把文件名模板设成 `{source}-{target}.zip`，于是
 * **两个子项必须产出两个不同的名字**（分别含 `fixture-st` / `fixture-tt`）。
 * 若批量核只转了第一个包（或两个包互相覆盖），这条立刻转红。
 */

const common = require('../lib/common.cjs');

module.exports = {
  name: '批量转换：多选源包逐个转换（产物名按源包区分）',
  async run(t, h, ctx) {
    const { page, rec } = h;
    t.ok('B1 工作台就绪', Boolean(await ctx.waitForReady(page)));

    const fixtures = await common.ensureFixtures(ctx.fixtureDir);
    // 两个**源包不同**的夹具（st 摊平 / tt 带 data 前缀）
    await page.setInputFiles('#file-input', fixtures['fixture-st.zip']);
    t.ok('B2 第一个包上传后计划就绪', await common.waitForPlan(page));
    await page.setInputFiles('#file-input', fixtures['fixture-tt.zip']);
    await page.waitForTimeout(600);
    const cards = await page.$$eval('#stash-list .archive-card .archive-name',
      (els) => els.map((e) => e.textContent.trim()));
    t.ge('B3 暂存区有两个包（读数非空 ⇒ 选择器匹配得上）', cards.length, 2, JSON.stringify(cards));

    // 批量条：无选择时必须隐藏（可见性契约）
    const barHidden = await page.$eval('#stash-batch-bar', (el) => el.hidden);
    t.eq('B4 未选择任何包时批量条**隐藏**', barHidden, true);

    // 勾选两个包
    const boxes = page.locator('#stash-list .stash-select-box');
    const boxCount = await boxes.count();
    t.eq('B5 暂存区每张卡都有选择框', boxCount, cards.length, `boxes=${boxCount}`);
    for (let i = 0; i < boxCount; i += 1) await boxes.nth(i).check({ force: true });
    const barVisible = await page.waitForFunction(
      () => { const el = document.getElementById('stash-batch-bar'); return el && !el.hidden; },
      null, { timeout: 10_000 },
    ).then(() => true).catch(() => false);
    t.ok('B6 勾选后批量条出现（可见性由「选中非空」决定）', barVisible);

    // 文件名模板设成 `{source}-{target}.zip` —— 这是本用例判别力的来源
    const tplApplied = await page.evaluate(() => {
      const el = document.getElementById('filename-template-input');
      if (!el) return 'missing';
      el.value = '{source}-{target}.zip';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value;
    });
    t.eq('B7 文件名模板已设为 `{source}-{target}.zip`（回读确认）', tplApplied,
      '{source}-{target}.zip');
    await page.selectOption('#target-select', 'st');
    await page.waitForTimeout(150);

    // 点批量转换
    const batchBtn = page.locator('#stash-batch-bar button', { hasText: '批量转换' }).first();
    t.ok('B8 批量条里有「批量转换」入口', await batchBtn.isVisible().catch(() => false));
    await batchBtn.click();

    const names = await common.waitForQueue(page, 2, 240_000);
    t.ok('B9 批量转换产出**两行**（两个子项都被转了）',
      Array.isArray(names) && names.length >= 2, JSON.stringify(names));
    const joined = (names || []).join(' | ');
    t.ok('B10 两个产物的名字各自带**自己的源包名**（fixture-st / fixture-tt）—— '
      + '证明批量核逐个转换且没有互相覆盖',
      /fixture-st/.test(joined) && /fixture-tt/.test(joined), joined);
    t.eq('B11 两个产物名互不相同（不是同一份被报了两遍）',
      new Set(names || []).size, (names || []).length, JSON.stringify(names));

    // 抽验两行都是**合法 zip**（只数行数会把空壳判成通过）
    for (let i = 0; i < Math.min(2, (names || []).length); i += 1) {
      // eslint-disable-next-line no-await-in-loop —— 逐份下载抽验，次序即队列次序
      const out = await common.downloadNthRow(page, i, ctx.fixtureDir, `batch-${i}.zip`);
      // eslint-disable-next-line no-await-in-loop
      const product = await common.readZip(out);
      t.ge(`B12.${i} 第 ${i + 1} 份产物是合法 zip 且条目数 > 0`, product.names.length, 1,
        JSON.stringify(product.names.slice(0, 4)));
      t.ok(`B13.${i} 第 ${i + 1} 份产物里含角色卡与聊天条目`,
        product.names.some((n) => n.startsWith('characters/'))
        && product.names.some((n) => n.startsWith('chats/')),
        JSON.stringify(product.names.slice(0, 6)));
    }

    // 报告面板应给出本批的合计读数
    const reportReady = await page.waitForFunction(() => {
      const p = document.getElementById('report-panel');
      return Boolean(p) && !p.hidden;
    }, null, { timeout: 20_000 }).then(() => true).catch(() => false);
    t.ok('B14 批量结束后报告面板出现', reportReady);
    const chats = await common.readReportCount(page, 'count-chats');
    // ⚠️ 首版这里断言 `>= 2`（我以为是两个包各一条的**合计**）⇒ 一条假红。
    //    实测语义是：报告面板显示的是**最后一个子项**的报告（1 条），
    //    批量的合计视图是**待导出区**（N 行，见 B9）。断言按实现语义写，不按想象写。
    t.ge('B15 报告面板有内容（**最后一个子项**的报告；批量合计看待导出区行数）',
      chats, 1, `count-chats=${chats}（本批 2 个子项 ⇒ 队列 2 行，报告只呈现最后一个）`);

    t.eq('B16 全流程零未捕获页面异常', rec.pageErrors.length, 0, JSON.stringify(rec.pageErrors.slice(0, 2)));
  },
};
