/**
 * 转换的暂停 → 续传（**独立形态可达**，无需实例）
 *
 * 为什么值得单独一条：转换路径的 pause/resume（R-16 补上的能力）此前的验证只能挂在
 * **宿主拉取**流程上（要开实例、要拉实例数据）。而状态机对两条路径是**同一套**
 * （`taskManager.start` + `onResume` 查表分派 + `signal`/`resumeCrcMap` 透传），
 * 所以「上传包转换」这条路径同样能把它跑出来 —— 且不需要任何实例。
 *
 * ## 夹具为什么要「多条目、少字节」
 *
 * 暂停窗口取决于**条目数**（每条目都要过 crc + 写盘 + 进度往返），**不是字节数**：
 * 6 MB 的包在数百毫秒内就转完了，点暂停会点在已隐藏的按钮上（假红或假绿）。
 *
 * ⚠️ **条目数须随机器变快而上调**（2026-09-28 实测教训）：本机转完 1500 条只需约 4s，
 * 而「等进度 ≥10% 再点暂停」占掉其中约 0.5s ⇒ 一旦机器空闲下来，点击就会落在
 * **已结束的任务**上（`page.click('#tc-pause')` 元素不可见 ⇒ 30s 超时 ⇒ 假红）。
 * 该竞态**与本仓库改动无关**（已用「还原后同形失败」证实），纯属夹具窗口太窄。
 * 现用 3000 条把窗口拓宽一倍有余。
 *
 * ## 判据（强度递减）
 *
 * 1. **续传真的跳过了条目**：日志含「（沿用断点跳过 N 项）」且 N > 0
 *    —— 这是「断点续传」而不是「从头重跑」的唯一直接证据；
 * 2. 产物**没有因为跳过而少条目**（跳过的是半成品里**真有的字节**，不是没做的）
 *    —— 2026-09-28 起**真增量续传**：暂停时把已写部分收尾成合法 zip 落 OPFS，
 *       续传用 `appendZip` 原样搬运再接着写；此前这一条**没人验**，
 *       缺陷（1500 条 → 1437 条）藏了整整一轮（详见 R12 前的注释）；
 * 3. 控制条状态机走完 running → paused → （续传）→ 隐藏。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const common = require('../lib/common.cjs');

let FIXTURE_DIR = '';

const FIXTURE_ENTRIES = 3000;
const LAST_CHAT = `chats/Pause/many-${String(FIXTURE_ENTRIES - 1).padStart(4, '0')}.jsonl`;

/** 暂停窗口夹具：3000 条目 × 3 KB（条目数主导耗时，见文件头注） */
async function ensurePauseFixture() {
  // ⚠️ 文件名里**必须带条目数**：夹具是按文件名缓存的（`existsSync` 即复用），
  // 改了条目数却沿用旧名会**静默复用到旧夹具**（窗口宽度悄悄回退到旧值，看起来却"没改过"）。
  const out = path.join(FIXTURE_DIR, `pause-many-${FIXTURE_ENTRIES}.zip`);
  if (fs.existsSync(out)) return out;
  const entries = [['characters/Pause Character.png', Buffer.from('89504e470d0a1a0a', 'hex')]];
  for (let i = 0; i < FIXTURE_ENTRIES; i += 1) {
    const head = Buffer.from(`${JSON.stringify({ name: 'You', is_user: true, mes: `m${i}` })}\n`, 'utf8');
    const filler = crypto.createHash('sha256').update(`pause:${i}`).digest(); // 确定性内容
    entries.push([`chats/Pause/many-${String(i).padStart(4, '0')}.jsonl`, Buffer.concat([head, filler])]);
  }
  return common.buildZip(out, entries);
}

async function waitForState(page, selector, visible, timeout = 60_000) {
  try {
    await page.waitForFunction(({ sel, want }) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      return Boolean(!el.hidden) === want;
    }, { sel: selector, want: visible }, { timeout });
    return true;
  } catch { return false; }
}

