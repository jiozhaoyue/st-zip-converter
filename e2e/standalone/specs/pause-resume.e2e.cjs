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

    await page.click('#tc-pause');
    const paused = await waitForState(page, '#tc-resume', true, 60_000);
    t.ok('R6 点暂停后出现「继续」（状态机 running → paused）', paused);

    const pausedLog = await common.readLogText(page);
    t.ok('R7 暂停态给出可读反馈（日志非空 —— 读数有效）', pausedLog.trim().length > 0,
      JSON.stringify(pausedLog.slice(-160)));

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
    t.eq('R12 产物聊天条目数与源包一致（跳过的是「已完成的」，不是「没做的」）',
      outChats, srcChats, `源=${srcChats} 产物=${outChats}`);

    t.eq('R13 全流程零未捕获页面异常', rec.pageErrors.length, 0, JSON.stringify(rec.pageErrors.slice(0, 2)));
  },
};
