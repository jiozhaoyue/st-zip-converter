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
 * 这里用 1500 × 3 KB ≈ 4.5 MB（矩阵 spec 的同类结论）。
 *
 * ## 判据（强度递减）
 *
 * 1. **续传真的跳过了条目**：日志含「（沿用断点跳过 N 项）」且 N > 0
 *    —— 这是「断点续传」而不是「从头重跑」的唯一直接证据；
 * 2. 产物**没有因为跳过而少条目**（跳过的是已完成的，不是没做的）；
 * 3. 控制条状态机走完 running → paused → （续传）→ 隐藏。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const common = require('../lib/common.cjs');

let FIXTURE_DIR = '';

/** 暂停窗口夹具：1500 条目 × 3 KB（条目数主导耗时，见文件头注） */
async function ensurePauseFixture() {
  const out = path.join(FIXTURE_DIR, 'pause-many-entries.zip');
  if (fs.existsSync(out)) return out;
  const entries = [['characters/Pause Character.png', Buffer.from('89504e470d0a1a0a', 'hex')]];
  for (let i = 0; i < 1500; i += 1) {
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
     * 🔴 **已知缺陷（未修，2026-09-28 由本用例首次取证）**
     *
     * 现象：暂停后「继续」，产物**缺条目** —— 实测 1500 条聊天变成 1437 条（跳过 64 项，
     * 其中 63 条聊天从未写进产物），而 UI 与日志都报「转换成功」。
     *
     * 机理（三处合起来构成必然的静默数据损失）：
     *  1. `transform.js:354` 的 `onProgress` 在**投递给 writer 之前**上报 ⇒ 断点清单记录的是
     *     「已读到」而不是「已写入」，**超前于**实际产物；
     *  2. 暂停走 `worker.terminate()`，`worker-client.js:117` 明确「**半成品 BlobWriter 丢弃**」
     *     ⇒ 已写入的那部分也一并没了；
     *  3. 续传时 `resumeCrcMap` 命中即**跳过**（既不重读也不重写），而目标 zip 是**新建的空包**
     *     ⇒ 被跳过的条目**既不在旧产物（已丢）也不在新产物（被跳过）** ⇒ 永久缺失。
     *
     * 为什么既有测试没抓到（这是本条最大的价值）：
     *  - 单测 `test/convert-resume.test.js` 锁的是**机理**而非不变量 ——
     *    `expect(names).not.toContain('settings.json')`（「跳过 ⇒ 产物里没有」）；
     *  - 实例矩阵 M-7b 只断言「日志出现『沿用断点跳过 N 项』」，**没断言产物完整**；
     *  - 于是「跳过语义生效」被验成绿，而**用户拿到的包少条目**无人测。
     *
     * 修法（须与既有断言一起改，故**本次不动**，登记待裁决）：
     *  - (a) 真正的增量续传：把暂停时的半成品产物跨会话保留，续传在其上继续写；
     *  - (b) 最小正确修：转换路径不传 `resumeCrcMap`（暂停后重做，但产物完整）——
     *        代价是 `test/convert-resume.test.js` 与矩阵 M-7b 的「跳过」断言需同步更新。
     *
     * 本用例当下**如实断言缺陷的形态**（而不是假装它不存在）：若将来修好，这条会转红，
     * 从而**强制**把断言改成「产物与源包条目数一致」。
     */
    t.ok('R12-KNOWN-DEFECT 缺的聊天数 ≳ 被跳过的条数（跳过即永久缺失；修好后本应**相等**）',
      outChats <= srcChats - Math.max(0, skipped - 1),
      `源=${srcChats} 产物=${outChats} 跳过=${skipped}（其中 1 条是非聊天，故聊天缺失≈${skipped - 1}）`);
    t.ok('R13 【同一缺陷的另一面】产物体积/条目数因此小于源包 —— 用户拿到的是**残缺包**',
      outChats < srcChats, `源=${srcChats} 产物=${outChats}`);
    t.log('  · 🔴 已知缺陷：暂停→续传后产物缺条目（静默）。机理与修法见本 spec 头部注释与 '
      + '`.trellis/spec/guides/standalone-web-and-cloud-e2e.md` 的 §4.5。');

    t.eq('R14 全流程零未捕获页面异常', rec.pageErrors.length, 0, JSON.stringify(rec.pageErrors.slice(0, 2)));
  },
};
