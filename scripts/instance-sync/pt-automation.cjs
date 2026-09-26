/**
 * PT（PureTavern）自动化：安装本插件 + M21 数据导入
 *
 * 通道依据（读自 PT 仓 `apps/web/src/features/`）：
 *   - 扩展安装：界面元素 `#third_party_extension_button`（「安装扩展程序」）弹出
 *     「输入扩展程序的 Git URL 以安装」表单，含 URL 框（无 id）、分支框
 *     `input#extension_branch_name`（`legacy/install-default-branch.ts:1` 的
 *     `BRANCH_INPUT_SELECTOR`）、以及「给所有人安装 / 只给我安装 / 取消」。
 *   - M21 导入：`features/import-export/README.md` —— 吃的是 **SillyTavern `data/default-user` 树**，
 *     而本任务的 `pack-tt-*.zip` 正是该形态；导入由 `ArchiveService` 在浏览器内完成
 *     （数据落 IndexedDB），故必须由浏览器驱动。
 *
 * PT 是纯前端（`userDir: null`，无磁盘数据目录），因此**没有** `diff-report` 那类
 * 「按文件路径比对」的核对手段 —— 核对改走**界面读数**（角色/聊天计数）。
 *
 * 用法：
 *   node scripts/instance-sync/pt-automation.cjs --install-plugin
 *   node scripts/instance-sync/pt-automation.cjs --probe-import      # 探明 M21 导入入口
 *   node scripts/instance-sync/pt-automation.cjs --import-pack <zip>
 *
 * 纪律：用 `PROFILES.dev` 的持久化上下文（实例登记里的 pt-web.profile），只连 :8899。
 */

const fs = require('fs');
const path = require('path');

const { loadPlaywright, warnOnVersionDrift } = require('../../e2e/lib/resolve-playwright.cjs');
const { getInstance } = require('../../e2e/lib/instances.cjs');
// PT 数据计数装置抽到 lib（**唯一实现**，import-pt.cjs 共用；防两处口径漂移）
const { countPtData } = require('./lib/pt-count.cjs');

const PLUGIN_GIT_URL = 'https://github.com/jiozhaoyue/st-zip-converter';
const SHOT_DIR = path.resolve(__dirname, '..', '..', 'test-results');

function parseArgs(argv) {
  const out = {
    installPlugin: false, probeImport: false, probeData: false, importPack: '',
    branch: 'main', timeout: 900000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--install-plugin') out.installPlugin = true;
    else if (argv[i] === '--probe-import') out.probeImport = true;
    else if (argv[i] === '--probe-data-panel') out.probeData = true;
    else if (argv[i] === '--import-pack') out.importPack = argv[++i] || '';
    else if (argv[i] === '--timeout') out.timeout = Number(argv[++i]) || out.timeout;
    else if (argv[i] === '--branch') out.branch = argv[++i] || 'main';
  }
  return out;
}

/**
 * PT 的数据落在 **IndexedDB**（纯前端、无磁盘目录）⇒ 这是唯一可程序化读到的「真源计数」。
 * 逐库逐 store `count()`：拿到的是记录条数，不是界面上的渲染项（界面会被虚拟滚动截断）。
 *
 * 注意：`indexedDB.databases()` 在部分实现里可能不返回**尚未打开**的库，
 * 故这里同时兜住 `open()` 失败的情形（返回 -1 而不是抛错），保证导入流程不被计数拖垮。
 */
