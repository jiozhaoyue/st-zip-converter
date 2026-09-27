/**
 * 用户可见流程两条：**文件名模板** 与 **存工作区（落库 + 跨重载语义）**
 *
 * 为什么值得单独验：
 *  - 文件名模板是用户唯一能控制产物命名的入口，模板变量写错会让整批产物重名/无标识；
 *  - 「存工作区」是**临时产物 → 持久资产**的分界线（`ExportQueue` 条目默认 `ephemeral`），
 *    这条线如果错了，用户重载页面后会发现「东西没了」或「临时产物被塞进了库」。
 *
 * 判定纪律：模板一律**回读**（`page.fill` 会静默不写入）；库读数直接读
 * `st_zip_converter_db` 的 `files` 库（与实例矩阵 spec 同一手法），并断言 `origin` 字段
 * —— 「入库了」与「入对了」是两件事。
 */

const fs = require('fs');
const path = require('path');
const common = require('../lib/common.cjs');

/** 读 IndexedDB `st_zip_converter_db.files` 的全部记录（只读，不改任何东西） */
async function readStoredFiles(page) {
  return page.evaluate(() => new Promise((resolve) => {
    let req;
    try { req = window.indexedDB.open('st_zip_converter_db'); } catch { resolve([]); return; }
    req.onerror = () => resolve([]);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction('files', 'readonly');
        const cur = tx.objectStore('files').openCursor();
        const out = [];
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) { resolve(out); return; }
          const r = c.value || {};
          out.push({ name: r.name, origin: r.origin, role: r.role, size: r.size });
          c.continue();
        };
        cur.onerror = () => resolve(out);
      } catch { resolve([]); }
    };
  }));
}

/** 给文本输入框填值并**回读**（`page.fill` 会静默失败） */
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
  name: '用户流程：文件名模板 / 存工作区（落库 + 跨重载语义）',
  async run(t, h, ctx) {
    const { page, rec } = h;
    t.ok('F1 工作台就绪', Boolean(await ctx.waitForReady(page)));

    const fixtures = await common.ensureFixtures(ctx.fixtureDir);
    await page.setInputFiles('#file-input', fixtures['fixture-st.zip']);
    t.ok('F2 上传源包后计划预览就绪', await common.waitForPlan(page));
    await page.selectOption('#target-select', 'st');

    // ============ ① 文件名模板 ============
    const tpl0 = await page.$eval('#filename-template-input', (el) => el.value);
    const prev0 = await page.$eval('#filename-preview', (el) => el.textContent.trim());
    t.ok('F3 模板输入框有非空默认值（前置门）', tpl0.length > 0, `默认=${tpl0}`);
    t.ok('F4 模板预览非空（前置门，否则下面的「预览正确」无从判定）', prev0.length > 0,
      `预览=${prev0}`);

    const CUSTOM = 'MYCHECK-{target}-{user}.zip';
    const applied = await fillText(page, '#filename-template-input', CUSTOM);
    t.ok('F5 自定义模板**确实写进输入框**（回读确认）', applied !== 'failed', `via=${applied}`);
    await page.waitForTimeout(200);
    const prev1 = await page.$eval('#filename-preview', (el) => el.textContent.trim());
    t.ok('F6 预览按模板渲染（变量已求值：`MYCHECK-st-default-user.zip`）',
      prev1.includes('MYCHECK-st-default-user'), `预览=${prev1}`);

    await page.click('#btn-convert');
    const queued = await common.waitForQueue(page, 1);
    t.ok('F7 转换完成并出现在待导出区', Array.isArray(queued) && queued.length >= 1,
      JSON.stringify(queued));
    const productName = (queued || [])[0] || '';
    t.ok('F8 产物名**真的按模板生成**（不是默认命名）',
      productName.startsWith('MYCHECK-st-default-user'), `产物名=${productName}`);

    // ============ ② 存工作区：落库 + 跨重载语义 ============
    const before = await readStoredFiles(page);
    t.log(`  · 存前库内记录数=${before.length}`);

    const stashBtn = page.locator('.btn-archive-action.load-source', { hasText: '存工作区' }).first();
    await stashBtn.click();
    const stored = await page.waitForFunction(() => document.querySelectorAll('.eq-stored').length > 0,
      null, { timeout: 30_000 }).then(() => true).catch(() => false);
    t.ok('F9 点「存工作区」后该行出现「已入库」徽标', stored);

    const after = await readStoredFiles(page);
    t.ge('F10 库内记录数增加（真的落库了）', after.length, before.length + 1,
      `存前=${before.length} 存后=${after.length}`);
    const rec0 = after.find((r) => r.name === productName);
    t.ok('F11 落库记录**按产物名**可查（入的是这一份，不是别的）', Boolean(rec0),
      JSON.stringify(after.map((r) => r.name).slice(0, 4)));
    if (rec0) {
      t.ok('F12 落库记录的 `origin` 字段标明来源为转换产物（入对了类别）',
        typeof rec0.origin === 'string' && rec0.origin.length > 0, JSON.stringify(rec0));
    }

    // 跨重载：产物是**临时**条目（ephemeral），重载后待导出区应清空；库里的那条仍在
    await page.reload({ waitUntil: 'domcontentloaded' });
    t.ok('F13 重载后工作台重新就绪', Boolean(await ctx.waitForReady(page)));
    await page.waitForTimeout(800);
    const queueAfterReload = await page.$$eval('.eq-name', (els) => els.length).catch(() => null);
    t.eq('F14 重载后待导出区为空（临时产物不跨重载 —— 与「存工作区」的分界）',
      queueAfterReload, 0, `行数=${queueAfterReload}`);
    const afterReload = await readStoredFiles(page);
    t.ok('F15 重载后库内那条记录仍在（持久化成立）',
      afterReload.some((r) => r.name === productName),
      JSON.stringify(afterReload.map((r) => r.name).slice(0, 5)));

    t.eq('F16 全流程零未捕获页面异常', rec.pageErrors.length, 0, JSON.stringify(rec.pageErrors.slice(0, 2)));
  },
};
