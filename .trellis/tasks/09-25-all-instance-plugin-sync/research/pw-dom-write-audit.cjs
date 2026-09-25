/**
 * DOM 写操作归因审计（Dev Luker 8003，只读）
 *
 * 为什么需要它：全树 diff（`pw-dom-intrusion-audit.cjs`）被宿主自身的异步渲染（regex 面板、
 * 计时器等）淹没了——同一份页面跑两遍都会差出几十个节点，噪声基线也压不干净。
 * 要断言「插件有没有改别人的元素」，必须**按调用栈归因到具体脚本**，而不是靠 diff 猜。
 *
 * 做法：`addInitScript` 在页面任何脚本之前劫持 DOM 写 API，每次调用记录：
 *   · 操作名（appendChild / insertBefore / removeChild / replaceChild / setAttribute /
 *     removeAttribute / classList.add|remove|toggle / el.remove）
 *   · 目标元素的「家谱」（最近的 8 层祖先，`#id` 优先、否则 `.class`、再否则 tag）
 *   · 目标是否落在**本插件自有容器内**（`closest(PLUGIN_SELECTOR)`）
 *   · 被插入/移除的子节点签名（childList 类操作）
 *   · **调用栈**——栈里出现 `/st-zip-converter/` 即判定为**插件所为**
 *
 * 劫持发生在 `Node.prototype` / `Element.prototype` 上，对所有脚本生效，因此宿主自身的写操作
 * 也会被记录，形成对照：`plugin:true` 的才是本插件的责任范围。
 *
 * 断言口径（由 `--analyze` 输出）：
 *   1. 插件写自己容器内 → 合法；
 *   2. 插件写宿主元素 → **必须**落在显式声明的宿主锚点上，且只增删**自己产物的节点**，
 *      不得改动宿主既有节点的属性/class（`setAttribute`/`classList.*` 打在非插件节点上 = 违规）；
 *   3. `removeChild` 掉宿主既有节点 = 违规。
 *
 * 已知盲区（如实记录，不假装覆盖）：`el.style.foo = x` 这类**直接内联样式赋值**不经过
 * `setAttribute`/`setProperty`，本仪器抓不到；由静态检查补（见研究笔记里的 grep）。
 *
 * 用法：
 *   node pw-dom-write-audit.cjs             # 采集（含打开账号弹层与抽屉，覆盖注入路径）
 *   node pw-dom-write-audit.cjs --analyze   # 归因与断言
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
const OUT = path.join(__dirname, `dom-writes-${PORT_TAG}.json`);

/** 页面侧劫持器（addInitScript，早于任何页面脚本执行） */
function instrument() {
  const PLUGIN_SELECTOR = '#app.st-converter-drawer-app, .st-converter-drawer-app, [id^="st-zip-converter"], [data-st-zip-injected="1"], .st-converter-drawer-wrapper';
  const MAX_PLUGIN_TOTAL = 4000; // 见下方分流说明
  const ops = [];          // 插件所为（全量）
  const hostSamples = [];  // 宿主所为（样本）
  let pluginOpsCount = 0;
  window.__domOps = ops;
  window.__domHostSamples = hostSamples;

  const sig = (el) => {
    if (!el) return null;
    if (el.nodeType === 3) return `#text(${String(el.data || '').slice(0, 40)})`;
    if (el.nodeType !== 1) return `nodeType${el.nodeType}`;
    const id = el.id ? `#${el.id}` : '';
    const cn = typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '';
    const cls = cn ? `.${cn.trim().split(/\s+/).join('.')}` : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`.slice(0, 160);
  };

  /** 单层节点的短名（**必须**对非元素节点做守卫：首轮就是这里对 DocumentFragment
   *  取 `.tagName.toLowerCase()` 抛错，打断 jQuery 的 IIFE，导致整页 `jQuery is not defined`） */
  const nameOf = (n) => {
    if (!n) return '?';
    if (n.nodeType === 9) return '#document';
    if (n.nodeType === 11) return '#fragment';
    if (n.nodeType === 3) return '#text';
    if (n.nodeType !== 1) return `nodeType${n.nodeType}`;
    if (n.id) return `#${n.id}`;
    const cn = typeof n.className === 'string' ? n.className : (n.className && n.className.baseVal) || '';
    return cn ? `.${cn.trim().split(/\s+/)[0]}` : n.tagName.toLowerCase();
  };

  const home = (el) => {
    const chain = [];
    let cur = el, n = 0;
    while (cur && cur !== document.body && n < 8) {
      chain.push(nameOf(cur));
      cur = cur.parentElement; n += 1;
    }
    return `${chain.reverse().join('<')}<body`;
  };

  const inPlugin = (el) => {
    try { return !!(el && el.closest && el.closest(PLUGIN_SELECTOR)); } catch { return false; }
  };

  /**
   * 采集器**绝不允许**向外抛错（仪器影响被测对象就等于没有测量）。
   *
   * 分流：宿主自身的写操作在加载期就有上万次，若共用同一个上限，**上限必然被宿主吃满、
   * 把插件的记录挤出窗口**（首轮 6000 条全是宿主、pluginOps=0 就是这么来的）。
   * 故插件所为的写操作**全量记录**，宿主只计数 + 留 `HOST_SAMPLE` 条样本。
   */
  const MAX_PLUGIN = 4000;
  const HOST_SAMPLE = 400;
  let hostOpCount = 0;
  window.__domHostOpCount = () => hostOpCount;

  const record = (op, target, detail, stack) => {
    try {
      const isPlugin = /st-zip-converter/i.test(stack);
      if (!isPlugin) {
        hostOpCount += 1;
        if (hostSamples.length >= HOST_SAMPLE) return;
      } else if (pluginOpsCount >= MAX_PLUGIN_TOTAL) return;
      const entry = {
        op,
        target: sig(target),
        targetHome: home(target),
        targetInPlugin: inPlugin(target),
        detail: detail || null,
        plugin: isPlugin,
        stack: String(stack || '').split('\n').slice(1, 6).join(' | ').slice(0, 600),
      };
      if (isPlugin) { pluginOpsCount += 1; ops.push(entry); } else { hostSamples.push(entry); }
    } catch { /* 采集失败不得影响页面 */ }
  };

  const stack = () => String(new Error('dom-write').stack || '');

  /**
   * `classList` 的 owner 解析。
   *
   * Chrome 的 `DOMTokenList` **不对外暴露** owner（既无 `ownerElement` 也无 `_element`），
   * 所以首轮 `classList.add/remove` 记录的 target 全是 `null`，那两条被误判成「写在宿主元素上」。
   *
   * 解法：重定义 `Element.prototype.classList` 的 getter，把「返回的 list 对象 → 元素」记进
   * WeakMap；之后在 `DOMTokenList.prototype` 的补丁里用 `ownerOf.get(this)` 反查即可。
   * **不返回 Proxy**——getter 依旧返回 Chrome 原本那个 list 实例，身份/遍历语义完全不变，
   * 这是刻意的：仪器一旦改变被测对象的行为，测出来的就不是真东西了。
   */
  const classListDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'classList');
  const ownerOf = new WeakMap();
  if (classListDesc && classListDesc.get) {
    Object.defineProperty(Element.prototype, 'classList', {
      configurable: true,
      get() {
        const list = classListDesc.get.call(this);
        try { ownerOf.set(list, this); } catch { /* ignore */ }
        return list;
      },
    });
  }

  const P = {
    appendChild: Node.prototype.appendChild,
    insertBefore: Node.prototype.insertBefore,
    removeChild: Node.prototype.removeChild,
    replaceChild: Node.prototype.replaceChild,
    setAttribute: Element.prototype.setAttribute,
    removeAttribute: Element.prototype.removeAttribute,
    remove: Element.prototype.remove,
  };

  Node.prototype.appendChild = function (child) {
    record('appendChild', this, sig(child), stack());
    return P.appendChild.call(this, child);
  };
  Node.prototype.insertBefore = function (child, ref) {
    record('insertBefore', this, `${sig(child)} before ${sig(ref)}`, stack());
    return P.insertBefore.call(this, child, ref);
  };
  Node.prototype.removeChild = function (child) {
    record('removeChild', this, sig(child), stack());
    return P.removeChild.call(this, child);
  };
  Node.prototype.replaceChild = function (next, old) {
    record('replaceChild', this, `${sig(next)} replaces ${sig(old)}`, stack());
    return P.replaceChild.call(this, next, old);
  };
  Element.prototype.setAttribute = function (name, value) {
    record('setAttribute', this, `${name}=${String(value).slice(0, 120)}`, stack());
    return P.setAttribute.call(this, name, value);
  };
  Element.prototype.removeAttribute = function (name) {
    record('removeAttribute', this, name, stack());
    return P.removeAttribute.call(this, name);
  };
  Element.prototype.remove = function () {
    record('el.remove', this, null, stack());
    return P.remove.call(this);
  };
  ['add', 'remove', 'toggle'].forEach((m) => {
    const orig = DOMTokenList.prototype[m];
    DOMTokenList.prototype[m] = function (...args) {
      try { record(`classList.${m}`, ownerOf.get(this) || null, String(args.join(' ')).slice(0, 120), stack()); } catch { /* ignore */ }
      return orig.apply(this, args);
    };
  });
}

