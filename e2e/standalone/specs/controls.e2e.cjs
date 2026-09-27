/**
 * 控件边界契约：类目三键（全选 / 全不选 / 反选）· 模板非法值 · 分卷输入非法值
 *
 * 为什么值得一条：这些都是**用户随手就能触发**的边界，而它们的正确行为是「有定义的」
 * （回退到默认 / 归一为不分卷），不是「随便怎样都行」。断言的是那个定义，
 * 而不是当前恰好跑出来的样子。
 *
 * 判定纪律：输入一律**回读**（`page.fill` 会静默不写入）；「没崩」不算通过 ——
 * 每条都要有一个**正向读数**（勾选态、产物名、分卷数）作为判据。
 */

const path = require('path');
const common = require('../lib/common.cjs');

/** 读全部类目复选框的勾选态：{ key: checked } */
async function readCategoryChecks(page) {
  return page.evaluate(() => {
    const out = {};
    for (const c of document.querySelectorAll('.category-card')) {
      const box = c.querySelector('input[type="checkbox"]');
      out[c.dataset.category] = box ? { checked: box.checked, disabled: box.disabled } : null;
    }
    return out;
  });
}

/** 给文本输入框填值并回读 */
async function fillText(page, selector, value) {
  await page.fill(selector, value).catch(() => {});
  for (let i = 0; i < 6; i += 1) {
    const now = await page.$eval(selector, (el) => el.value).catch(() => null);
    if (now === value) return 'fill';
    await page.waitForTimeout(120);
  }
  await page.evaluate(({ sel, v }) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, { sel: selector, v: value });
  const after = await page.$eval(selector, (el) => el.value).catch(() => null);
  return after === value ? 'evaluate' : 'failed';
}

module.exports = {
  name: '控件边界：类目三键 / 模板非法值 / 分卷输入非法值',
  async run(t, h, ctx) {
    const { page, rec } = h;
    t.ok('K1 工作台就绪', Boolean(await ctx.waitForReady(page)));

    const fixtures = await common.ensureFixtures(ctx.fixtureDir);
    await page.setInputFiles('#file-input', fixtures['fixture-st.zip']);
    t.ok('K2 计划就绪', await common.waitForPlan(page));

    // ============ ① 类目三键 ============
    const initial = await readCategoryChecks(page);
    const enabledKeys = Object.entries(initial).filter(([, v]) => v && !v.disabled).map(([k]) => k);
    t.ge('K3 有可勾选的类目（读数非空）', enabledKeys.length, 3, JSON.stringify(enabledKeys));

    await page.click('#btn-deselect-all');
    await page.waitForTimeout(300);
    const none = await readCategoryChecks(page);
    t.eq('K4 「全不选」后**所有**可勾选类目都未勾选', enabledKeys.filter((k) => none[k].checked).length, 0,
      JSON.stringify(none));

    await page.click('#btn-invert-select');
    await page.waitForTimeout(300);
    const inverted = await readCategoryChecks(page);
    t.eq('K5 「反选」把未勾选的全部勾上（与「全不选」状态互补）',
      enabledKeys.filter((k) => inverted[k].checked).length, enabledKeys.length,
      JSON.stringify(inverted));

    await page.click('#btn-select-all');
    await page.waitForTimeout(300);
    const all = await readCategoryChecks(page);
    t.eq('K6 「全选」后全部勾选', enabledKeys.filter((k) => all[k].checked).length, enabledKeys.length,
      JSON.stringify(all));

    // ============ ② 文件名模板：非法/空值必须回退而不是产出怪名字 ============
    const tplInput = '#filename-template-input';
    const preview = () => page.$eval('#filename-preview', (el) => el.textContent.trim());

    const emptyApplied = await fillText(page, tplInput, '');
    t.ok('K7 空模板**确实写进输入框**（回读确认）', emptyApplied !== 'failed', `via=${emptyApplied}`);
    await page.waitForTimeout(200);
    const emptyPreview = await preview();
    t.ok('K8 空模板时预览**仍非空**（回退到默认命名，而不是显示空/崩掉）',
      emptyPreview.length > 0, `预览=${emptyPreview}`);

    const weirdApplied = await fillText(page, tplInput, 'a{未闭合-b.zip');
    t.ok('K9 含未闭合花括号的模板写进去了（回读确认）', weirdApplied !== 'failed');
    await page.waitForTimeout(200);
    const weirdPreview = await preview();
    t.ok('K10 非法模板下预览非空且仍是 .zip 名（未知占位符按字面/默认处理）',
      weirdPreview.length > 0 && /\.zip$/i.test(weirdPreview), `预览=${weirdPreview}`);

    // 用这个"怪"模板真转一次：产物名必须仍是可用的 .zip 名（不能让用户拿到坏名字）
    await page.selectOption('#target-select', 'st');
    await page.click('#btn-convert');
    const queued = await common.waitForQueue(page, 1, 120_000);
    const name = (queued || [])[0] || '';
    t.ok('K11 非法模板下产出的名字仍是**可用的 .zip 名**', /\.zip$/i.test(name), `产物名=${name}`);

    // ============ ③ 分卷输入：非法/超界值归一为「不分卷」 ============
    // 负数
    const negApplied = await common.fillNumber(page, '#split-input', -5);
    t.ok('K12 负数分卷阈值写进去了（回读确认）', negApplied !== 'failed', `via=${negApplied}`);
    await page.click('#btn-convert');
    const negNames = await common.waitForQueue(page, 2, 120_000);
    t.ok('K13 负数阈值 ⇒ **不分卷**（产出一份，而不是按负数切出怪结果）',
      Array.isArray(negNames) && negNames.length === 2, JSON.stringify(negNames));

    // 超大阈值（远超包体积）
    const bigApplied = await common.fillNumber(page, '#split-input', 9999);
    t.ok('K14 超大阈值写进去了（回读确认）', bigApplied !== 'failed', `via=${bigApplied}`);
    await page.click('#btn-convert');
    const bigNames = await common.waitForQueue(page, 3, 120_000);
    t.ok('K15 阈值远大于包体积 ⇒ **不分卷**（仍是一份）',
      Array.isArray(bigNames) && bigNames.length === 3, JSON.stringify(bigNames));

    t.eq('K16 全流程零未捕获页面异常', rec.pageErrors.length, 0, JSON.stringify(rec.pageErrors.slice(0, 2)));
  },
};
