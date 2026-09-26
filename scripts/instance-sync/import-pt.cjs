/**
 * PT（PureTavern）数据同步器 —— 把 **TT 布局包** 导入 PT 的 M21 通道（implement.md 3.9）
 *
 * ## 通道依据（2026-09-26 实地探明，**推翻了先前结论**）
 *
 * 先前 `research/pt-import-channel.md` 的结论是「web 模式没有该后端，`POST /api/backups/tauritavern/import`
 * 返回 404 ⇒ 需另起 PT `remote-server`」。**该结论是错的，本轮已更正**：
 *
 * - PT 的 `/api/*` 路由**不是**服务端后端，而是 PT **纯前端**自己注册的
 *   「legacy 兼容路由」（`apps/web/src/features/import-export/legacy/register-routes.ts`，
 *   挂载于 `apps/web/src/legacy-hook/bootstrap.ts` 的 `CompatibilityRouter`）；
 *   它通过 `installCompatibilityFetch(router)` **补丁页面内的 `window.fetch`** 来生效。
 * - 因此**页面内**发请求完全可用，实测：
 *   `POST /api/backups/archive/inspect` → **200**（返回 assets 659 条 / 329 blob）；
 *   `POST /api/backups/tauritavern/import/preview` → **400** `{"code":"missing-file","pureTavern":true}`。
 * - 早先拿到 404，是因为探查**绕过了页面内被补丁的 `fetch`**（走 Node 侧 / Playwright request）
 *   ⇒ **404 是探查方法的伪影**，不是能力缺失。
 * - 顺带更正第二处：`apps/remote-server` 是 **LLM 请求代理**（只有 `GET /v1/health` 与
 *   `POST /v1/proxy`，见其 README），**与备份/导入无关** ⇒ 起它对同步毫无帮助。
 *
 * ## 实际走的路径：宿主数据管理面板（真实用户路径）
 *
 * 数据管理面板是个独立 `<dialog id="pure-tavern-data-management-dialog">`，
 * 由设置里的「**打开数据管理**」按钮打开（**不是**点设置项抽屉就能展开的 ——
 * 先前 `pt-automation.cjs` 的 `--import-pack` 分支正是栽在这里，文件设进去了但流程没起来）。
 *
 * 面板内两组导入控件（`apps/web/src/features/import-export/runtime/index.js`）：
 *
 * | 控件 | 用途 |
 * | --- | --- |
 * | `#ptdm-import-file` + `#ptdm-import-method` | PT 自家归档（`fast`/`slow`） |
 * | `#ptdm-tt-import-file` + `#ptdm-tt-strategy` | **TT 归档**（本项目产出的是 TT 布局树 ⇒ 走这组） |
 *
 * `#ptdm-tt-strategy` 默认 **`merge`**（「合并并覆盖冲突」）—— 与本任务 U-3「覆盖同名、不删独有」一致。
 *
 * ## 用法
 *
 * ```bash
 * # 先空转：只打开面板、读基线计数，不导入
 * node scripts/instance-sync/import-pt.cjs --pack <pack-tt-*.zip> --dry-run
 *
 * # 只读核对：打印 PT 侧模块级读数（AC-2/AC-3 在 PT 上的唯一可用判据）
 * node scripts/instance-sync/import-pt.cjs --pack <pack-tt-*.zip> --report
 *
 * # 真导入（策略默认 merge，导入方式默认 slow = 逐文件低内存）
 * node scripts/instance-sync/import-pt.cjs --pack <pack-tt-*.zip>
 * ```
 *
 * ## ⚠️ 大包风险（**导入前必须知情**）
 *
 * PT 是纯前端，数据落 **IndexedDB**，磁盘上**没有数据目录**。实测其
 * `storagePersistence` 为 **`best-effort`**（非 `persistent`）⇒
 * **浏览器可在磁盘紧张时静默清空整个库**。因此对 GB 级包，本脚本**默认拒绝执行**，
 * 需显式 `--allow-large` 才放行（把风险摆到明面上，而不是替用户默默决定）。
 */

const fs = require('fs');
const path = require('path');

const { loadPlaywright, warnOnVersionDrift } = require('../../e2e/lib/resolve-playwright.cjs');
const { getInstance } = require('../../e2e/lib/instances.cjs');
const { countPtData, diffPtCounts } = require('./lib/pt-count.cjs');

