/**
 * 动作筛选（计划条上的 pill）：按「这个文件会被怎么处理」过滤明细
 *
 * 这是细粒度筛选的另一半 —— 类目勾选回答「要不要这一类」，动作筛选回答
 * 「只看被转换/透传/丢弃的那些」。二者共用同一份 `plan`，但**过滤路径不同**
 * （`activeActionFilter` + 明细行重建），故值得单独一条。
 *
 * 判据（可机器判定，不靠肉眼）：
 *  1. 计划条上有 pill 且带非零计数（前置门）；
 *  2. 点某个 pill 后：该 pill 变 `active`、出现「重置动作筛选」入口；
 *  3. **展开的明细里只剩该动作的行** —— 行自身的 class 里就带动作名
 *     （`file-detail-row <action>`），故这是确定性判据；
 *  4. 点「重置」后行数恢复（回到未过滤状态）。
 */

const path = require('path');
const common = require('../lib/common.cjs');

/** 本用例自带夹具：4 个条目、跨 3 个类目，足以产生多个动作 */
function buildFixture(dir) {
  return common.buildZip(path.join(dir, 'action-fixture.zip'), [
    ['worlds/w1.json', Buffer.from('{"entries":{}}', 'utf8')],
    ['worlds/w2.json', Buffer.from('{"entries":{}}', 'utf8')],
    ['characters/C.png', Buffer.from('89504e470d0a1a0a', 'hex')],
    ['thumbnails/cache.png', Buffer.from('89504e470d0a1a0a', 'hex')],
    ['settings.json', Buffer.from('{"firstRun":false}', 'utf8')],
  ]);
}

/**
 * 展开所有**折叠态**的类目，返回可见明细行的动作 class 列表。
 *
 * ⚠️ **必须幂等**：展开按钮是**切换**语义（`收起 ▴` ⇄ `明细 ▾`）。首版无脑点所有按钮，
 * 于是点 pill 之后（pill 会自动展开含该动作的类目）这里又把它**折叠回去** ⇒ 读到 0 行
 * ⇒ A7 假红（现象是"过滤后明细空了"，看着像功能坏了）。只点标签含「明细」的那些。
 */
async function expandAllAndReadActions(page) {
  const expanders = page.locator('.category-card .btn-expand-detail');
  const n = await expanders.count();
  for (let i = 0; i < n; i += 1) {
    const label = (await expanders.nth(i).textContent().catch(() => '')) || '';
    if (label.includes('明细')) await expanders.nth(i).click().catch(() => {});
  }
  await page.waitForTimeout(400);
  return page.$$eval('.file-detail-row', (rows) => rows.map((r) => ({
    src: ((r.querySelector('.file-src-path') || {}).textContent || '').trim(),
    classes: Array.from(r.classList).filter((c) => c !== 'file-detail-row'),
  })));
}

module.exports = {
  name: '细粒度筛选：动作筛选 pill（只看某类处理动作的文件）',
  async run(t, h, ctx) {
    const { page, rec } = h;
    t.ok('A1 工作台就绪', Boolean(await ctx.waitForReady(page)));

    await page.setInputFiles('#file-input', await buildFixture(ctx.fixtureDir));
    t.ok('A2 上传后计划预览就绪', await common.waitForPlan(page));

    // ① 计划条上的 pill
    const pills = await page.$$eval('.action-summary-pill', (els) => els.map((e) => ({
      text: e.textContent.trim(),
      cls: Array.from(e.classList).find((c) => c.startsWith('pill-')) || '',
    })));
    t.ge('A3 计划条上有动作 pill（读数非空 —— 否则本用例无从下手）', pills.length, 1,
      JSON.stringify(pills));

    // ② 先取一遍「未过滤」的明细行（作为基线读数）
    const before = await expandAllAndReadActions(page);
    t.ge('A4 展开后明细行非空（基线读数）', before.length, 1, JSON.stringify(before.slice(0, 4)));
    const baselineCount = before.length;

    // 选一个**确实出现在明细里**的 pill（按其 pill 类名与行 class 对齐）
    const rowClasses = new Set(before.flatMap((r) => r.classes));
    const pick = pills.find((p) => rowClasses.has(p.cls.replace('pill-', '')));
    t.ok('A5 找到一个与明细行动作对得上的 pill（可判定的筛选目标）', Boolean(pick),
      `pills=${JSON.stringify(pills)} rows=${JSON.stringify([...rowClasses])}`);
    if (!pick) return;

    // ③ 点它
    await page.locator(`.action-summary-pill.${pick.cls}`).first().click();
    await page.waitForTimeout(500);
    const state = await page.evaluate((cls) => {
      const el = document.querySelector(`.action-summary-pill.${cls}`);
      return {
        active: Boolean(el && el.classList.contains('active')),
        hasReset: Boolean(document.querySelector('.btn-clear-action-filter')),
      };
    }, pick.cls);
    t.ok('A6 点击后该 pill 变「active」且出现「重置动作筛选」入口',
      state.active && state.hasReset, JSON.stringify(state));

    // ④ 过滤后：明细里应只剩该动作的行
    const after = await expandAllAndReadActions(page);
    // 诊断读数（A7 首版为 0 —— 需要看清"是没渲染行，还是展开态被重置"）
    const diag = await page.evaluate(() => Array.from(document.querySelectorAll('.category-card')).map((c) => ({
      key: c.dataset.category,
      hasRows: c.querySelectorAll('.file-detail-row').length,
      hasExpand: Boolean(c.querySelector('.btn-expand-detail')),
      expandLabel: ((c.querySelector('.btn-expand-detail') || {}).textContent || '').trim(),
    })));
    t.log(`  · 诊断：pick=${pick.cls} 过滤后行=${after.length} 类目态=${JSON.stringify(diag)}`);
    const wanted = pick.cls.replace('pill-', '');
    const wrong = after.filter((r) => !r.classes.includes(wanted));
    t.ge('A7 过滤后明细仍非空（否则"只剩该动作"恒真）', after.length, 1,
      JSON.stringify(after.slice(0, 4)));
    t.eq('A8 **明细里只剩该动作的行**（确定性判据：行 class 自带动作名）',
      wrong.length, 0, JSON.stringify(wrong.slice(0, 4)));
    t.ok('A9 过滤确实**收窄**了集合（行数 ≤ 基线；否则等于没过滤）',
      after.length <= baselineCount, `基线=${baselineCount} 过滤后=${after.length}`);

    // ⑤ 重置 → 恢复
    await page.locator('.btn-clear-action-filter').first().click();
    await page.waitForTimeout(500);
    const restoredRows = await expandAllAndReadActions(page);
    t.eq('A10 点「重置动作筛选」后**行数回到基线**（过滤彻底解除）',
      restoredRows.length, baselineCount, `基线=${baselineCount} 重置后=${restoredRows.length}`);
    const resetGone = await page.evaluate(() => !document.querySelector('.btn-clear-action-filter'));
    t.ok('A11 重置后「重置动作筛选」入口消失（状态真的复位）', resetGone);

    t.eq('A12 全流程零未捕获页面异常', rec.pageErrors.length, 0, JSON.stringify(rec.pageErrors.slice(0, 2)));
  },
};
