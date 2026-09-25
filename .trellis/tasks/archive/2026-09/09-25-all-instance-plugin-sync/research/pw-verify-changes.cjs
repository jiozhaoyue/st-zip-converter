/**
 * 本次改动（R4 配色 / R5 弹窗 / R6 容器）的实机核对（Dev 8003 / Real 8004，只读）
 *
 * 逐条对应 prd 验收项，避免"测试绿了就当实机也绿"：
 *   1. 插件新文件确实被宿主提供（`src/ui/action-colors.js` HTTP 200、`manifest.json` 可读）
 *      —— 证明实例里跑的是 `1640118` 而不是旧码；
 *   2. R4：动作语义色 `--st-action-copy` 在**本插件容器上**解析为具体颜色
 *      （若令牌块没生效，`getComputedStyle(...).getPropertyValue()` 会返回空串）；
 *      `synth` 应跟随宿主强调色（`--SmartThemeQuoteColor`）而非写死；
 *   3. R5：`src/ui/host-bridge.js` 里能读到 `alertDialog` 导出（拉取后的文件内容核对）；
 *   4. R6：`index.js` 里不再有 `getElementById('app')` 兜底；
 *   5. 宿主页面未被弄脏：`body` / `html` 的 class 与内联 style 与「屏蔽插件」对照一致。
 *
 * 用法：node pw-verify-changes.cjs            # 默认 8003
 *       DEV_URL=https://127.0.0.1:8004 node pw-verify-changes.cjs
 */
const path = require('path');
const fs = require('fs');

function loadPlaywright() {
  try { return require('playwright'); } catch {
    const g = require('child_process').execSync('npm root -g').toString().trim();
    return require(path.join(g, 'playwright'));
  }
}

const { chromium } = loadPlaywright();
const BASE = process.env.DEV_URL || 'https://127.0.0.1:8003';
const PORT_TAG = (BASE.match(/:(\d+)/) || [, 'unknown'])[1];
const PROFILE = path.resolve(__dirname, '../../../../.pw-profile-dev');
// 插件安装目录：按**标准仓群布局**相对定位，不写本机绝对路径
// （L1-MR-14「提交前确认零本地绝对路径」/ P-17「资料索引不得写本机路径」——
//  绝对路径进公开仓等于把本机目录结构交出去，且换机器必然失效）。
// 布局：`<Tavern-repo>/My-repo/ST-zip-converter`（本仓根 = 4 层上）→ 再上 2 层即 `<Tavern-repo>`。
const PLUGIN_DIR = process.env.PLUGIN_DIR
  || path.resolve(__dirname, '../../../../../../Instance/Dev/Luker/data/default-user/extensions/st-zip-converter');