const SHOT_DIR = path.resolve(__dirname, '..', '..', 'test-results');

/** 超过此体积需显式 `--allow-large`（PT 的 best-effort 存储配额风险） */
const LARGE_PACK_MB = 100;

function parseArgs(argv) {
  const out = {
    pack: '', id: 'pt-web', strategy: 'merge', method: 'slow', dryRun: false,
    allowLarge: false, timeout: 900000, keepOpen: false, report: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--pack') out.pack = argv[++i] || '';
    else if (a === '--id') out.id = argv[++i] || out.id;
    else if (a === '--strategy') out.strategy = argv[++i] || out.strategy;
    else if (a === '--timeout') out.timeout = Number(argv[++i]) || out.timeout;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--report') out.report = true;
    else if (a === '--method') out.method = argv[++i] || out.method;
    else if (a === '--allow-large') out.allowLarge = true;
    else if (a === '--keep-open') out.keepOpen = true;
  }
  return out;
}

const MB = 1024 * 1024;

/** 有界等待 PT 初始化完成（首屏「正在初始化…」时 DOM 是空壳，L1-MR-7） */
async function waitPtReady(page, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const busy = await page.evaluate(() => document.body.innerText.includes('正在初始化')).catch(() => false);
    if (!busy) return true;
    await page.waitForTimeout(3000);
  }
  return false;
}

/**
 * 打开数据管理面板（**真实用户路径**：点「打开数据管理」按钮 → 等 `<dialog>` 可见）
 *
 * ⚠️ **必须有界等待按钮出现**：实测该按钮的渲染**晚于**「正在初始化…」消失
 * （`waitPtReady` 返回后 DOM 里还没有它）⇒ 直接查一次会得到「未找到」。
 * 且它所在的位置不要求先展开扩展抽屉 —— 直接 `querySelectorAll('button')` 即可命中并点击。
 */
async function openDataPanel(page, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  let clicked = { ok: false, reason: '超时：始终未出现「打开数据管理」按钮' };
  while (Date.now() < deadline) {
    clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find((b) => /打开数据管理/.test(b.textContent || ''));
      if (!btn) return { ok: false, reason: '按钮尚未渲染' };
      btn.click();
      return { ok: true, text: btn.textContent.trim() };
    });
    if (clicked.ok) break;
    await page.waitForTimeout(1000);
  }
  if (!clicked.ok) return clicked;

  try {
    await page.waitForFunction(() => {
      const d = document.getElementById('pure-tavern-data-management-dialog');
      if (!d) return false;
      const r = d.getBoundingClientRect();
      return (d.open || getComputedStyle(d).display !== 'none') && r.width > 0;
    }, null, { timeout: 15000 });
    return { ok: true, text: clicked.text };
  } catch {
    return { ok: false, reason: '点了按钮但 <dialog> 未变为可见' };
  }
}

/**
 * 处理**全部**确认对话框，直到导入真正开始或超时。
 *
 * ## 为什么不能用「固定轮数」
 * TT 导入的确认**不是连续两层**，中间隔着一段**可长可短的真实工作**：
 *
 * ```
 * 点「执行 TauriTavern 导入」
 *   → ① 模块选择对话框                    → 点「继续」
 *   → 【slow 模式：逐文件校验 CRC/SHA-256 + 冲突分析】   ← 7209 文件 / 1.16 GB 实测要数分钟
 *   → ② 「请确认」对话框（已选择 N 个模块…确定继续吗？） → 点「确定」
 *   → ③ 真正导入 → 页面 reload
 * ```
 *
 * 先前实现只轮询 6 轮 × 1.5 s ≈ 9 秒就收工 ⇒ **等不到第二层**，
 * 于是「继续」点完之后导入**根本没开始**，而外层又在傻等完成信号直到超时。
 * （实测症状：日志停在 `已处理确认层：module-picker(继续)` 之后再无进展。）
 *
 * ## 现在的模型
 * 以**总时长预算**逐轮处理；**退出条件**取三者之一：
 *   ① 页面发生导航（导入完成的标志，源码 `setTimeout(location.reload, 500)`）；
 *   ② 出现完成/失败文案；
 *   ③ 预算耗尽。
 * 中间那段校验期会**持续等待**而不是提前放弃 —— 每 30 s 打一次进度，让日志可观测。
 *
 * @param {import('playwright').Page} page
 * @param {number} timeoutMs 总预算（沿用调用方的 `--timeout`）
 * @returns {Promise<Array<{kind:string,text:string,label:string}>>} 实际处理过的层（留证用）
 */
