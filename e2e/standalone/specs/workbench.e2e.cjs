/**
 * 独立 Web 形态功能矩阵（云部署形态）
 *
 * 覆盖范围与判定纪律：
 *  - **形态本身**：无宿主环境下必须判为「独立 Web 模式」，且**不得**出现「写回宿主」这类
 *    依赖宿主的能力入口（形态差异的可见契约）；
 *  - **子路径挂载**：站点挂在 `/st-zip-converter/` 之下（GitHub Pages 项目页的真实形态），
 *    所有资源必须 200 —— 这条是「云托管能不能用」的核心判据，根路径挂载验不出来；
 *  - **转换闭环**：上传 → 计划预览 → 转换 → 待导出区 → **下载产物并解包核对**。
 *    只验「队列里有一行」是不够的（那可能是个空包），故本 spec 一路验到 zip 内容；
 *  - **包选择预设**：仅聊天记录 / 仅角色卡 / 全选 —— 对应用户口中的「精简 / 默认 / 完整」；
 *  - 每条断言前先要一个**非空读数**（避免把「什么都没发生」判成通过）。
 *
 * 后缀必须是 `.e2e.cjs`：`.spec.cjs` / `.test.js` 会被 vitest 当单测收集。
 */

const fs = require('fs');
const common = require('../lib/common.cjs');

/** 与静态服务器同一前缀（run.cjs 会把它作为 baseUrl 传进来） */
let BASE = '';
let FIXTURE_DIR = '';

// 三个 spec 共用的实现在 `../lib/common.cjs`（此处只留短名，避免各写一份拷贝）
const ensureFixtures = () => common.ensureFixtures(FIXTURE_DIR);
const readCategory = common.readCategory;
/** 转换后报告的计数（`#count-*`）——**不是**计划阶段的类目卡片读数 */
const readCount = common.readReportCount;
const waitForPlan = common.waitForPlan;
const waitForQueue = common.waitForQueue;
const readProductNames = async (zipPath) => (await common.readZip(zipPath)).names;

