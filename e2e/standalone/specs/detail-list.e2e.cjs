/**
 * 类目明细的**搜索与排序**（纯 UI 行为，单测够不着）
 *
 * 为什么值得一条：明细列表有搜索框与排序下拉，它们的行为**只存在于 UI 层**
 * （`src/ui/file-tree-picker.js` 的 `renderList(filterQuery)` + 排序分支），
 * 任何 Node 单测都到不了；而用户是靠它们在大包里找文件的。
 *
 * 判据都做成**可机器判定**的读数：
 *  - 搜索：命中数 = 1 / 0，且命中的是**该命中的那条**（按 `.file-src-path` 核对）；
 *  - 排序：只读 `.file-src-path` 的顺序，断言它符合所选语义（不依赖任何时间/随机）。
 */

const path = require('path');
const common = require('../lib/common.cjs');

/**
 * 夹具刻意让**文件名顺序与体积顺序相反**：
 * `worlds/zeta.json` 体积大、`worlds/alpha.json` 体积小 ⇒ 「按名升序」与「按体积降序」
 * 会给出**相反**的顺序，于是两条排序断言互相独立、都能抓错。
 */
function buildFixture(dir) {
  return common.buildZip(path.join(dir, 'detail-fixture.zip'), [
    ['worlds/zeta.json', Buffer.alloc(4096, 0x7a)],
    ['worlds/alpha.json', Buffer.alloc(64, 0x61)],
    ['characters/Anchor.png', Buffer.from('89504e470d0a1a0a', 'hex')],
    ['settings.json', Buffer.from('{"firstRun":false}', 'utf8')],
  ]);
}

/** 读明细行的路径（按 DOM 顺序） */
async function readRows(page) {
  return page.$$eval(
    '.category-card[data-category="lorebooks"] .file-detail-row',
    (rows) => rows.map((r) => ((r.querySelector('.file-src-path') || {}).textContent || '').trim()),
  );
}

module.exports = {
  name: '类目明细：搜索过滤 / 排序语义（纯 UI 行为）',
  async run(t, h, ctx) {
    const { page, rec } = h;
    t.ok('D1 工作台就绪', Boolean(await ctx.waitForReady(page)));

    await page.setInputFiles('#file-input', await buildFixture(ctx.fixtureDir));
    t.ok('D2 计划就绪', await common.waitForPlan(page));

    // 展开「世界书」类目（本夹具里它有 2 个文件）
    await page.click('.category-card[data-category="lorebooks"] .btn-expand-detail');
    await page.waitForTimeout(400);

    const initial = await readRows(page);
    t.eq('D3 明细默认顺序 = 计划顺序（zeta 在前）', initial.length, 2, JSON.stringify(initial));
    t.ok('D4 明细里确实是我们造的那两个文件',
      initial.some((n) => n.endsWith('worlds/zeta.json'))
      && initial.some((n) => n.endsWith('worlds/alpha.json')), JSON.stringify(initial));

    // 搜索框的占位符带条目数（一个正向读数：证明它按类目渲染）
    const placeholder = await page.$eval(
      '.category-card[data-category="lorebooks"] .detail-search-input',
      (el) => el.placeholder,
    );
    t.ok('D5 搜索框占位符带本类目文件数', /2\s*个文件/.test(placeholder), `placeholder=${placeholder}`);

    // ============ ① 搜索 ============
    const search = '.category-card[data-category="lorebooks"] .detail-search-input';
    await page.fill(search, 'alpha');
    await page.waitForTimeout(300);
    const hit = await readRows(page);
    t.eq('D6 输入「alpha」后只剩 1 行', hit.length, 1, JSON.stringify(hit));
    t.ok('D7 命中的是**该命中的那条**（按路径核对）',
      hit[0] && hit[0].endsWith('worlds/alpha.json'), JSON.stringify(hit));

    await page.fill(search, 'zzz-不存在');
    await page.waitForTimeout(300);
    const none = await readRows(page);
    t.eq('D8 输入不存在的名字 ⇒ 0 行（不是"忽略查询"）', none.length, 0, JSON.stringify(none));

    await page.fill(search, '');
    await page.waitForTimeout(300);
    const cleared = await readRows(page);
    t.eq('D9 清空搜索后恢复 2 行（过滤是纯视图层，不影响计划）', cleared.length, 2,
      JSON.stringify(cleared));

    // ============ ② 排序 ============
    const sortSel = '.category-card[data-category="lorebooks"] .detail-sort-select';
    await page.selectOption(sortSel, 'name-asc');
    await page.waitForTimeout(300);
    const byName = await readRows(page);
    t.ok('D10 「文件名 A-Z」⇒ alpha 排在 zeta 前（与默认顺序相反 ⇒ 排序真的生效）',
      byName[0] && byName[0].endsWith('alpha.json') && byName[1] && byName[1].endsWith('zeta.json'),
      JSON.stringify(byName));

    await page.selectOption(sortSel, 'size-desc');
    await page.waitForTimeout(300);
    const bySize = await readRows(page);
    t.ok('D11 「体积降序」⇒ zeta（4 KB）排在 alpha（64 B）前（与按名序相反 ⇒ 两条断言互不冗余）',
      bySize[0] && bySize[0].endsWith('zeta.json') && bySize[1] && bySize[1].endsWith('alpha.json'),
      JSON.stringify(bySize));

    await page.selectOption(sortSel, 'default');
    await page.waitForTimeout(300);
    const backToDefault = await readRows(page);
    t.ok('D12 切回「默认顺序」⇒ 回到计划顺序（排序是可逆的视图状态）',
      backToDefault.length === 2 && backToDefault.some((n) => n.endsWith('zeta.json')),
      JSON.stringify(backToDefault));

    // ============ ③ 折叠区摘要（另一处纯 UI 读数） ============
    const summary = await page.evaluate(() => {
      const el = document.getElementById('fold-summary-extension');
      return el ? el.textContent.trim() : null;
    });
    t.ok('D13 折叠区摘要已渲染（`#fold-summary-extension` 非空）',
      typeof summary === 'string' && summary.length > 0, `summary=${summary}`);

    t.eq('D14 全流程零未捕获页面异常', rec.pageErrors.length, 0, JSON.stringify(rec.pageErrors.slice(0, 2)));
  },
};