async function drainConfirmDialogs(page, timeoutMs) {
  const handled = [];
  const deadline = Date.now() + timeoutMs;
  let reloaded = false;
  const onNav = (frame) => { if (frame === page.mainFrame()) reloaded = true; };
  page.on('framenavigated', onNav);
  let lastTick = Date.now();
  try {
    while (Date.now() < deadline) {
      if (reloaded) break;
      const acted = await page.evaluate(() => {
        const visible = Array.from(document.querySelectorAll('dialog')).filter((d) => {
          const r = d.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(d).display !== 'none';
        });
        for (const d of visible) {
          const confirm = d.querySelector('[data-action="confirm"]');
          if (!confirm) continue;
          const picker = d.querySelector('[data-action="all"]');
          if (picker) picker.click();          // 模块选择层：先全选（与导出侧模块集保持一致）
          confirm.click();
          return {
            kind: picker ? 'module-picker' : 'confirm',
            text: ((d.querySelector('h3') || {}).textContent || '').trim(),
            label: (confirm.textContent || '').trim(),
          };
        }
        return null;
      }).catch(() => null);

      if (acted) {
        handled.push(acted);
        console.log(`[导入] 确认层 ${handled.length}：${acted.text} → 点「${acted.label}」`);
        continue;
      }

      // 无对话框：可能正在做逐文件校验，也可能已导入完成 ⇒ 看文案
      const txt = await page.evaluate(() => document.body.innerText).catch(() => '');
      if (/TauriTavern 数据导入完成|数据导入完成|导入完成|导入成功/i.test(txt)) break;
      if (/导入失败|Import failed/i.test(txt)) { console.log('[导入] 界面报「导入失败」'); break; }

      if (Date.now() - lastTick > 30000) {
        lastTick = Date.now();
        const stage = await page.evaluate(() => {
          const el = document.getElementById('ptdm-tt-preview');
          return el ? el.textContent.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
        }).catch(() => '');
        console.log(`[导入] 进行中（已处理 ${handled.length} 层）${stage ? `：${stage}` : ''}`);
      }
      await page.waitForTimeout(1500);
    }
  } finally {
    page.off('framenavigated', onNav);
  }
  return { dialogs: handled, reloaded };
}

/**
 * 走完一次 TT 导入。
 * @returns {{dialogs:Array, done:boolean, signal:string, reloaded:boolean}}
 */
/**
 * 读面板的**配额 / 存储模式**读数 —— 这是「大包能不能安全导入」的判据。
 *
 * PT 的存储模式实测为「**尽力而为**」（非 `persistent`），面板自己的警告原文：
 * 「浏览器未授予持久化存储：磁盘空间不足时，它可能在不通知的情况下清除本站的全部数据。」
 * ⇒ GB 级写入前必须先看清用量与配额，而不是盲写。
 */
/**
 * 读面板的**逐模块读数**（`#ptdm-modules` 的每一行）。
 *
 * 行结构（`apps/web/.../import-export/runtime/index.js:313-327`）：
 * `<label class="ptdm-module-row"><span><input data-module="id"> <strong>名称</strong></span>
 *  <span class="ptdm-module-meta">N records · M blobs · X MB</span></label>`
 *
 * ⚠️ 这是 PT 侧**唯一可读到的模块级真源读数** —— PT 无磁盘目录，
 * `diff-report.cjs` 那套按路径比对的核对在 PT 上**根本不可用**。
 * 故 AC-2/AC-3 在 PT 上的内容级核对就落在这份读数上（与源包侧的类目计数对照）。
 *
 * @returns {Promise<Array<{moduleId:string,name:string,records:number,blobs:number,meta:string}>>}
 */
