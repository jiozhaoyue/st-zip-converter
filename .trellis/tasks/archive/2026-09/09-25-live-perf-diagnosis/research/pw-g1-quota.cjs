/**
 * 阶段 G · 配额数据核对（只读）
 *
 * 用户指出：「浏览器配额和用户配额都显示数据不对，从后端来讲就是完全错的」。
 * 本脚本取三方对照：
 *   ① 插件 UI 上实际渲染的文本
 *   ② navigator.storage.estimate() 原始返回
 *   ③ POST /api/users/storage/inspect 原始响应（只读查询语义，非写入）
 *   ④ navigator.storage.estimate 的分项（若浏览器支持 getDirectory/IndexedDB 统计）
 *
 * 只读约束：仅 GET + storage/inspect 查询；不调写端点。
 * 用法：node pw-g1-quota.cjs
 */
const path = require('path');
const fs = require('fs');

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    const globalRoot = require('child_process').execSync('npm root -g').toString().trim();
    return require(path.join(globalRoot, 'playwright'));
  }
}

const { chromium } = loadPlaywright();
const BASE = process.env.LUKER_URL || 'https://127.0.0.1:8004';
const PROJECT_ROOT = path.resolve(__dirname, '../../../..');
const PROFILE_DIR = path.join(PROJECT_ROOT, '.pw-profile');
const OUT = path.join(__dirname, 'g1-quota.json');

async function main() {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 950 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  console.log('[G] 打开', BASE);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => document.querySelector('#extensions_settings2, #chat'), { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(10_000);

  // 打开面板以便读到渲染后的配额条
  await page.evaluate(() => {
    const block = document.getElementById('rm_extensions_block');
    if (block) {
      block.classList.remove('closedDrawer');
      block.style.display = 'block';
    }
    const content = document.querySelector('#st_zip_converter_settings > .inline-drawer-content');
    if (content) content.style.display = 'block';
  });
  await page.waitForTimeout(3000);

  const uiText = await page.evaluate(() => {
    const dash = document.getElementById('usage-dashboard');
    if (!dash) return { found: false };
    const sections = Array.from(dash.querySelectorAll('.usage-quota-section')).map((s) => ({
      raw: (s.textContent || '').replace(/\s+/g, ' ').trim(),
      barWidth: (s.querySelector('.usage-quota-fill')?.style.width) || null,
    }));
    return { found: true, sections };
  });

  const estimate = await page.evaluate(async () => {
    try {
      const e = await navigator.storage.estimate();
      return { usage: e.usage, quota: e.quota, usageDetails: e.usageDetails || null };
    } catch (err) {
      return { error: String(err) };
    }
  });

  // 后端原始响应（只读查询）
  const inspect = await page.evaluate(async () => {
    try {
      const token = (await (await fetch('/csrf-token', { credentials: 'same-origin' })).json()).token;
      const resp = await fetch('/api/users/storage/inspect', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({ path: [] }),
      });
      return { status: resp.status, body: await resp.json() };
    } catch (err) {
      return { error: String(err) };
    }
  });

  // 用同一 token 查用户目录各子项（若端点支持 path 递归）
  const inspectSub = await page.evaluate(async () => {
    const results = {};
    try {
      const token = (await (await fetch('/csrf-token', { credentials: 'same-origin' })).json()).token;
      for (const p of [['chats'], ['characters'], ['extensions'], ['backups'], ['settings.json']]) {
        try {
          const resp = await fetch('/api/users/storage/inspect', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            body: JSON.stringify({ path: p }),
          });
          results[p.join('/')] = { status: resp.status, body: await resp.json() };
        } catch (e) {
          results[p.join('/')] = { error: String(e) };
        }
      }
    } catch (e) {
      return { error: String(e) };
    }
    return results;
  });

  const result = { sampledAt: new Date().toISOString(), url: BASE, uiText, estimate, inspect, inspectSub };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');

  const fmt = (b) => (b == null ? String(b) : `${(b / 1024 / 1024 / 1024).toFixed(3)} GB (${b} B)`);

  console.log('\n===== 配额三方对照 =====');
  console.log('[① 插件 UI 实际渲染]');
  if (uiText.found) uiText.sections.forEach((s, i) => console.log(`  行${i + 1}: ${s.raw}  [bar=${s.barWidth}]`));
  else console.log('  未找到 #usage-dashboard');
  console.log('\n[② navigator.storage.estimate()]');
  console.log('  usage =', fmt(estimate.usage));
  console.log('  quota =', fmt(estimate.quota));
  console.log('  usageDetails =', JSON.stringify(estimate.usageDetails));
  console.log('\n[③ 后端 /api/users/storage/inspect]');
  console.log('  status =', inspect.status);
  console.log('  body   =', JSON.stringify(inspect.body));
  console.log('\n[④ 后端分项 path 探测]');
  for (const [k, v] of Object.entries(inspectSub || {})) {
    console.log(`  ${k}: status=${v.status} body=${JSON.stringify(v.body)}`);
  }
  console.log('\n落盘:', OUT);

  await ctx.close();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