/** 源码侧核对（不需要浏览器）：新代码是否真的在实例目录里 */
function sourceChecks() {
  const read = (rel) => fs.readFileSync(path.join(PLUGIN_DIR, rel), 'utf8');
  const hostBridge = read('src/ui/host-bridge.js');
  const indexJs = read('index.js');
  // R6 的判据要精确，两层都要防：
  //   ① 允许独立态分支查 `#app`（那是骨架容器）；要禁的是 `main()` 的默认参数兜底，
  //      以及「在判定宿主之前就按 `#app` 分支」；
  //   ② **注释里出现的字符串不算**——首版探针既把正确的独立态查找报了 False，
  //      又把两处解释性注释里的同名字符串算成了第三处（探针过粗，不是代码问题）。
  const codeLines = indexJs.split('\n').map((text, i) => ({
    no: i + 1,
    text,
    isComment: /^\s*(?:\*|\/\/|\/\*)/.test(text),
  }));
  const hostBranchLine = (codeLines.find((l) => !l.isComment && l.text.includes('if (host.isPlugin)')) || {}).no || -1;
  const appLookupLines = codeLines
    .filter((l) => !l.isComment && /getElementById\('app'\)/.test(l.text))
    .map((l) => l.no);
  return {
    pluginDir: PLUGIN_DIR,
    head: require('child_process').execSync(`git -C "${PLUGIN_DIR}" log -1 --format=%H`).toString().trim(),
    r5_alertDialogExported: /export async function alertDialog\(/.test(hostBridge),
    r5_usesPopupShowText: /Popup\?\.show\?\.text/.test(hostBridge),
    // 反证：不得出现外推的 show.alert
    r5_noFabricatedAlert: !/show\?\.alert/.test(hostBridge),
    r5_bareAlertInIndex: (indexJs.match(/(?<![a-zA-Z_.])alert\(/g) || []).length,
    r6_noMainDefaultFallback: !/async function main\(appRoot = document\.getElementById\('app'\)\)/.test(indexJs),
    r6_hostFirstBranchLine: hostBranchLine,
    r6_appLookupCodeLines: appLookupLines,
    r6_appLookupOnlyAfterHostBranch: hostBranchLine > 0 && appLookupLines.length > 0
      && appLookupLines.every((n) => n > hostBranchLine),
    r4_actionColorsPresent: fs.existsSync(path.join(PLUGIN_DIR, 'src/ui/action-colors.js')),
    r4_splitModalDeleted: !fs.existsSync(path.join(PLUGIN_DIR, 'src/ui/split-deliver-modal.js')),
    r4_archiveManagerDeleted: !fs.existsSync(path.join(PLUGIN_DIR, 'src/ui/archive-manager.js')),
    r7_domScopeGuardPresent: fs.existsSync(path.join(PLUGIN_DIR, 'scripts/dom-scope.js')),
  };
}

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, { ignoreHTTPSErrors: true, viewport: { width: 1600, height: 950 } });
  const errors = [];
  const pluginResources = [];
  const failedRequests = [];
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
    page.on('response', (r) => {
      // 带 URL 记录所有 4xx/5xx：只有这样才能判断某一处 404 是不是**本插件**引起的
      if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url().slice(0, 150)}`);
      if (/st-zip-converter/.test(r.url()) && r.status() !== 304) pluginResources.push(`${r.status()} ${r.url().replace(BASE, '').slice(0, 110)}`);
    });

    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(20000);

    const runtime = await page.evaluate(() => {
      const drawer = document.querySelector('#app.st-converter-drawer-app');
      const scopeEl = drawer || document.querySelector('.st-converter-drawer-app');
      const readVar = (name) => (scopeEl ? getComputedStyle(scopeEl).getPropertyValue(name).trim() : null);
      const sig = (el) => (el ? `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}|${el.getAttribute('style') || ''}` : null);
      return {
        pluginLoaded: !!drawer,
        settingsPanel: !!document.getElementById('st-zip-converter-settings-panel'),
        menuItem: !!document.getElementById('st-zip-converter-menu-item'),
        // R4：动作语义色令牌块是否生效
        actionCopyVar: readVar('--st-action-copy'),
        actionSynthVar: readVar('--st-action-synth'),
        hostQuoteColor: getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeQuoteColor').trim(),
        accentVar: readVar('--accent'),
        // 宿主未被弄脏
        bodySig: sig(document.body),
        htmlCls: document.documentElement.className,
      };
    });

    // 顺带把账号弹层的两个注入点也打开确认（R6 改了 bootstrap 分支，注入路径必须仍通）
    await page.evaluate(() => document.getElementById('account_button')?.click());
    await page.waitForTimeout(2500);
    const injectedInPopup = await page.evaluate(() => ({
      nativeBtn: !!document.getElementById('st-zip-converter-native-btn'),
      quickFetch: !!document.getElementById('st-zip-converter-native-btn-quick-fetch'),
    }));

    const result = {
      sampledAt: new Date().toISOString(), url: BASE,
      source: sourceChecks(),
      runtime: Object.assign(runtime, { injectedInPopup }),
      pluginResources: Array.from(new Set(pluginResources)).sort(),
      failedRequests: Array.from(new Set(failedRequests)).sort(),
      pluginOwnFailedRequests: Array.from(new Set(failedRequests)).filter((u) => /st-zip-converter/.test(u)),
      consoleErrors: errors.slice(0, 20),
    };
    const out = path.join(__dirname, `verify-changes-${PORT_TAG}.json`);
    fs.writeFileSync(out, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({ out, ...result }, null, 1));
  } finally { await ctx.close(); }
})();