async function readPanelModules(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#ptdm-modules .ptdm-module-row'));
    return rows.map((row) => {
      const box = row.querySelector('input[data-module]');
      const meta = (row.querySelector('.ptdm-module-meta') || {}).textContent || '';
      const rec = /(\d+)\s*records/.exec(meta);
      const blob = /(\d+)\s*blobs/.exec(meta);
      return {
        moduleId: box ? box.dataset.module : '',
        name: ((row.querySelector('strong') || {}).textContent || '').trim(),
        records: rec ? Number(rec[1]) : null,
        blobs: blob ? Number(blob[1]) : null,
        meta: meta.trim(),
      };
    });
  });
}

/**
 * 等面板的模块清单渲染出来（首次打开时是异步填充的，瞬时读会得到空数组）。
 */
async function waitPanelModules(page, timeoutMs = 30000) {
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('#ptdm-modules .ptdm-module-row').length > 0,
      null, { timeout: timeoutMs },
    );
    return true;
  } catch { return false; }
}

async function readQuota(page) {
  return page.evaluate(() => {
    const txt = (id) => {
      const el = document.getElementById(id);
      return el ? el.textContent.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    };
    const bar = document.getElementById('ptdm-quota');
    return {
      summary: txt('ptdm-summary'),
      persistence: txt('ptdm-persistence'),
      quota: bar ? `${bar.value}/${bar.max}` : null,
    };
  });
}