const collect = async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, { ignoreHTTPSErrors: true, viewport: { width: 1600, height: 950 } });
  const consoleErrors = [];
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + String(e).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });

    await page.addInitScript(instrument);
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(20000);

    // 覆盖注入路径：打开账号弹层（触发 .userBackupButton 邻近注入）→ 关闭 → 点扩展菜单项（开抽屉）
    const exercised = await page.evaluate(() => {
      const out = {};
      const acct = document.getElementById('account_button');
      if (acct) { acct.click(); out.accountOpened = true; }
      return out;
    });
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      const close = document.querySelector('.popup-button-close, #dialogue_popup_ok, .popup_ok');
      if (close) close.click();
      const item = document.getElementById('st-zip-converter-menu-item');
      if (item) item.click();
    });
    await page.waitForTimeout(3000);

    const data = await page.evaluate(() => ({ ops: window.__domOps || [], hostSamples: window.__domHostSamples || [], hostOpCount: window.__domHostOpCount ? window.__domHostOpCount() : null }));
    fs.writeFileSync(OUT, JSON.stringify({
      sampledAt: new Date().toISOString(), url: BASE, exercised,
      pluginOps: data.ops.length, hostOpCount: data.hostOpCount, hostSamples: data.hostSamples.length,
      ops: data.ops, hostSampleList: data.hostSamples,
      consoleErrors: consoleErrors.slice(0, 30),
    }), 'utf8');
    console.log(JSON.stringify({
      file: OUT, pluginOps: data.ops.length,
      hostOpCount: data.hostOpCount, hostSamples: data.hostSamples.length,
      exercised, consoleErrors: consoleErrors.slice(0, 6),
    }, null, 1));
  } finally { await ctx.close(); }
};