module.exports = {
  name: '独立 Web 形态：云部署子路径 / 转换闭环 / 包选择预设',
  async run(t, h, ctx) {
    BASE = ctx.baseUrl;
    FIXTURE_DIR = ctx.fixtureDir;
    const { page, rec } = h;

    // ============ A 形态与加载 ============
    const badge = await ctx.waitForReady(page);
    t.ok('A1 工作台就绪（`#env-badge` 脱离「检测中...」）', Boolean(badge), `badge=${badge}`);
    t.eq('A2 无宿主环境下判为「独立 Web 模式」', badge, '独立 Web 模式');

    const shell = await page.evaluate(() => ({
      appChildren: (document.getElementById('app') || { children: [] }).children.length,
      hasWorkbench: Boolean(document.querySelector('.app-container')),
      hasFileInput: Boolean(document.getElementById('file-input')),
      hasConvert: Boolean(document.getElementById('btn-convert')),
      hasHostFetch: (() => {
        const el = document.getElementById('btn-host-fetch');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })(),
    }));
    t.ok('A3 工作台已注入 `#app`（骨架非空）', shell.appChildren > 0, JSON.stringify(shell));
    t.ok('A4 独立形态的必需控件齐备（文件输入 / 转换按钮）',
      shell.hasFileInput && shell.hasConvert, JSON.stringify(shell));
    t.ok('A5 独立形态**不出现**「从宿主拉取」入口（形态差异可见契约）', shell.hasHostFetch === false,
      `hasHostFetch=${shell.hasHostFetch}`);

    // ============ B 子路径挂载（云形态核心判据） ============
    // ⚠️ 只判**同源**请求：静态服务器只收得到同源请求，跨源（`index.html` 里的
    //    cdnjs Font Awesome）整条走不到这里 —— 那是另一个问题（离线/自包含），
    //    在 §E 用 `rec.crossOrigin` 单独记一条**读数**，不混进「子路径可用」的判定。
    // ⚠️ `favicon.ico` 必须排除：`index.html` 未声明 icon，浏览器会去**根路径**取一次
    //    `/favicon.ico` ⇒ 在子路径部署下**必然 404**，且与站点可用性无关（纯浏览器行为）。
    //    不排除就会得到一条**假红**（把「没有图标」判成「子路径部署坏了」）。
    const isFavicon = (u) => /\/favicon\.ico$/i.test(u);
    const allReq = ctx.server.requests.filter((r) => !isFavicon(r.url));
    const underPrefix = allReq.filter((r) => r.url.startsWith(ctx.prefix));
    const outside = allReq.filter((r) => !r.url.startsWith(ctx.prefix));
    const bad = allReq.filter((r) => r.status >= 400);
    t.ge('B1 页面确实从子路径拉到了资源（读数非空）', underPrefix.length, 3,
      `前缀内请求 ${underPrefix.length} 条`);
    t.eq('B2 **没有任何同源请求**落在挂载前缀之外（相对 base 生效 ⇒ 云子路径可用）',
      outside.length, 0, JSON.stringify(outside.slice(0, 3)));
    t.eq('B3 站点资源零 4xx/5xx（子路径下资源全部解析正确）', bad.length, 0,
      JSON.stringify(bad.slice(0, 3)));
    // 这条用网络层读数独立核对一次（不依赖服务器自己的记账）
    t.eq('B4 浏览器侧零 4xx/5xx 响应（排除 favicon）',
      rec.badResponses.filter((r) => !isFavicon(r.url)).length, 0,
      JSON.stringify(rec.badResponses.slice(0, 3)));

    // ============ C 计划预览与包选择预设 ============
    const fixtures = await ensureFixtures();
    const fixturePath = fixtures['fixture-st.zip'];
    t.ok('C0 夹具已生成（fixture-st.zip 存在）', fs.existsSync(fixturePath), fixturePath);

    await page.setInputFiles('#file-input', fixturePath);
    const planReady = await waitForPlan(page);
    t.ok('C1 上传源包后计划预览出现且文本非空', planReady);

    const full = {
      chars: await readCategory(page, 'characters'),
      chats: await readCategory(page, 'chats'),
      lorebooks: await readCategory(page, 'lorebooks'),
    };
    t.ok('C2 类目卡片已渲染（读数非空 —— 先证明判定能抓到东西）',
      full.chars.present && full.chats.present && full.lorebooks.present, JSON.stringify(full));
    t.ge('C3 夹具被真实解析（角色卡计数 ≥ 1）', full.chars.count, 1, JSON.stringify(full.chars));
    t.ge('C4 夹具被真实解析（聊天记录计数 ≥ 1）', full.chats.count, 1, JSON.stringify(full.chats));
    t.ge('C5 夹具被真实解析（世界书计数 ≥ 1）', full.lorebooks.count, 1, JSON.stringify(full.lorebooks));

    // 预设「仅聊天记录」= 用户口中的「精简包」
    // ⚠️ 断言依据不是「我以为应该怎样」，而是源码里的既有裁决：
    //    `category-filter.js:applyPreset` 写着 `const isLinked = true;`，注释是
    //    「角色与聊天智能联动已恒开（用户裁决 6：移除该复选框，行为保留）」⇒
    //    「仅聊天记录」= chats + characters + assets 三类，**不是**只有 chats。
    //    （首版我按直觉断言「角色卡应被取消勾选」⇒ 两条**假红**。）
    await page.click('[data-preset="chats"]');
    await page.waitForTimeout(250);
    const chatOnly = {
      chars: await readCategory(page, 'characters'),
      chats: await readCategory(page, 'chats'),
      lorebooks: await readCategory(page, 'lorebooks'),
      settings: await readCategory(page, 'settings'),
    };
    t.eq('C6 预设「仅聊天记录」：聊天记录仍被勾选', chatOnly.chats.checked, true,
      JSON.stringify(chatOnly.chats));
    t.eq('C7 预设「仅聊天记录」：角色卡**仍勾选**（联动恒开 —— 已成文的既有裁决）',
      chatOnly.chars.checked, true, JSON.stringify(chatOnly.chars));
    t.ok('C8 预设「仅聊天记录」确实**收窄**了范围（世界书 / 系统设置被取消勾选 —— '
      + '这条是判别力所在：没有它，「预设生效」无从证明）',
      chatOnly.lorebooks.checked === false && chatOnly.settings.checked === false,
      JSON.stringify({ lorebooks: chatOnly.lorebooks.checked, settings: chatOnly.settings.checked }));

    // 预设「仅角色卡」
    await page.click('[data-preset="chars"]');
    await page.waitForTimeout(250);
    const charOnly = {
      chars: await readCategory(page, 'characters'),
      chats: await readCategory(page, 'chats'),
      lorebooks: await readCategory(page, 'lorebooks'),
    };
    t.eq('C9 预设「仅角色卡」：角色卡被勾选', charOnly.chars.checked, true,
      JSON.stringify(charOnly.chars));
    // 已知冗余的事实读数：联动恒开让两个快捷预设产出**同一选择集**。
    // 这里**如实断言现状**（而不是假装它们不同）：若将来有人把它们区分开，
    // 这条会转红，从而强制一次显式决策 —— 见本任务 spec「未做到 / 待裁决」。
    t.ok('C10 【事实登记】两个快捷预设当前产出同一选择集（联动恒开的直接后果）',
      charOnly.chats.checked === true && charOnly.lorebooks.checked === false,
      JSON.stringify({ chars: charOnly.chars.checked, chats: charOnly.chats.checked,
        lorebooks: charOnly.lorebooks.checked }));

    // 全选 = 「完整包」（**前置门**：完整读数必须非零，否则这条会退化成恒真）
    t.ge('C11 前置门：完整读数非零（否则下一条是恒真的）', full.chars.count + full.chats.count, 1,
      JSON.stringify(full));
    await page.click('#btn-select-all');
    await page.waitForTimeout(250);
    const all = {
      chars: await readCategory(page, 'characters'),
      chats: await readCategory(page, 'chats'),
      lorebooks: await readCategory(page, 'lorebooks'),
    };
    t.ok('C12 全选后三类目都恢复勾选（完整包）',
      all.chars.checked === true && all.chats.checked === true && all.lorebooks.checked === true,
      JSON.stringify({ chars: all.chars.checked, chats: all.chats.checked, lorebooks: all.lorebooks.checked }));
    t.ok('C13 全选后计数与初始读数一致（没有被重建流程改坏）',
      all.chars.count === full.chars.count && all.chats.count === full.chats.count
      && all.lorebooks.count === full.lorebooks.count,
      `初始=${JSON.stringify([full.chars.count, full.chats.count, full.lorebooks.count])} `
      + `全选=${JSON.stringify([all.chars.count, all.chats.count, all.lorebooks.count])}`);

    // ============ D 转换闭环 + 产物核对 ============
    await page.selectOption('#target-select', 'st');
    await page.waitForTimeout(200);
    const convertEnabled = await page.$eval('#btn-convert', (el) => !el.disabled);
    t.ok('D1 选好目标平台后「开始转换」可用', convertEnabled);

    await page.click('#btn-convert');
    const queued = await waitForQueue(page, 1);
    t.ok('D2 转换完成后待导出区出现产物行', Array.isArray(queued) && queued.length >= 1,
      JSON.stringify(queued));

    // 独立形态下**不得**出现「写回宿主」行按钮（没有宿主可写）
    const restoreBtns = await page.$$eval('.btn-archive-action.restore', (els) => els.length);
    t.eq('D3 独立形态下产物行**没有**「写回宿主」按钮', restoreBtns, 0);

    // 下载并解包核对（只验「队列里有行」会把空包判成通过）
    const outPath = await common.downloadFirstRow(page, FIXTURE_DIR, 'standalone-product.zip');
    t.ok('D4 产物下载成功且非空', fs.existsSync(outPath) && fs.statSync(outPath).size > 0,
      `size=${fs.existsSync(outPath) ? fs.statSync(outPath).size : 'N/A'}`);

    const names = await readProductNames(outPath);
    t.ge('D5 产物是合法 zip 且条目数 > 0', names.length, 1, `条目数=${names.length}`);
    t.ok('D6 产物内容与源包对应（含角色卡条目）',
      names.some((n) => n.startsWith('characters/')), JSON.stringify(names.slice(0, 6)));
    t.ok('D7 产物内容与源包对应（含聊天记录条目）',
      names.some((n) => n.startsWith('chats/')), JSON.stringify(names.slice(0, 8)));
    t.ok('D8 目标平台落位生效（ST 目标保留 `characters/` 而非 PT/TT 的 data 前缀）',
      !names.some((n) => n.startsWith('data/')), JSON.stringify(names.slice(0, 4)));

    // ============ E 转换后报告（`#report-panel` 的读数是**产物侧**事实） ============
    const reportReady = await page.waitForFunction(() => {
      const p = document.getElementById('report-panel');
      return Boolean(p) && !p.hidden;
    }, null, { timeout: 30_000 }).then(() => true).catch(() => false);
    t.ok('E0 转换后报告面板出现', reportReady);
    const report = {
      chars: await readCount(page, 'count-chars'),
      chats: await readCount(page, 'count-chats'),
      assets: await readCount(page, 'count-assets'),
    };
    t.ge('E1 报告读数非空（先证明判定能抓到东西）',
      (report.chars ?? 0) + (report.chats ?? 0) + (report.assets ?? 0), 1, JSON.stringify(report));
    t.ge('E2 报告计入角色卡', report.chars, 1, JSON.stringify(report));
    t.ge('E3 报告计入聊天记录', report.chats, 1, JSON.stringify(report));

    // ============ F 零报错（独立形态下页面 100% 是本插件，故全量可归因） ============
    t.eq('F1 全流程零未捕获页面异常', rec.pageErrors.length, 0, JSON.stringify(rec.pageErrors.slice(0, 2)));
    t.eq('F2 全流程零控制台错误', rec.consoleErrors.length, 0, JSON.stringify(rec.consoleErrors.slice(0, 2)));
    t.eq('F3 全流程零失败请求', rec.failedRequests.length, 0, JSON.stringify(rec.failedRequests.slice(0, 2)));
    t.eq('F4 全流程零 4xx/5xx（含跨源，favicon 除外）',
      rec.badResponses.filter((r) => !isFavicon(r.url)).length, 0,
      JSON.stringify(rec.badResponses.slice(0, 3)));

    // ============ G 自包含性读数（**不判定**，只记账）============
    // 独立形态的 `index.html` 引了 cdnjs 的 Font Awesome ⇒ 离线/内网云部署下图标会失效。
    // 这是**既有事实**，不在本 spec 的判定范围内（改它要动全部图标用法），故只记读数、
    // 不写成绿/红；登记见本任务 spec 的「未做到」节。
    t.log(`  · G 跨源请求 ${rec.crossOrigin.length} 条（信息项，不判定）：`
      + JSON.stringify(rec.crossOrigin.slice(0, 4)));
  },
};
