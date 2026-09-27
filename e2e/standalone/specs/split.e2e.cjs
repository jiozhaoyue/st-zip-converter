/**
 * 独立 Web 形态 · 智能分卷（分卷阈值）
 *
 * 为什么与 `workbench.e2e.cjs` 分开：分卷需要**换源包**（换成放大夹具），而
 * `#file-input` 的处理是「总是入库，仅在**尚无源包**时采纳为当前源」
 * （`index.js` —— 实测喂第二个包时计划读数纹丝不动）。宿主态有 `resetWorkspace()` 解这个结，
 * 独立态没有对应入口 ⇒ 最干净的做法是**换一个全新浏览器上下文**重开一局。
 *
 * 判据：
 *  - 阈值必须**真的写进去**（`page.fill` 会静默失败的教训，见矩阵 spec 的 `fillNumber`）；
 *  - 产物必须**真的切成多份**（一份也算「分卷没生效」，故断言 `>= 2`），
 *    且序号从 1 起连续；只验「队列里有行」会把单包判成通过。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let FIXTURE_DIR = '';

/** 放大夹具：SHA-256 计数器模式（不可压缩、确定性 —— LCG 低位周期短会被压掉，见矩阵 spec） */
function ensureLargeFixture() {
  const out = path.join(FIXTURE_DIR, 'fixture-web-split-st.zip');
  if (fs.existsSync(out)) return out;

  const CHUNK = 1024 * 1024;
  const FILES = 3;
  return (async () => {
    const { zipIo } = await import(require('url').pathToFileURL(
      path.resolve(__dirname, '../../../src/core/zip-io.js')).href);
    const writer = await zipIo.createWriter(out);
    await writer.add('characters/Fixture Character.png', Buffer.from('89504e470d0a1a0a', 'hex'));
    for (let i = 1; i <= FILES; i += 1) {
      const parts = [];
      for (let ctr = 0; parts.length * 32 < CHUNK; ctr += 1) {
        parts.push(crypto.createHash('sha256').update(`web-split:${i}:${ctr}`).digest());
      }
      // 首行是合法聊天头，其余为高熵正文（转换器按行处理，内容不必是真实聊天）
      const head = Buffer.from(`${JSON.stringify({ user_name: 'You', character_name: 'Fixture' })}\n`, 'utf8');
      await writer.add(`chats/Fixture/bulk-${i}.jsonl`, Buffer.concat([head, ...parts]));
    }
    await writer.close();
    return out;
  })();
}

async function fillNumber(page, selector, value) {
  const readValue = () => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.value : null;
  }, selector);
  await page.fill(selector, String(value)).catch(() => {});
  for (let i = 0; i < 6; i += 1) {
    if ((await readValue()) === String(value)) return 'fill';
    await page.waitForTimeout(150);
  }
  await page.evaluate(({ sel, v }) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, { sel: selector, v: String(value) });
  return (await readValue()) === String(value) ? 'evaluate' : 'failed';
}

async function waitForPlan(page, timeout = 60_000) {
  try {
    await page.waitForFunction(() => {
      const bar = document.getElementById('plan-summary-bar');
      const est = document.getElementById('output-estimate-text');
      return Boolean(bar) && getComputedStyle(bar).display !== 'none'
        && Boolean(est) && est.textContent.trim().length > 0;
    }, null, { timeout });
    return true;
  } catch { return false; }
}

async function waitForQueueCount(page, n, timeout = 120_000) {
  try {
    await page.waitForFunction((want) => document.querySelectorAll('.eq-name').length >= want,
      n, { timeout });
    return await page.$$eval('.eq-name', (els) => els.map((e) => e.textContent.trim()));
  } catch { return null; }
}

module.exports = {
  name: '独立 Web 形态：智能分卷（阈值真的生效 / 产物真的多份）',
  async run(t, h, ctx) {
    FIXTURE_DIR = ctx.fixtureDir;
    const { page, rec } = h;

    const badge = await ctx.waitForReady(page);
    t.ok('G1 工作台就绪', Boolean(badge), `badge=${badge}`);

    const fixture = await ensureLargeFixture();
    const size = fs.statSync(fixture).size;
    t.ge('G2 放大夹具已生成且 > 3 MB（小夹具切不出第二份）', size, 3 * 1024 * 1024,
      `${(size / 1048576).toFixed(1)} MB`);

    await page.setInputFiles('#file-input', fixture);
    t.ok('G3 上传放大包后计划预览就绪', await waitForPlan(page));

    const chatCount = await page.evaluate(() => {
      const badge2 = document.querySelector('.category-card[data-category="chats"] .cat-badge');
      const m = badge2 ? badge2.textContent.match(/(\d+)/) : null;
      return m ? Number(m[1]) : null;
    });
    t.ge('G4 放大包被真实解析（聊天类目 ≥ 3 条）', chatCount, 3, `chats=${chatCount}`);

    await page.selectOption('#target-select', 'st');
    const applied = await fillNumber(page, '#split-input', 1);
    t.ok('G5 分卷阈值 1 MB **确实写进输入框**（fill 静默失败时退回程序化赋值）',
      applied !== 'failed', `via=${applied}`);

    await page.click('#btn-convert');
    const names = await waitForQueueCount(page, 2, 180_000);
    t.ok('G6 分卷产物出现（≥ 2 份）', Array.isArray(names) && names.length >= 2,
      JSON.stringify(names));

    const parts = (names || []).map((n) => {
      const m = n.match(/part(\d+)/i);
      return m ? Number(m[1]) : null;
    }).filter((x) => x !== null);
    t.eq('G7 产物名都带 part 序号（没有漏掉序号的行）', parts.length, (names || []).length,
      JSON.stringify(names));
    t.ok('G8 part 序号从 1 起连续',
      parts.length > 0 && parts.every((v, i) => v === i + 1), JSON.stringify(parts));

    // 抽验第一份是**合法 zip**（只数队列行会把空壳判成通过）
    const first = path.join(FIXTURE_DIR, 'web-split-part1.zip');
    const dl = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      page.click('.btn-archive-action.download'),
    ]).then(([d]) => d);
    await dl.saveAs(first);
    const { zipIo } = await import(require('url').pathToFileURL(
      path.resolve(__dirname, '../../../src/core/zip-io.js')).href);
    const reader = await zipIo.openReader(first);
    let entries = 0;
    try { for await (const _e of reader.entries()) entries += 1; } finally { await reader.close(); }
    t.ge('G9 分卷产物是合法 zip 且条目数 > 0', entries, 1, `entries=${entries}`);

    t.eq('G10 全流程零页面异常', rec.pageErrors.length, 0, JSON.stringify(rec.pageErrors.slice(0, 2)));
  },
};