async function runTtImport(page, packPath, { strategy, method, timeout }) {
  // 1) **导入方式**：TT 导入与 PT 自家归档**共用**这一个全局选择框
  //    （`selectedImportMethod()` 读 `#ptdm-import-method`，见 `runtime/index.js:105`）
  //    `fast` = 整包解压进内存，`slow` = 逐文件低内存 ⇒ 大包必须用 slow。
  const meth = await page.evaluate((want) => {
    const sel = document.querySelector('#ptdm-import-method');
    if (!sel) return { ok: false, reason: '找不到 #ptdm-import-method' };
    if (sel.value !== want) {
      sel.value = want;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { ok: true, value: sel.value };
  }, method);
  console.log(`[导入] 导入方式：${meth.value || meth.reason}（大包须 slow = 逐文件低内存）`);

  // 2) 冲突策略
  const strat = await page.evaluate((want) => {
    const sel = document.querySelector('#ptdm-tt-strategy');
    if (!sel) return { ok: false, reason: '找不到 #ptdm-tt-strategy' };
    if (sel.value !== want) {
      sel.value = want;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { ok: true, value: sel.value };
  }, strategy);
  if (!strat.ok) return { dialogs: [], done: false, signal: strat.reason, reloaded: false };
  console.log(`[导入] 策略：${strat.value}（U-3 要求 merge）`);

  // 3) 投递文件
  await page.setInputFiles('#ptdm-tt-import-file', packPath);
  console.log('[导入] 已投递文件');

  // 4) **等按钮启用**再点 —— 投文件只触发**异步预览**，预览完成前该按钮是 `disabled` 的
  //    （`previewTauriTavernImport`：:629 `disabled = true` → 预览完成 :684 `disabled = false`）。
  //    实测教训：投完就点 ⇒ 拿到「被禁用」而整条流程静默不走（第一次真导入就是这样）。
  let btnReady = false;
  try {
    await page.waitForFunction(() => {
      const b = document.getElementById('ptdm-tt-import-confirm');
      return Boolean(b) && !b.disabled;
    }, null, { timeout: 180000 });
    btnReady = true;
  } catch { btnReady = false; }
  const previewText = await page.evaluate(() => {
    const el = document.getElementById('ptdm-tt-preview');
    return el ? el.textContent.replace(/\s+/g, ' ').slice(0, 200) : '';
  }).catch(() => '');
  console.log(`[导入] 预览完成、按钮启用：${btnReady}`);
  if (previewText) console.log(`[导入] 预览读数：${previewText}`);
  if (!btnReady) {
    return { dialogs: [], done: false, signal: '等待 #ptdm-tt-import-confirm 启用超时（预览未完成？）', reloaded: false };
  }

  // 5) 点「执行 TauriTavern 导入」（**只投文件不会开始**，实测如此）
  const clickedRun = await page.evaluate(() => {
    const b = document.getElementById('ptdm-tt-import-confirm');
    if (!b || b.disabled) return false;
    b.click();
    return true;
  });
  if (!clickedRun) {
    return { dialogs: [], done: false, signal: '未找到或被禁用的 #ptdm-tt-import-confirm', reloaded: false };
  }
  console.log('[导入] 已点「执行 TauriTavern 导入」');

  // 6) **两层**确认（见 drainConfirmDialogs 头注）
  const drained = await drainConfirmDialogs(page, timeout);
  const dialogs = drained.dialogs;
  console.log(`[导入] 共处理确认层 ${dialogs.length} 层：`
    + `${dialogs.map((h) => `${h.kind}(${h.label})`).join(' → ') || '（无）'}`);

  // 7) 有界等待完成。
  //    **完成信号是「页面 reload」**（源码 `runtime/index.js` TT 分支末尾
  //    `notify('success', 'TauriTavern 数据导入完成，页面即将刷新。')` 之后
  //    `setTimeout(() => location.reload(), 500)`）—— 实测该浮层只存在约 500 ms，
  //    3 s 间隔的文本轮询**必然错过**（第一次成功的导入就栽在这里：计数明明已增长，
  //    却被判成「超时未检出完成信号」）。
  //    ⇒ 改用 **framenavigated 事件**作判据，并把文本轮询收紧到 800 ms 作辅助。
  // drain 阶段若已等到 reload，则直接判完成（不必再等一轮完整预算）
  let navigated = Boolean(drained.reloaded);
  const onNav = (frame) => { if (frame === page.mainFrame()) navigated = true; };
  page.on('framenavigated', onNav);
  const deadline = Date.now() + timeout;
  let signal = navigated ? '页面已 reload（导入完成）' : '';
  let done = navigated;
  try {
    while (Date.now() < deadline) {
      await page.waitForTimeout(800);
      if (navigated) { done = true; signal = '页面已 reload（导入完成）'; break; }
      const txt = await page.evaluate(() => document.body.innerText).catch(() => '');
      if (/TauriTavern 数据导入完成|数据导入完成|导入完成|导入成功/i.test(txt)) {
        done = true;
        signal = '界面报导入完成';
        break;
      }
      if (/导入失败|Import failed/i.test(txt)) { signal = '界面报导入失败'; break; }
    }
  } finally {
    page.off('framenavigated', onNav);
  }
  if (done) {
    // 等 reload 落定，否则随后的计数可能读到半途状态
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(4000);
  }
  return { dialogs, done, signal: signal || '超时未检出完成信号', reloaded: navigated };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const usage = '用法：node scripts/instance-sync/import-pt.cjs'
    + ' [--pack <pack-tt-*.zip>] [--method slow|fast] [--dry-run] [--report] [--allow-large]';

  // `--report` 是**只读核对**（不导入任何数据）⇒ 不要求包
  const tildeRe = new RegExp('^~(?=$|[\\/])');
  const packPath = args.pack
    ? path.resolve(args.pack.replace(tildeRe, process.env.USERPROFILE || process.env.HOME || '~'))
    : '';
  let sizeMb = 0;
  if (!args.report) {
    if (!args.pack) {
      console.error(usage);
      process.exit(2);
    }
    if (!fs.existsSync(packPath)) {
      console.error(`包不存在：${packPath}`);
      process.exit(2);
    }
    sizeMb = fs.statSync(packPath).size / MB;
    console.log(`[包] ${packPath}（${sizeMb.toFixed(1)} MB）`);
  } else {
    console.log('[模式] --report：只读核对 PT 侧读数，不导入任何数据');
  }

  if (sizeMb > LARGE_PACK_MB && !args.allowLarge) {
    console.error(
      `\n[拒绝] 包体积 ${sizeMb.toFixed(1)} MB 超过 ${LARGE_PACK_MB} MB 阈值。\n`
      + '  原因：PT 数据落浏览器 IndexedDB，实测其 storagePersistence 为 **best-effort**\n'
      + '  ⇒ 磁盘紧张时浏览器**可能静默清空整个库**（这是真实的数据风险，不是保守估计）。\n'
      + '  若确要导入，请显式加 `--allow-large`，并自行确认 PT 所在盘有足够空间。\n',
    );
    process.exit(3);
  }

  const pw = loadPlaywright();
  warnOnVersionDrift(pw);
  const inst = getInstance(args.id);

  const ctx = await pw.chromium.launchPersistentContext(inst.profile, {
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 950 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  page.setDefaultTimeout(60000);

  try {
    await page.goto(inst.url, { waitUntil: 'domcontentloaded' });
    const ready = await waitPtReady(page);
    console.log(`[PT] 初始化完成：${ready}`);

    const panel = await openDataPanel(page);
    console.log(`[面板] 数据管理面板：${JSON.stringify(panel)}`);
    if (!panel.ok) throw new Error(`无法打开数据管理面板：${panel.reason}`);

    const quota = await readQuota(page);
    console.log('[配额] 存储读数：', JSON.stringify(quota).slice(0, 320));
    if (/尽力而为|best-effort/i.test(quota.summary + quota.persistence)) {
      console.log('[配额] ⚠️ 存储模式为「尽力而为」：磁盘紧张时浏览器可能静默清空整个库');
    }

    const before = await countPtData(page);
    console.log('[计数] 导入前：', JSON.stringify(before).slice(0, 300));

    if (args.report) {
      // 只读核对：PT 侧**唯一**的模块级真源读数（无磁盘目录，路径比对不适用）
      await waitPanelModules(page);
      const modules = await readPanelModules(page);
      const q = await readQuota(page);
      console.log('[核对] 存储配额读数：', JSON.stringify(q).slice(0, 400));
      console.log('[核对] 模块清单（PT 侧）：');
      for (const m of modules) {
        console.log(`       ${m.moduleId.padEnd(14)} ${m.name.padEnd(22)} ${m.meta}`);
      }
      console.log(`[核对] 共 ${modules.length} 个模块`);
      const shot = path.join(SHOT_DIR, 'pt-modules-report.png');
      await page.screenshot({ path: shot });
      console.log(`       截图 → ${shot}`);
      return;
    }

    if (args.dryRun) {
      const shot = path.join(SHOT_DIR, 'pt-import-dryrun.png');
      await page.screenshot({ path: shot });
      console.log('[空转] --dry-run：只验证面板可达与计数装置可用，未导入任何数据');
      console.log(`       截图 → ${shot}`);
      return;
    }

    const t0 = Date.now();
    const result = await runTtImport(page, packPath, {
      strategy: args.strategy, method: args.method, timeout: args.timeout,
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[导入] 结果：${JSON.stringify(result)}（耗时 ${secs}s）`);

    // 导入成功会触发页面 reload（`runtime/index.js:` 的 `setTimeout(location.reload, 500)`）
    // ⇒ 计数前先等 PT 重新就绪，否则可能读到半途状态
    if (result.reloaded) await waitPtReady(page, 120000);
    const after = await countPtData(page);
    const diff = diffPtCounts(before, after);
    console.log(`[计数] 导入后总记录 ${diff.totalBefore} → ${diff.totalAfter}（Δ${diff.totalAfter - diff.totalBefore}）`);
    for (const g of diff.grown.slice(0, 12)) console.log(`       + ${g.key}: ${g.before} → ${g.after}（+${g.delta}）`);
    for (const s of diff.shrank.slice(0, 12)) console.log(`       - ${s.key}: ${s.before} → ${s.after}（${s.delta}）`);

    const shot = path.join(SHOT_DIR, 'pt-import-result.png');
    await page.screenshot({ path: shot });
    console.log(`       截图 → ${shot}`);

    // 判定：导入成功应当**只增不减**（U-3「不删独有」的直接体现）
    if (diff.shrank.length) {
      console.log('[警告] 存在**减少**的 store —— 与 U-3「不删独有」不符，需人工核查上方读数');
    }
    if (!result.done && diff.totalAfter === diff.totalBefore) {
      console.log('[警告] 既无完成信号、计数也未变化 ⇒ 视为**未成功**');
      process.exitCode = 1;
    }

    if (args.keepOpen) {
      console.log('[保持] --keep-open：浏览器保持打开 600s 供人工查看');
      await page.waitForTimeout(600000);
    }
  } finally {
    await ctx.close();
  }
})().catch((e) => {
  console.error('PT 导入失败：', e && e.message ? e.message : e);
  process.exit(1);
});