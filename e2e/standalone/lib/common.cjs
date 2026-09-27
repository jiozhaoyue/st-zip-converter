/**
 * 独立形态 spec 的公共辅助 —— 三个 spec 共用，避免第 N 份拷贝
 *
 * 纪律（都是踩过的坑，改这里前先读）：
 *  - 一切等待**有界**（`L1-MR-7`）；
 *  - 计划阶段的读数取**类目卡片**（`.category-card[data-category] .cat-badge`），
 *    **不是** `#report-panel` 的 `#count-*`（那是转换后报告，初始 `hidden`）；
 *  - 填数字输入框一律**回读校验**（`page.fill` 会静默不写入）；
 *  - 任何「相等/不小于」断言前先要一条**非空读数**的前置门（否则两侧同为 0 时恒真）。
 *
 * @module e2e/standalone/lib/common
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** 本仓 zipIo（Node 侧解包产物用） */
async function loadZipIo() {
  const mod = await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'core', 'zip-io.js')).href);
  return mod.zipIo;
}

/** 生成夹具（`fixtures/gen.js` 的 `generateAll`；进程内缓存） */
let fixturesPromise = null;
function ensureFixtures(fixtureDir) {
  if (!fixturesPromise) {
    const genUrl = pathToFileURL(path.join(REPO_ROOT, 'fixtures', 'gen.js')).href;
    fixturesPromise = import(genUrl).then((m) => m.generateAll(fixtureDir));
  }
  return fixturesPromise;
}

/** 等计划摘要条出现且文本非空 */
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

/** 读一个类目卡片：计数（`.cat-badge` 形如 `1 项 · 20 B`）与勾选状态 */
async function readCategory(page, key) {
  return page.evaluate((catKey) => {
    const card = document.querySelector(`.category-card[data-category="${catKey}"]`);
    if (!card) return { present: false, count: null, checked: null, badge: '' };
    const badge = card.querySelector('.cat-badge');
    const box = card.querySelector('input[type="checkbox"]');
    const text = badge ? badge.textContent.trim() : '';
    const m = text.match(/(\d+)/);
    return {
      present: true,
      count: m ? Number(m[1]) : null,
      checked: box ? Boolean(box.checked) : null,
      badge: text,
    };
  }, key);
}

/** 读转换后报告的计数（`#count-*`） */
async function readReportCount(page, id) {
  return page.evaluate((elId) => {
    const el = document.getElementById(elId);
    if (!el) return null;
    const n = Number(String(el.textContent).replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }, id);
}

/** 等导出区出现至少 n 行 */
async function waitForQueue(page, n = 1, timeout = 120_000) {
  try {
    await page.waitForFunction((want) => document.querySelectorAll('.eq-name').length >= want,
      n, { timeout });
    return await page.$$eval('.eq-name', (els) => els.map((e) => e.textContent.trim()));
  } catch { return null; }
}

/**
 * 读插件日志面板的全文（**先展开再读**）。
 *
 * ⚠️ **必须展开**：`src/ui/log-console.js` 在面板折叠时直接 return，**不往
 * `#log-stream-container` 追加任何行**，于是折叠态读到的是初始占位符
 * （实测把它误判成「续传没有跳过条目」的**假红**，而真实日志一条不少）。
 * 展开本身就是真实用户动作，故这里点一下 `#btn-toggle-log`。
 */
async function readLogText(page) {
  await page.evaluate(() => {
    const body = document.getElementById('log-console-body');
    if (body && getComputedStyle(body).display === 'none') {
      const btn = document.getElementById('btn-toggle-log');
      if (btn) btn.click();
    }
  });
  await page.waitForTimeout(300);
  return page.evaluate(() => {
    const el = document.getElementById('log-stream-container');
    return el ? el.textContent : '';
  });
}

/** 数字输入框填值并**回读校验**，失败退回程序化赋值 */
async function fillNumber(page, selector, value) {
  const want = String(value);
  const readValue = () => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.value : null;
  }, selector);
  await page.fill(selector, want).catch(() => {});
  for (let i = 0; i < 6; i += 1) {
    if ((await readValue()) === want) return 'fill';
    await page.waitForTimeout(150);
  }
  await page.evaluate(({ sel, v }) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, { sel: selector, v: want });
  return (await readValue()) === want ? 'evaluate' : 'failed';
}

/** 点第一行的下载按钮并落盘，返回保存路径 */
async function downloadFirstRow(page, dir, fileName) {
  return downloadNthRow(page, 0, dir, fileName);
}

/**
 * 点导出区**第 n 行**（0 起）的下载按钮并落盘。
 *
 * 连续做多次转换时**必须**指定行号：待导出区是累积的，永远点第一行会反复拿到同一份产物
 * （这属于「读数与目标不是同一个东西」，本仓已有同类坑）。
 * @param {number} n 行下标（0 = 第一行）
 */
async function downloadNthRow(page, n, dir, fileName) {
  const target = path.join(dir, fileName);
  const rows = page.locator('.btn-archive-action.download');
  const dl = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    rows.nth(n).click(),
  ]).then(([d]) => d);
  await dl.saveAs(target);
  return target;
}

/**
 * 用本仓 zipIo 把 zip 读成 `{ names, contents, methods }`
 * （contents: Map<名, Buffer>；methods: Map<名, 压缩方法号> —— 0 = Store, 8 = Deflate）
 *
 * `methods` 是**确定性**判据的来源：想验「已压缩扩展名走了 Store 直存」时，
 * 比对耗时是不可靠的（机器噪声），比对压缩方法号才是判据。
 */
async function readZip(zipPath) {
  const zipIo = await loadZipIo();
  const reader = await zipIo.openReader(zipPath);
  const names = [];
  const contents = new Map();
  const methods = new Map();
  try {
    for await (const e of reader.entries()) {
      names.push(e.fileName);
      contents.set(e.fileName, Buffer.from(await e.read()));
      methods.set(e.fileName, e.compressionMethod);
    }
  } finally {
    await reader.close();
  }
  return { names, contents, methods };
}

/** 现场造一个有确定内容的 zip（夹具不够用时用） */
async function buildZip(outPath, entries) {
  const zipIo = await loadZipIo();
  const writer = await zipIo.createWriter(outPath);
  for (const [name, data] of entries) await writer.add(name, data);
  await writer.close();
  return outPath;
}

module.exports = {
  REPO_ROOT,
  loadZipIo,
  ensureFixtures,
  waitForPlan,
  readCategory,
  readReportCount,
  waitForQueue,
  fillNumber,
  readLogText,
  downloadFirstRow,
  downloadNthRow,
  readZip,
  buildZip,
  exists: fs.existsSync,
};