/** 归因与断言 @param {string} [inputFile] 采集结果路径（默认本实例的真实采集） */
function analyze(inputFile = OUT) {
  const d = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const plugin = d.ops;                          // 已是「插件所为」全量
  const host = d.hostSampleList || [];           // 宿主所为，仅样本

  // 宿主锚点白名单：插件被允许写这些宿主元素（各注入点的落点）
  const ANCHORS = [
    '#extensions_settings2',              // 设置抽屉面板落点
    '#extensionsMenu<#options-content',   // 扩展菜单项落点（家谱形态）
    '#extensionsMenu',
    '.flex-container',                    // 账号弹层/管理面板：.userBackupButton 的父
    '.backupActionRow',                   // Luker 备份管理器动作行
  ];
  const onAnchor = (o) => ANCHORS.some((a) => (o.targetHome || '').includes(a));

  /**
   * 判定算子。
   *
   * **锚点只授予「插入自己的节点」的权利，不授予「改动锚点本身」的权利**——
   * 首版把 `classList.*` 打在锚点上的写法也算作合规（因为它只看「目标在不在锚点上」），
   * 这是个真漏洞：插件完全可以把宿主菜单项的 class 改掉还判为通过。
   * 现在按操作类型分开判：**插入类**才看锚点，**改动类/删除类**一律只认「目标是不是自己的节点」。
   */
  const isInsert = (o) => /^appendChild|^insertBefore/.test(o.op);
  const isMutating = (o) => /^setAttribute|^removeAttribute|^classList\./.test(o.op);
  const isRemoval = (o) => /^removeChild|^el\.remove|^replaceChild/.test(o.op);

  const selfWrites = plugin.filter((o) => o.targetInPlugin);
  const hostWrites = plugin.filter((o) => !o.targetInPlugin);

  const insertOnAnchor = hostWrites.filter((o) => isInsert(o) && onAnchor(o));
  const insertElsewhere = hostWrites.filter((o) => isInsert(o) && !onAnchor(o));
  const attrOnHost = hostWrites.filter(isMutating);          // 锚点不豁免
  const removeOnHost = hostWrites.filter(isRemoval);         // 锚点不豁免
  const otherHost = hostWrites.filter((o) => !isInsert(o) && !isMutating(o) && !isRemoval(o));

  const violations = [
    ...insertElsewhere.map((o) => ({ kind: '插入点不在白名单锚点', ...o })),
    ...attrOnHost.map((o) => ({ kind: '改动宿主既有节点的属性/class', ...o })),
    ...removeOnHost.map((o) => ({ kind: '删除/替换宿主既有节点', ...o })),
    ...otherHost.map((o) => ({ kind: '其他未归类宿主写入', ...o })),
  ];

  const group = (arr) => {
    const m = new Map();
    for (const o of arr) {
      const k = `${o.op} @ ${o.targetHome} → ${o.detail}`;
      if (!m.has(k)) m.set(k, { op: o.op, targetHome: o.targetHome, target: o.target, detail: o.detail, count: 0, stack: o.stack });
      m.get(k).count += 1;
    }
    return Array.from(m.values()).sort((a, b) => b.count - a.count);
  };

  const result = {
    url: d.url, sampledAt: d.sampledAt,
    totalOps: (d.pluginOps || 0) + (d.hostOpCount || 0), pluginOps: plugin.length, hostOps: d.hostOpCount, hostSampleCount: host.length,
    verdict: {
      pluginWritesIntoSelf: selfWrites.length,
      pluginWritesIntoHost: hostWrites.length,
      ofWhichInsertOnDeclaredAnchor: insertOnAnchor.length,
      violationsTotal: violations.length,
      v_insertOutsideAnchor: insertElsewhere.length,
      v_attrOrClassOnForeignNode: attrOnHost.length,
      v_removalOfForeignNode: removeOnHost.length,
      v_otherUnclassified: otherHost.length,
    },
    pluginSelfWrites: group(selfWrites).slice(0, 30),
    pluginHostWritesOnAnchor: group(insertOnAnchor).slice(0, 30),
    violations: group(violations).slice(0, 30),
  };
  // 裁决文件跟着**输入**命名：自检不得覆盖真实采集的裁决（首版固定写 `dom-writes-<port>-verdict.json`，
  // 结果自检把真实裁决冲掉了）
  const file = inputFile.replace(/\.json$/, '-verdict.json');
  fs.writeFileSync(file, JSON.stringify(result), 'utf8');
  console.log(JSON.stringify({
    file, url: result.url, pluginOps: result.pluginOps, hostOps: result.hostOps,
    verdict: result.verdict,
    violations: result.violations.slice(0, 5).map((v) => `${v.count}x ${v.op} @ ${v.targetHome} → ${v.detail}`),
  }, null, 1));
  return result;
}