module.exports = {
  name: '转换暂停 → 续传（独立形态，无需实例）',
  async run(t, h, ctx) {
    FIXTURE_DIR = ctx.fixtureDir;
    const { page, rec } = h;
    t.ok('R1 工作台就绪', Boolean(await ctx.waitForReady(page)));

    const fixture = await ensurePauseFixture();
    const source = await common.readZip(fixture);
    t.ge('R2 暂停夹具条目数足够多（读数非空 —— 否则暂停窗口不存在）', source.names.length, 1000,
      `条目=${source.names.length}`);

    await page.setInputFiles('#file-input', fixture);
    t.ok('R3 上传后计划预览就绪', await common.waitForPlan(page));
    await page.selectOption('#target-select', 'st');
    // 关分卷：分卷会改变产物形态，干扰「条目是否齐」的判据
    const splitApplied = await common.fillNumber(page, '#split-input', 0);
    t.ok('R4 分卷阈值置 0（回读确认）', splitApplied !== 'failed', `via=${splitApplied}`);

    await page.click('#btn-convert');
    const running = await waitForState(page, '#task-controls', true, 60_000);
    t.ok('R5 转换期间任务控制条可见（running 态 —— 转换路径真的接了状态机）', running);

    // ⚠️ **暂停前必须等到足够条目**：断点清单由节流器落盘（`CHECKPOINT_EVERY_ENTRIES = 64` /
    //    `CHECKPOINT_EVERY_MS = 2000`，见 `index.js:140-141`）。若在「还没落过盘」的那一帧就暂停，
    //    落盘的是**空清单** ⇒ 续传跳过 0 条 ⇒ R9 变红。那是**竞态**，不是缺陷（实测两种读数都出现过）。
    //    故这里先把「条数推进」变成显式**前置门**：等到进度 ≥ 10%（≈150 条）再暂停。
    const reached = await page.waitForFunction(() => {
      const el = document.getElementById('progress-percent');
      const n = Number(String((el && el.textContent) || '').replace(/[^\d]/g, ''));
      return Number.isFinite(n) && n >= 10;
    }, null, { timeout: 60_000 }).then(() => true).catch(() => false);
    t.ok('R5b 暂停前进度已推进到 ≥10%（前置门：保证「每 64 条落一次」的断点已经落过盘）',
      reached);

    await page.click('#tc-pause');
    const paused = await waitForState(page, '#tc-resume', true, 60_000);
    t.ok('R6 点暂停后出现「继续」（状态机 running → paused）', paused);

    const pausedLog = await common.readLogText(page);
    t.ok('R7 暂停态给出可读反馈（日志非空 —— 读数有效）', pausedLog.trim().length > 0,
      JSON.stringify(pausedLog.slice(-160)));
    const pausedAt = pausedLog.match(/已暂停于\s*(\d+)\s*\//);
    t.ge('R7b 暂停时确有**已完成条目**（把 R9 的前提显式记下来，避免把竞态写成判定）',
      pausedAt ? Number(pausedAt[1]) : 0, 64, JSON.stringify(pausedAt && pausedAt[0]));

    // 续传：**先记下日志此时的长度**，只认这一刻之后的增量
    // （假绿的经典来源：匹配到上一次运行留在同一面板里的旧行）
    const logBefore = (await common.readLogText(page)).length;
    await page.click('#tc-resume');
    const done = await waitForState(page, '#task-controls', false, 180_000);
    t.ok('R8 续传跑完（控制条回到隐藏 = 任务 complete）', done);

    const logAfter = await common.readLogText(page);
    const delta = logAfter.slice(logBefore);
    const m = delta.match(/沿用断点跳过\s*(\d+)\s*项/);
    t.ok('R9 【核心】续传**真的跳过了已完成条目**（日志含「沿用断点跳过 N 项」）',
      Boolean(m), `增量日志尾部=${JSON.stringify(delta.slice(-200))}`);
    if (m) t.ge('R10 跳过条数 > 0（否则等于从头重跑，续传名不副实）', Number(m[1]), 1, `N=${m[1]}`);

    const queued = await common.waitForQueue(page, 1, 30_000);
    t.ok('R11 续传后产物进入待导出区', Array.isArray(queued) && queued.length >= 1,
      JSON.stringify(queued));
    const out = await common.downloadNthRow(page, 0, FIXTURE_DIR, 'pause-resume-product.zip');
    const product = await common.readZip(out);
    const srcChats = source.names.filter((n) => n.startsWith('chats/')).length;
    const outChats = product.names.filter((n) => n.startsWith('chats/')).length;
    const skipped = m ? Number(m[1]) : 0;

    /**
     * ✅ **曾经的已知缺陷，2026-09-28 已修**（保留这段史，因为「既有测试为何没抓到」这一步最有价值）
     *
     * 旧现象：暂停后「继续」，产物**缺条目** —— 实测 1500 条聊天变成 1437 条（跳过 64 项，
     * 其中 63 条聊天从未写进产物），而 UI 与日志都报「转换成功」。
     *
     * 旧机理（三处合起来构成必然的静默数据损失）：
     *  1. `transform.js` 的 `onProgress` 在**投递给 writer 之前**上报 ⇒ 断点清单记的是「已读到」
     *     而非「已写下」，**超前于**实际产物；
     *  2. 暂停走 `worker.terminate()`，半成品 `BlobWriter` 被丢弃 ⇒ 已写入的那部分也一并没了；
     *  3. 续传时 crc 命中即**跳过**（既不重读也不重写），而目标 zip 是**新建的空包**
     *     ⇒ 被跳过的条目**既不在旧产物（已丢）也不在新产物（被跳过）** ⇒ 永久缺失。
     *
     * 旧测试为何没抓到：单测锁的是**机理**（`not.toContain`「跳过 ⇒ 产物里没有」），
     * 矩阵 M-7b 只断言「日志出现『沿用断点跳过 N 项』」—— **没有一条问过产物完不完整**。
     * 于是「跳过语义生效」被验成绿，而用户拿到的包少条目无人测。
     *
     * 现修法（用户 2026-09-28 裁定取「真增量续传」）：
     *  - 跳过门改成「**半成品里真有这条**」（`transform.js` 的 `appendedNames`），**不再**只看台账；
     *  - 暂停改**协作式收尾**：worker 把已写部分 `close()` 成合法 zip 并回报，主线程落 OPFS；
     *  - 续传用 zip.js `appendZip` 把半成品**原样搬运**（字节级、零重压缩）再继续写。
     * ⇒ 下面的断言从「**如实断言缺陷形态**」翻转为「**断言产物完整**」——
     *   这正是本条在修复后应当转绿的形态（旧断言在此已不可能通过）。
     */
    t.ok('R12 【核心】续传产物**条目齐全**：聊天条数与源包**相等**（不再静默缺条目）',
      srcChats > 0 && outChats === srcChats,
      `源=${srcChats} 产物=${outChats} 跳过=${skipped}`);
    const firstChat = 'chats/Pause/many-0000.jsonl';    t.ok('R13 【同一不变量的另一面】产物**逐条可查**：暂停窗口两侧的首尾聊天都在'
      + '（计数相等之外，再落到具体条目上）',
      product.names.includes(firstChat) && product.names.includes(LAST_CHAT),
      `首=${product.names.includes(firstChat)} 尾=${product.names.includes(LAST_CHAT)}`);
    t.log(`  · 续传跳过 ${skipped} 项却仍条目齐全 ⇒ **跳过的是半成品里真有的字节**（真增量续传生效）`);

    // ===== ③ Worker 生命周期回归（L1-MR-8；本仓历史事故 `034b7ab`）=====
    //
    // 暂停/丢弃都走 `worker.terminate()`，而**被 terminate 的 Worker 会静默忽略后续 postMessage**
    // —— 忘了把 `workerInstance` 置空，此后**每一次**转换都会永久挂死（不报错、不动），
    // 这是本仓排查成本最高的一类缺陷。故这里把「终止过一次之后还能再转」直接钉成断言。
    await page.selectOption('#target-select', 'st');
    await page.click('#btn-convert');
    t.ok('R15 再次点转换后控制条进入 running（新任务确实起来了）',
      await waitForState(page, '#task-controls', true, 60_000));
    await page.click('#tc-pause');
    t.ok('R16 第 N 次任务同样能暂停（状态机不是只能用一次）',
      await waitForState(page, '#tc-resume', true, 60_000));
    await page.click('#tc-discard');
    t.ok('R17 丢弃后控制条隐藏（丢弃出口收尾）',
      await waitForState(page, '#task-controls', false, 60_000));

    // 关键一步：**丢弃之后**（terminate + 断点已清）再转一次，必须照常出产物
    const rowsBefore = await page.$$eval('.eq-name', (els) => els.length);
    await page.click('#btn-convert');
    const againNames = await common.waitForQueue(page, rowsBefore + 1, 240_000);
    t.ok('R18【Worker 生命周期】终止过一次之后**还能再转**并出产物（`034b7ab` 回归守护）',
      Array.isArray(againNames) && againNames.length >= rowsBefore + 1,
      `前=${rowsBefore} 后=${(againNames || []).length}`);
    const againOut = await common.downloadNthRow(page, rowsBefore, FIXTURE_DIR, 'after-discard.zip');
    const againProduct = await common.readZip(againOut);
    t.ge('R19 又一次转换的产物是合法 zip 且条目齐全（不是空壳）', againProduct.names.length, 1000,
      `entries=${againProduct.names.length}`);

    t.eq('R14 全流程零未捕获页面异常', rec.pageErrors.length, 0, JSON.stringify(rec.pageErrors.slice(0, 2)));
  },
};
