/**
 * 暂存区（源包列表）流转：上传 → 第二个包只入库 → **载入为源** → 删除
 *
 * ## 为什么值得单独一条
 *
 * `#file-input` 的处理是「总是入库，**仅在尚无源包时**采纳为当前源」。这条设计本身合理
 * （避免误喂一个包就把你正在调的目标/勾选冲掉），但它是个**静默**的坑：
 *
 *  - 用户以为「我又喂了一个包」= 换了源包，实际没有 —— UI 上唯一能看出来的就是暂存区里
 *    多了一张卡、而「当前源」徽标仍钉在旧卡上；
 *  - **本仓已经因此付过两次代价**：本轮性能用例首版就在同一个页面里连喂三个包，
 *    结果三轮量的都是第一个包（66 MB 用例量出 12 MB 包的耗时，读数"308 MB/s"一眼假）；
 *    实例矩阵 spec 也踩过同一个坑并留了注。
 *
 * 故这条用例把「喂第二个包 ≠ 换源」与「换源要走『载入』」**钉成断言**：
 * 谁将来改了这条语义（无论方向），都会在这里看到红。
 *
 * 判定依据是**读数**而不是时序：当前源由暂存区卡上的「当前源」徽标（`.badge-active-file`）确定。
 */

const common = require('../lib/common.cjs');

module.exports = {
  name: '暂存区流转：喂第二个包 ≠ 换源 / 载入为源 / 删除',
  async run(t, h, ctx) {
    const { page, rec } = h;
    // ⚠️ 删除走的是**原生确认弹窗**（`window.confirm` 一类）：Playwright **默认会自动 dismiss**，
    //    于是「点了删除但卡片没走」看起来像功能坏了（首版就是这条假红）。这里显式接受。
    page.on('dialog', (d) => { d.accept().catch(() => {}); });
    t.ok('S1 工作台就绪', Boolean(await ctx.waitForReady(page)));

    /** 读暂存区：卡片数 + 每张卡的名字与「是否当前源」 */
    const readStash = () => page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('#stash-list .archive-card'));
      return cards.map((c) => ({
        // ⚠️ 暂存区卡片的**名字类名与待导出区不同**：这里是 `.archive-name`
        //    （`.eq-name` 只在 `export-queue.js` 里用）。首版读错选择器 ⇒ 名字恒为空串，
        //    于是三条「名字对不对」的断言全红。
        name: ((c.querySelector('.archive-name') || c.querySelector('.eq-name') || {}).textContent || '').trim(),
        active: c.classList.contains('active') || Boolean(c.querySelector('.badge-active-file')),
      }));
    });

    const fixtures = await common.ensureFixtures(ctx.fixtureDir);
    const stPath = fixtures['fixture-st.zip'];
    const ttPath = fixtures['fixture-tt.zip'];

    // ============ ① 初始：清空态 ============
    const empty = await readStash();
    t.eq('S2 初始无源包时暂存区没有卡片（读数非空 ⇒ 选择器确实匹配得上）', empty.length, 0,
      JSON.stringify(empty));

    // ============ ② 第一个包：成为当前源 ============
    await page.setInputFiles('#file-input', stPath);
    t.ok('S3 上传第一个包后计划预览就绪', await common.waitForPlan(page));
    await page.waitForTimeout(400);
    const one = await readStash();
    t.eq('S4 暂存区出现 1 张卡', one.length, 1, JSON.stringify(one));
    t.ok('S5 该卡是**当前源**（有「当前源」徽标）', one[0] && one[0].active === true,
      JSON.stringify(one));

    // ============ ③ 第二个包：**只入库，不换源**（这就是那个静默的坑） ============
    await page.setInputFiles('#file-input', ttPath);
    await page.waitForTimeout(800);
    const two = await readStash();
    t.eq('S6 暂存区变成 2 张卡（第二个包确实入库了）', two.length, 2, JSON.stringify(two));
    const activeNames = two.filter((c) => c.active).map((c) => c.name);
    t.eq('S7 【钉死语义】喂第二个包**不会**换源 —— 当前源仍是第一个包（且只有一个）',
      activeNames.length, 1, JSON.stringify(two));
    t.ok('S8 当前源的名字仍指向第一个包（fixture-st）',
      activeNames[0] && activeNames[0].includes('fixture-st'), JSON.stringify(activeNames));

    // ============ ④ 换源要走「载入」 ============
    const ttCard = page.locator('#stash-list .archive-card', { hasText: 'fixture-tt' }).first();
    await ttCard.locator('.btn-archive-action.load').click();
    await page.waitForFunction(() => {
      const cards = Array.from(document.querySelectorAll('#stash-list .archive-card'));
      const act = cards.filter((c) => c.classList.contains('active') || c.querySelector('.badge-active-file'));
      return act.length === 1
        && /fixture-tt/.test((act[0].querySelector('.archive-name') || {}).textContent || '');
    }, null, { timeout: 30_000 }).then(() => true).catch(() => false)
      .then((ok) => t.ok('S9 点「载入」后当前源**确实切到第二个包**（徽标移动 + 唯一）', ok));
    // 换源后计划会重算 → 再给一次读数，确认 UI 没有卡在旧状态
    t.ok('S10 换源后计划预览仍在（工作台没有卡死）',
      await common.waitForPlan(page, 30_000));
    const afterSwitch = await readStash();
    t.eq('S11 换源不影响暂存区条数', afterSwitch.length, 2, JSON.stringify(afterSwitch));

    // ============ ⑤ 删除（走行内「⋯」菜单） ============
    const stCard = page.locator('#stash-list .archive-card', { hasText: 'fixture-st' }).first();
    await stCard.locator('.btn-archive-action.more').click();
    await page.waitForTimeout(300);
    const delBtn = page.locator('text=删除').first();
    const delOk = await delBtn.isVisible().catch(() => false);
    t.ok('S12 行内「⋯」菜单里有「删除」入口（读数非空）', delOk);
    if (delOk) {
      await delBtn.click();
      // 删除可能需要确认（宿主原生确认弹窗或自绘）—— 有则点确认
      await page.waitForTimeout(400);
      const confirmBtn = page.locator('.popup-button-ok, #dialogue_popup_ok, button:has-text("确定"), button:has-text("确认")').first();
      if (await confirmBtn.isVisible().catch(() => false)) await confirmBtn.click();
      const gone = await page.waitForFunction(
        () => document.querySelectorAll('#stash-list .archive-card').length === 1,
        null, { timeout: 20_000 },
      ).then(() => true).catch(() => false);
      t.ok('S13 删除后暂存区只剩 1 张卡', gone, JSON.stringify(await readStash()));
      const left = await readStash();
      t.ok('S14 剩下的是被载入为源的那个包，且它仍是当前源',
        left[0] && left[0].name.includes('fixture-tt') && left[0].active === true,
        JSON.stringify(left));
    }

    t.eq('S15 全流程零未捕获页面异常', rec.pageErrors.length, 0, JSON.stringify(rec.pageErrors.slice(0, 2)));
  },
};
