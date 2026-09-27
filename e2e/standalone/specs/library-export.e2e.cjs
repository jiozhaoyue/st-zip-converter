/**
 * 「从聊天库导出」——纯库模式下**只有库、没有源包**时的导出出口
 *
 * 覆盖（两条对照）：
 *  - **无库**：按钮**不可见**（默认路径零变化 —— 不能让一个点了必然失败的按钮出现在绝大多数用户面前）；
 *  - **有库**（`page.addInitScript` 注入桩供给方）：按钮可见可用 → 点一下 → 产物进待导出区 →
 *    下载并解包核对：库里的聊天确实在产物里、隐藏容器被过滤、目标落位正确。
 *
 * 判据强度：只验「队列里有一行」是不够的（空包也会有一行），故一路验到 zip 内容。
 */

const common = require('../lib/common.cjs');

/** 桩供给方：两条可导出聊天（含一条带角色子目录）+ 一条隐藏容器 */
const STUB = ({ chats }) => {
  globalThis.ChatFilesysApi = Object.freeze({
    apiVersion: 1,
    capabilities: Object.freeze({ list: true, export: true, import: true }),
    mode: () => 'pure',
    listChats: async () => chats,
    exportChat: async ({ fileName }) => `${JSON.stringify({
      name: 'You', is_user: true, mes: `library-chat:${fileName}`,
    })}\n`,
    importChat: async () => ({ ok: true }),
  });
};

const LIB_CHATS = [
  { fileName: 'Solo.jsonl' },
  { fileName: 'Fixture Character/双人.jsonl' },
  { fileName: '__cfsys__探针.jsonl' },
];

/** 等一枚按钮可见（有界） */
async function waitVisible(page, selector, timeout = 20_000) {
  try {
    await page.waitForFunction((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none';
    }, selector, { timeout });
    return true;
  } catch { return false; }
}

module.exports = {
  name: '从聊天库导出（纯库模式的导出出口）',
  async run(t, h, ctx) {
    const page = h.page;

    // ============ ① 无库：按钮必须不可见 ============
    t.ok('E1 工作台就绪（无库形态）', Boolean(await ctx.waitForReady(page)));
    const noLib = await page.evaluate(() => {
      const el = document.getElementById('btn-library-export');
      if (!el) return { present: false };
      const r = el.getBoundingClientRect();
      return { present: true, visible: r.width > 0 && r.height > 0, title: el.title || '' };
    });
    t.ok('E2 控件存在于模板中（读数非空 —— 否则下面这条恒真）', noLib.present, JSON.stringify(noLib));
    t.eq('E3 【默认路径零变化】未检测到聊天库时该按钮**不可见**', noLib.visible, false,
      JSON.stringify(noLib));

    // ============ ② 有库：真实点击 → 产物核对 ============
    const { openSite, waitForReady } = require('../lib/harness.cjs');
    const h2 = await openSite(ctx.baseUrl);
    try {
      await h2.page.addInitScript(STUB, { chats: LIB_CHATS });
      await h2.page.goto(ctx.baseUrl, { waitUntil: 'domcontentloaded' });
      t.ok('E4 工作台就绪（有库形态）', Boolean(await waitForReady(h2.page)));

      const visible = await waitVisible(h2.page, '#btn-library-export');
      t.ok('E5 检测到聊天库且其提供导出能力 ⇒ 按钮**可见**', visible);

      const title = await h2.page.$eval('#btn-library-export', (el) => el.title || '');
      t.ok('E6 按钮可用（未禁用 —— 能力位齐备）',
        await h2.page.$eval('#btn-library-export', (el) => !el.disabled), `title=${title}`);

      // ⚠️ **必须显式选目标**：应用启动后的默认目标是 `pt`（生产物落 `data/default-user/…`），
      // 首版按 st 的落位写断言 ⇒ 两条假红。目标显式化是本 spec 的前提，不是可选项。
      await h2.page.selectOption('#target-select', 'st');
      await h2.page.waitForTimeout(150);
      await h2.page.click('#btn-library-export');
      const queued = await common.waitForQueue(h2.page, 1, 120_000);
      t.ok('E7 点一下即产出数据包并进入待导出区', Array.isArray(queued) && queued.length >= 1,
        JSON.stringify(queued));

      const out = await common.downloadNthRow(h2.page, 0, ctx.fixtureDir, 'library-export.zip');
      const product = await common.readZip(out);
      t.ge('E8 产物是合法 zip 且条目数 > 0（前置门）', product.names.length, 1,
        JSON.stringify(product.names));

      t.ok('E9 库里的聊天进了产物（含带角色子目录的那条）',
        product.names.includes('chats/Solo.jsonl')
        && product.names.includes('chats/Fixture Character/双人.jsonl'),
        JSON.stringify(product.names.filter((n) => n.startsWith('chats/'))));
      t.ok('E10 产物内容来自库（不是空壳）',
        (product.contents.get('chats/Solo.jsonl') || Buffer.alloc(0)).toString('utf8')
          .includes('library-chat:Solo.jsonl'),
        JSON.stringify((product.contents.get('chats/Solo.jsonl') || Buffer.alloc(0)).toString('utf8').slice(0, 60)));
      t.ok('E11 隐藏容器条目被过滤（不进产物）',
        !product.names.some((n) => n.includes('__cfsys__')),
        JSON.stringify(product.names.filter((n) => n.includes('__cfsys__'))));
      t.eq('E12 聊天条目数 = 库中可导出的条数（3 条里 1 条是隐藏容器 ⇒ 2 条）',
        product.names.filter((n) => n.includes('chats/')).length, 2,
        JSON.stringify(product.names));

      t.eq('E13 有库形态下同样零未捕获页面异常', h2.rec.pageErrors.length, 0,
        JSON.stringify(h2.rec.pageErrors.slice(0, 2)));
    } finally {
      await h2.close();
    }
  },
};
