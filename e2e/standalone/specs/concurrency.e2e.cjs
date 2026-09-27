/**
 * 同源**双页签并发**转换（浏览器侧并发，与 Node 侧 `concurrent-writer.test.js` 不同）
 *
 * ## 为什么值得一条
 *
 * 真实用户会同时开好几个酒馆页签/好几个工作台；而本工具的持久层是**按 origin 共享**的
 * IndexedDB 工作区（`st_zip_converter_db`），另有一份内存态的 `ExportQueue` 与
 * `workbenchBusy`。两个页签同时转换时，**互相踩**的路径有几条：
 *
 *  - 两个页签都往 `files` 库写（文件名/记录冲突）；
 *  - 一个页签的产物与另一个的产物在 UI 上串了（各页签应只见自己的队列）；
 *  - Worker/内存压力下彼此把对方拖挂。
 *
 * Node 侧的并发用例验的是**同一个进程内的写入器**；浏览器里是**两个独立进程的页面**
 * 共享一个 origin 的存储 —— 这才是真实形态。
 *
 * ## 判据（都要求非空读数）
 *
 * 1. 两个页签**各自**都能完成转换并拿到产物；
 * 2. 两份产物**各自对应自己的源包**（用不同目标包名 + 不同夹具，按产物内容区分）；
 * 3. 两个页签的待导出区**各只有一行**（没有串到对方）；
 * 4. 全程两页都零未捕获异常。
 */

const common = require('../lib/common.cjs');
const { openSite, waitForReady } = require('../lib/harness.cjs');

/** 读某页的队列行名 */
async function queueNames(page) {
  return page.$$eval('.eq-name', (els) => els.map((e) => e.textContent.trim()));
}

module.exports = {
  name: '同源双页签并发转换（浏览器侧并发）',
  async run(t, h, ctx) {
    t.ok('C1 首个页签就绪', Boolean(await ctx.waitForReady(h.page)));

    // 第二个页签：**同一个 context 里再开一个 page**（= 真正的「双页签」：
    // 同源、共享 IndexedDB 工作区）。⚠️ 不能另开 context —— 那是独立存储分区，
    // 并发争抢持久层的前提就没了（首版这么写过，等于没测到"共享"这一层）。
    const page2 = await h.page.context().newPage();
    const rec2 = { pageErrors: [] };
    page2.on('pageerror', (e) => rec2.pageErrors.push(String((e && e.message) || e)));

    try {
      await page2.goto(ctx.baseUrl, { waitUntil: 'domcontentloaded' });
      t.ok('C2 第二个页签就绪（同源共享存储）', Boolean(await waitForReady(page2)));

      const fixtures = await common.ensureFixtures(ctx.fixtureDir);
      // 两个页签各自喂**不同的**源包（便于按产物内容区分谁是谁）
      await h.page.setInputFiles('#file-input', fixtures['fixture-st.zip']);
      await page2.setInputFiles('#file-input', fixtures['fixture-tt.zip']);
      t.ok('C3 两页各自计划就绪',
        (await common.waitForPlan(h.page)) && (await common.waitForPlan(page2)));

      // 目标也取不同（进一步区分）
      await h.page.selectOption('#target-select', 'st');
      await page2.selectOption('#target-select', 'l');

      // **同时**点转换（不 await 第一个，两个 Promise 并行等待）
      const p1 = common.waitForQueue(h.page, 1, 180_000);
      const p2 = common.waitForQueue(page2, 1, 180_000);
      await Promise.all([h.page.click('#btn-convert'), page2.click('#btn-convert')]);
      const [names1, names2] = await Promise.all([p1, p2]);

      t.ok('C4 两页**都**完成了转换并各有产物行（非空读数）',
        Array.isArray(names1) && names1.length >= 1 && Array.isArray(names2) && names2.length >= 1,
        JSON.stringify({ p1: names1, p2: names2 }));
      t.eq('C5 每页的待导出区各只有 **1** 行（没有串到对方）',
        `${(names1 || []).length}/${(names2 || []).length}`, '1/1',
        JSON.stringify({ p1: names1, p2: names2 }));
      t.ok('C6 两页的产物名各带自己的目标码（st / l）—— 证明没有互相覆盖',
        /st/.test((names1 || [])[0] || '') && /l_/.test((names2 || [])[0] || ''),
        JSON.stringify({ p1: names1, p2: names2 }));

      // 各自下载本页的产物并解包（产物体积也要非空）
      const out1 = await common.downloadNthRow(h.page, 0, ctx.fixtureDir, 'concurrent-p1.zip');
      const out2 = await common.downloadNthRow(page2, 0, ctx.fixtureDir, 'concurrent-p2.zip');
      const zip1 = await common.readZip(out1);
      const zip2 = await common.readZip(out2);
      t.ge('C7 页签 1 的产物是合法 zip 且条目数 > 0', zip1.names.length, 1, `entries=${zip1.names.length}`);
      t.ge('C8 页签 2 的产物是合法 zip 且条目数 > 0', zip2.names.length, 1, `entries=${zip2.names.length}`);
      // 页签 1 目标是 st（摊平）；页签 2 目标是 l（摊平 + 根 manifest.json）
      t.ok('C9 页签 1 的产物是 **ST 落位**（不含 data/ 前缀）',
        !zip1.names.some((n) => n.startsWith('data/')), JSON.stringify(zip1.names.slice(0, 5)));
      t.ok('C10 页签 2 的产物是 **L 落位**（根 manifest.json 在场）',
        zip2.names.includes('manifest.json'), JSON.stringify(zip2.names.slice(0, 5)));
      t.ok('C11 两份产物内容不同（各自对应自己的源包与目标，不是同一份被复制）',
        JSON.stringify(zip1.names) !== JSON.stringify(zip2.names),
        `p1=${zip1.names.length} 条 / p2=${zip2.names.length} 条`);

      t.eq('C12 页签 1 零未捕获异常', h.rec.pageErrors.length, 0,
        JSON.stringify(h.rec.pageErrors.slice(0, 2)));
      t.eq('C13 页签 2 零未捕获异常', rec2.pageErrors.length, 0,
        JSON.stringify(rec2.pageErrors.slice(0, 2)));
    } finally {
      await page2.close().catch(() => {});
    }
  },
};