/**
 * 自检：把**合成**的操作序列喂给同一套判定算子，确认三类违规都能被抓到。
 *
 * 存在的理由：只看真实读数报「0 违规」无法区分「没违规」和「判定失灵」。
 * 本自检不依赖浏览器，纯逻辑，可作为守卫的负例回归。
 */
function selftest() {
  const mk = (op, targetHome, targetInPlugin, detail) => ({ op, targetHome, targetInPlugin, target: null, detail, plugin: true, stack: '(selftest)' });
  const synthetic = [
    mk('appendChild', '#extensions_settings2', false, 'div#st-zip-converter-settings-panel'),  // 合法：锚点插入
    mk('appendChild', '<body', false, 'div#__probe'),                                            // 违规一：非锚点插入
    mk('classList.add', '#extensionsMenu', false, '__probe'),                                    // 违规二：改锚点本身的 class
    mk('setAttribute', '.flex-container', false, 'data-x=1'),                                    // 违规二（setAttribute 形态）
    mk('removeChild', '<body', false, 'div#some-host-node'),                                     // 违规三：删宿主节点
    mk('appendChild', '#app.st-converter-drawer-app', true, 'div'),                              // 合法：写自己家
  ];
  const dir = path.join(__dirname, 'selftest-input.json');
  fs.writeFileSync(dir, JSON.stringify({ url: '(selftest)', sampledAt: new Date().toISOString(), pluginOps: synthetic.length, hostOpCount: 0, hostSampleList: [], ops: synthetic }), 'utf8');
  // 走**同一个** analyze()，但输入换成合成数据 —— 不覆盖真实采集（曾差点把 dom-writes-8003.json 冲掉）
  const r = analyze(dir);
  const v = r.verdict;
  const expect = { v_insertOutsideAnchor: 1, v_attrOrClassOnForeignNode: 2, v_removalOfForeignNode: 1, violationsTotal: 4, pluginWritesIntoSelf: 1, ofWhichInsertOnDeclaredAnchor: 1 };
  const failures = Object.entries(expect).filter(([k, n]) => v[k] !== n).map(([k, n]) => `${k}: 期望 ${n} 实得 ${v[k]}`);
  console.log(JSON.stringify({ selftest: failures.length === 0 ? 'PASS' : 'FAIL', expected: expect, actual: v, failures }, null, 1));
  process.exitCode = failures.length === 0 ? 0 : 1;
}

// `--analyze` 只做归因，不再重跑采集（曾因 IIFE 无条件执行而把两份 JSON 串在一起输出）
if (process.argv.includes('--analyze')) analyze();
else if (process.argv.includes('--selftest')) selftest();
else collect();