/** 打开 PT 并**有界等待**初始化完成（首屏「正在初始化…」时 DOM 是空壳） */
async function openPt(pw, inst) {
  const ctx = await pw.chromium.launchPersistentContext(inst.profile, {
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(inst.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  const deadline = Date.now() + 180000;
  let waited = 0;
  while (Date.now() < deadline) {
    const busy = await page.evaluate(() => document.body.innerText.includes('正在初始化')).catch(() => false);
    if (!busy) break;
    await page.waitForTimeout(3000);
    waited += 3;
  }
  if (waited) console.log(`[等待] 「正在初始化」约 ${waited}s 后结束`);
  return { ctx, page };
}

/** 点开「扩展程序」抽屉 */
async function openExtensionsDrawer(page) {
  const ok = await page.evaluate(() => {
    for (const el of document.querySelectorAll('div,button,a,[role="button"]')) {
      if ((el.innerText || '').trim() === '扩展程序' && el.getBoundingClientRect().width > 0) { el.click(); return true; }
    }
    return false;
  });
  await page.waitForTimeout(2500);
  return ok;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const inst = getInstance('pt-web');
  const pw = loadPlaywright();
  warnOnVersionDrift(pw);
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const { ctx, page } = await openPt(pw, inst);
  try {
    const drawer = await openExtensionsDrawer(page);
    console.log(`[扩展程序] 抽屉打开：${drawer ? '成功' : '失败'}`);
    if (!drawer) throw new Error('找不到「扩展程序」入口');

    if (args.installPlugin) {
      // —— 打开安装弹窗 ——
      const opened = await page.evaluate(() => {
        const el = document.querySelector('#third_party_extension_button');
        if (!el) return false;
        el.click();
        return true;
      });
      console.log(`[安装] 弹窗打开：${opened ? '成功' : '失败'}（#third_party_extension_button）`);
      if (!opened) throw new Error('找不到「安装扩展程序」按钮');
      await page.waitForTimeout(2500);

      // —— 填 URL：弹窗里「非分支框」的第一个可编辑输入 ——
      // 依据：URL 框**没有 id**（PT 只给分支框加了 `extension_branch_name`），
      // 故以分支框为锚点取同容器内的其它文本输入。
      const filled = await page.evaluate((url) => {
        const branch = document.querySelector('#extension_branch_name');
        if (!branch) return { ok: false, reason: '找不到分支输入框' };
        // 从分支框向上找共同容器，再在其内找 URL 框
        let root = branch.parentElement;
        let urlInput = null;
        for (let hop = 0; hop < 5 && root && !urlInput; hop += 1) {
          for (const el of root.querySelectorAll('input, textarea')) {
            if (el === branch) continue;
            const t = (el.getAttribute('type') || 'text').toLowerCase();
            if (t === 'checkbox' || t === 'radio' || t === 'hidden') continue;
            if ((el.id || '') === 'extensions_url') continue; // 那是已弃用的「扩展 API URL」字段
            urlInput = el;
            break;
          }
          root = root.parentElement;
        }
        if (!urlInput) return { ok: false, reason: '找不到 URL 输入框' };
        urlInput.focus();
        urlInput.value = url;
        urlInput.dispatchEvent(new Event('input', { bubbles: true }));
        urlInput.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, id: urlInput.id || '(无 id)', tag: urlInput.tagName };
      }, PLUGIN_GIT_URL);
      console.log(`[安装] 填 URL：${JSON.stringify(filled)}`);
      await page.waitForTimeout(1000);

      await page.screenshot({ path: path.join(SHOT_DIR, 'pt-install-filled.png') });

      // —— 点「只给我安装」 ——
      const clicked = await page.evaluate(() => {
        for (const el of document.querySelectorAll('div,button,a,[role="button"]')) {
          const t = (el.innerText || '').trim();
          if (t === '只给我安装' && el.getBoundingClientRect().width > 0) { el.click(); return true; }
        }
        return false;
      });
      console.log(`[安装] 点「只给我安装」：${clicked ? '成功' : '失败'}`);
      await page.waitForTimeout(3000);

      /**
       * **二次确认弹窗**：PT 会再弹一个
       *   「Install a third-party extension? / The URL you provided does not seem to be
       *     an official SillyTavern extension repository. … Are you sure you want to proceed?」
       * 带 `Yes, install it` / `No, cancel`。
       * 不点它，安装就停在那里 —— 实测第一次跑正是卡在这一步（截图 pt-install-result.png）。
       */
      const confirmed = await page.evaluate(() => {
        for (const el of document.querySelectorAll('button, div, a, [role="button"]')) {
          const t = (el.innerText || '').trim();
          if ((t === 'Yes, install it' || t === 'Yes, install it ') && el.getBoundingClientRect().width > 0) {
            el.click();
            return true;
          }
        }
        return false;
      });
      console.log(`[安装] 二次确认（Yes, install it）：${confirmed ? '成功' : '未出现（可能无需确认）'}`);

      // 安装要走 GitHub 网络，给足时间
      console.log('[安装] 等待安装完成（最多 120s）…');
      const instDeadline = Date.now() + 120000;
      let installed = false;
      while (Date.now() < instDeadline) {
        const txt = await page.evaluate(() => document.body.innerText).catch(() => '');
        if (txt.includes('st-zip-converter') || txt.includes('ST-zip-converter') || txt.includes('酒馆数据包')) { installed = true; break; }
        if (txt.includes('安装失败') || txt.includes('Failed')) break;
        await page.waitForTimeout(4000);
      }
      await page.screenshot({ path: path.join(SHOT_DIR, 'pt-install-result.png') });
      console.log(`[安装] 结果：${installed ? '✅ 界面已出现插件条目' : '⚠️ 未在界面文本中检出插件名（见截图 pt-install-result.png）'}`);
      console.log(`       截图 → ${path.join(SHOT_DIR, 'pt-install-result.png')}`);
    }

    if (args.probeImport) {
      // —— 探 M21 导入入口：列出当前界面所有可见文本元素，从里面找「导入」 ——
      const items = await page.evaluate(() => {
        const out = []; const seen = new Set();
        for (const el of document.querySelectorAll('button, a, [role="button"], div, span, h4, label')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
          if (!t || t.length > 30) continue;
          const key = el.tagName + '|' + t;
          if (seen.has(key)) continue; seen.add(key);
          out.push({ tag: el.tagName, text: t, id: el.id || '' });
        }
        return out;
      });
      console.log(`\n=== 当前界面可见文本元素（${items.length}）===`);
      items.slice(0, 70).forEach((x) => console.log(`  [${x.tag}] ${x.text}${x.id ? ` #${x.id}` : ''}`));
      await page.screenshot({ path: path.join(SHOT_DIR, 'pt-import-probe.png') });
      console.log(`\n截图 → ${path.join(SHOT_DIR, 'pt-import-probe.png')}`);
    }
    if (args.probeData) {
      /**
       * 探查「PureTavern 数据管理」面板 —— M21 导入/导出的入口就在那里
       * （证据：界面可见文本里有 `[DIV] PureTavern 数据管理`，见 `test-results/pt-import-probe.png`）。
       */
      const openedPanel = await page.evaluate(() => {
        for (const el of document.querySelectorAll('div,button,a,[role="button"],span')) {
          if ((el.innerText || '').trim() === 'PureTavern 数据管理' && el.getBoundingClientRect().width > 0) {
            el.click();
            return true;
          }
        }
        return false;
      });
      console.log(`[数据管理] 面板打开：${openedPanel ? '成功' : '失败'}`);
      await page.waitForTimeout(2500);

      const dump = await page.evaluate(() => {
        const texts = [];
        const seen = new Set();
        for (const el of document.querySelectorAll('button, a, [role="button"], label, h4, span, div')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
          if (!t || t.length > 40) continue;
          const key = `${el.tagName}|${t}`;
          if (seen.has(key)) continue;
          seen.add(key);
          texts.push({ tag: el.tagName, text: t, id: el.id || '' });
        }
        const inputs = [...document.querySelectorAll('input, textarea, select')].map((el) => ({
          tag: el.tagName, type: el.getAttribute('type') || '', id: el.id || '',
          accept: el.getAttribute('accept') || '', visible: el.getBoundingClientRect().width > 0,
        }));
        const files = [...document.querySelectorAll('input[type=file]')].map((el) => ({
          id: el.id || '', accept: el.getAttribute('accept') || '', multiple: el.multiple,
          visible: el.getBoundingClientRect().width > 0,
        }));
        // 下拉框的候选值：`ptdm-*` 是数据管理面板自己的（导入方式 / 冲突策略）
        const selects = [...document.querySelectorAll('select')].map((el) => ({
          id: el.id || '',
          value: el.value,
          options: [...el.options].map((o) => ({ value: o.value, text: (o.textContent || '').trim() })),
        }));
        return { texts, inputs, files, selects };
      });
      console.log(`\n=== 面板内可见文本（${dump.texts.length}）===`);
      dump.texts.slice(0, 60).forEach((x) => console.log(`  [${x.tag}] ${x.text}${x.id ? ` #${x.id}` : ''}`));
      console.log(`\n=== 输入控件（${dump.inputs.length}）===`);
      dump.inputs.forEach((x) => console.log(`  [${x.tag}/${x.type}] #${x.id} accept=${x.accept} visible=${x.visible}`));
      console.log(`\n=== 文件输入（${dump.files.length}）===`);
      dump.files.forEach((x) => console.log(`  #${x.id} accept=${x.accept} multiple=${x.multiple} visible=${x.visible}`));
      console.log('\n=== 下拉框（含候选值）===');
      for (const s of dump.selects.filter((x) => x.id)) {
        console.log(`  #${s.id} 当前=${s.value}`);
        for (const o of s.options) console.log(`      ${o.value} → ${o.text}`);
      }
      const shot = path.join(SHOT_DIR, 'pt-data-panel.png');
      await page.screenshot({ path: shot });
      console.log(`\n截图 → ${shot}`);
    }

    if (args.importPack) {
      /**
       * TT 布局包 → PT 的 **M21 / TT 导入**（`#ptdm-tt-import-file`，策略选择框 `#ptdm-tt-strategy`）。
       *
       * 通道依据（2026-09-26 实测探明）：数据管理面板里有两组导入 ——
       *   `#ptdm-import-file` + `#ptdm-import-method`（PT 自家归档，"fast"/"slow"）
       *   `#ptdm-tt-import-file` + `#ptdm-tt-strategy`（**TT 归档**，默认策略 `merge`）
       * 本任务产出的是 **TT 布局树**，故走后者；`merge` 与 U-3「覆盖同名、不删独有」一致。
       *
       * ⚠️ PT 是**纯前端**（数据落 IndexedDB），没有磁盘目录可比对 ⇒
       * 核对手段只能是「库计数 + 界面读数」，不是 `diff-report` 那套路径比对。
       */
      const packPath = path.resolve(args.importPack);
      if (!fs.existsSync(packPath)) throw new Error(`包不存在：${packPath}`);
      console.log(`[导入] 包：${packPath}（${(fs.statSync(packPath).size / 1048576).toFixed(1)} MB）`);

      const openedPanel = await page.evaluate(() => {
        for (const el of document.querySelectorAll('div,button,a,[role="button"],span')) {
          if ((el.innerText || '').trim() !== 'PureTavern 数据管理') continue;
          // 优先点「可折叠抽屉」的开关（PT 的设置项都是 inline-drawer）
          const drawer = el.closest('.inline-drawer') || el.parentElement;
          const toggle = drawer && drawer.querySelector('.inline-drawer-toggle');
          (toggle || el).click();
          return true;
        }
        return false;
      });
      console.log(`[导入] 数据管理面板展开：${openedPanel ? '成功' : '失败'}`);
      await page.waitForTimeout(2000);

      const before = await countPtData(page);
      console.log('[导入] 导入前库计数：', JSON.stringify(before).slice(0, 400));

      const ensureMerge = await page.evaluate(() => {
        const sel = document.querySelector('#ptdm-tt-strategy');
        if (!sel) return { ok: false, reason: '找不到 #ptdm-tt-strategy' };
        if (sel.value !== 'merge') {
          sel.value = 'merge';
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return { ok: true, value: sel.value };
      });
      console.log(`[导入] 策略：${JSON.stringify(ensureMerge)}（U-3 要求 merge）`);

      await page.setInputFiles('#ptdm-tt-import-file', packPath);
      console.log('[导入] 已投递文件，等待处理…（有界等待，最多 ' + Math.round(args.timeout / 1000) + 's）');

      const deadline = Date.now() + args.timeout;
      let last = JSON.stringify(before);
      let done = false;
      while (Date.now() < deadline) {
        await page.waitForTimeout(5000);
        const txt = await page.evaluate(() => document.body.innerText).catch(() => '');
        if (/导入完成|导入成功|Import (completed|successful)/i.test(txt)) { done = true; break; }
        if (/导入失败|Import failed/i.test(txt)) { console.log('[导入] 界面报「导入失败」'); break; }
        const now = await countPtData(page).catch(() => null);
        if (now) {
          const s = JSON.stringify(now);
          if (s !== last) { console.log(`[导入] 库计数变化：${s.slice(0, 300)}`); last = s; }
        }
      }
      const after = await countPtData(page).catch(() => null);
      const shot = path.join(SHOT_DIR, 'pt-tt-import-result.png');
      await page.screenshot({ path: shot });
      console.log(`[导入] ${done ? '✅ 界面报告导入完成' : '⚠️ 未检出明确的完成信号（见截图与库计数）'}`);
      console.log('[导入] 导入后库计数：', JSON.stringify(after).slice(0, 400));
      console.log(`       截图 → ${shot}`);
    }
  } finally {
    await ctx.close();
  }
})().catch((e) => {
  console.error('PT 自动化失败：', e && e.message ? e.message : e);
  process.exit(1);
});
