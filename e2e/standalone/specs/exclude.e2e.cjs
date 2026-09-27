/**
 * 类目内**逐文件排除**（`excludedPaths` 细粒度筛选）—— 验到产物
 *
 * 这是 README 里的头号特性（「宿主数据导出与细粒度筛选」），此前只有实例矩阵覆盖到
 * 「类目级勾选」（M-6 一带），**逐文件排除**这条在独立形态与产物侧都没验过。
 *
 * 判据链（每一环都要有非空读数）：
 *   1. 展开某类目的明细 → 明细行确实渲染出来（`.file-detail-row`）；
 *   2. 取消勾选其中一行 → 类目卡变为「部分选中」（`indeterminate`）**且**预计产物数下降；
 *   3. **转换后产物里真的没有那个文件**，而同类目里的其它条目照常在场 ——
 *      这才是「排除生效」的最终证据（只看 UI 读数会被"UI 变了但没传下去"骗过）。
 */

const path = require('path');
const common = require('../lib/common.cjs');

/**
 * 本用例自带夹具（不用迷你夹具）：**需要一个含 2 个文件的类目**。
 *
 * 为什么：`renderCategoryStats` 的勾选态是三值的 —— 该类目里**部分**文件被排除时才是
 * `indeterminate`；**全部**被排除时是「未勾选」。迷你夹具每个类目只有 1 个文件，
 * 于是「部分排除」这条根本走不到（首版据此断言 `indeterminate` ⇒ 一条假红）。
 */
function buildTwoWorldFixture(dir) {
  return common.buildZip(path.join(dir, 'exclude-fixture.zip'), [
    ['worlds/w1.json', Buffer.from('{"entries":{"0":{"uid":0,"key":["a"],"content":"one"}}}', 'utf8')],
    ['worlds/w2.json', Buffer.from('{"entries":{"0":{"uid":0,"key":["b"],"content":"two"}}}', 'utf8')],
    ['characters/C.png', Buffer.from('89504e470d0a1a0a', 'hex')],
    ['settings.json', Buffer.from('{"firstRun":false}', 'utf8')],
  ]);
}

module.exports = {
  name: '细粒度筛选：类目内逐文件排除（验到产物）',
  async run(t, h, ctx) {
    const { page, rec } = h;
    t.ok('X1 工作台就绪', Boolean(await ctx.waitForReady(page)));

    const fixture = await buildTwoWorldFixture(ctx.fixtureDir);
    await page.setInputFiles('#file-input', fixture);
    t.ok('X2 上传后计划预览就绪', await common.waitForPlan(page));

    const estBefore = await page.$eval('#output-estimate-text', (el) => el.textContent.trim());
    t.ok('X3 预计产物读数非空（前置门）', estBefore.length > 0, `预计产物=${estBefore}`);

    // ============ ① 展开「世界书」类目的明细 ============
    const expandBtn = page.locator('.category-card[data-category="lorebooks"] .btn-expand-detail').first();
    t.ok('X4 该类目卡有「明细」入口（读数非空）', await expandBtn.isVisible().catch(() => false));
    await expandBtn.click();
    const rowsAppeared = await page.waitForFunction(
      () => document.querySelectorAll('.category-card[data-category="lorebooks"] .file-detail-row').length > 0,
      null, { timeout: 15_000 },
    ).then(() => true).catch(() => false);
    t.ok('X5 明细行已渲染（本用例的类目里有 **2** 个文件 —— 部分排除才走得到 indeterminate）',
      rowsAppeared);

    const rows = await page.$$eval(
      '.category-card[data-category="lorebooks"] .file-detail-row',
      (els) => els.map((e) => ({
        src: ((e.querySelector('.file-src-path') || {}).textContent || '').trim(),
        checked: (e.querySelector('.file-item-checkbox') || {}).checked === true,
      })),
    );
    t.ge('X6 明细行读数非空（否则下面「排除某一个」无从谈起）', rows.length, 1, JSON.stringify(rows));
    const target = rows[0];
    t.ok('X7 目标行初始是**选中**的（前置门：否则"取消勾选"没有意义）',
      target.checked === true, JSON.stringify(target));

    // ============ ② 取消勾选这一行 ============
    await page.locator('.category-card[data-category="lorebooks"] .file-detail-row .file-item-checkbox')
      .first().uncheck({ force: true });
    await page.waitForTimeout(400);

    const card = await page.evaluate(() => {
      const c = document.querySelector('.category-card[data-category="lorebooks"]');
      const box = c ? c.querySelector('input[type="checkbox"]') : null;
      return box ? { checked: box.checked, indeterminate: box.indeterminate } : null;
    });
    // 三值语义：类目里**部分**文件被排除 ⇒ `indeterminate`（**全部**被排除则是「未勾选」）
    t.ok('X8 类目卡变为「部分选中」（`indeterminate`）—— 逐文件排除在 UI 上可见',
      card && card.indeterminate === true && card.checked === false, JSON.stringify(card));

    const estAfter = await page.$eval('#output-estimate-text', (el) => el.textContent.trim());
    const num = (s) => {
      const m = String(s).match(/(\d+)\s*个文件/);
      return m ? Number(m[1]) : null;
    };
    t.ok('X9 预计产物数**下降**（排除传到了计划层，而不是只在 UI 上变色）',
      num(estBefore) !== null && num(estAfter) !== null && num(estAfter) < num(estBefore),
      `前=${estBefore} 后=${estAfter}`);

    // ============ ③ 转换并在产物里核对 ============
    await page.selectOption('#target-select', 'st');
    await page.click('#btn-convert');
    const queued = await common.waitForQueue(page, 1);
    t.ok('X10 转换完成', Array.isArray(queued) && queued.length >= 1, JSON.stringify(queued));
    const out = await common.downloadNthRow(page, 0, ctx.fixtureDir, 'excluded.zip');
    const product = await common.readZip(out);

    const excludedName = target.src.replace(/\\/g, '/');
    t.ok('X11 **产物里没有**被排除的那个文件（逐文件排除真的生效到产物）',
      !product.names.includes(excludedName),
      `排除项=${excludedName} 产物=${JSON.stringify(product.names.slice(0, 8))}`);
    // 同一类目里**没被排除**的另一个文件必须还在 —— 这才是「逐文件」而不是「整类」的证据
    t.ok('X12 同类目里未被排除的另一个文件**照常在场**（逐文件 ≠ 整类）',
      product.names.includes('worlds/w2.json'),
      JSON.stringify(product.names.filter((n) => n.startsWith('worlds/'))));
    t.ok('X13 其它类目不受影响（角色卡与设置照常）',
      product.names.includes('characters/C.png') && product.names.includes('settings.json'),
      JSON.stringify(product.names.slice(0, 8)));
    t.ok('X14 产物仍非空且是合法 zip（前置门：上面那条"没有"不是因为包是空的）',
      product.names.length >= 4, `entries=${product.names.length}`);

    t.eq('X15 全流程零未捕获页面异常', rec.pageErrors.length, 0, JSON.stringify(rec.pageErrors.slice(0, 2)));
  },
};
