/**
 * Dev Luker（8003）可达性与登录门禁探针（只读）
 *
 * 背景：Dev 实例 config.yaml 为 `enableUserAccounts: true` + `whitelistMode: true`，
 * 匿名 curl 访问所有 /api/** 一律 403、`/` 302 跳 `/login`（Real 8004 无该门禁）。
 * 故 UI E2E 必须走「浏览器登录 → 会话 Cookie」路径，本脚本验证该路径是否可行，
 * 并顺带确认插件是否在 Dev 上装载成功。
 *
 * 只读约束：仅登录与页面采样，不点任何执行类按钮、不调写端点、不改实例数据。
 * 用法：node pw-dev-login-probe.cjs
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
const BASE = process.env.DEV_URL || 'https://127.0.0.1:8003';
const PROJECT_ROOT = path.resolve(__dirname, '../../../..');
// 与 8004 探针分开的 profile，避免跨源 Cookie 混淆
const PROFILE_DIR = path.join(PROJECT_ROOT, '.pw-profile-dev');
const OUT = path.join(__dirname, 'dev-login-probe.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 950 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  console.log('[0] 打开', BASE);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(2500);

  const landing = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    hasLoginForm: !!document.querySelector('form, input[type=password], #login, .login'),
    inputs: Array.from(document.querySelectorAll('input')).slice(0, 10).map((i) => ({
      type: i.type, id: i.id, name: i.name, placeholder: i.placeholder || null,
    })),
    buttons: Array.from(document.querySelectorAll('button, .menu_button'))
      .slice(0, 12)
      .map((b) => ({ id: b.id, text: (b.textContent || '').trim().slice(0, 24) })),
  }));
  console.log('[1] 落地页:', JSON.stringify(landing, null, 1));

  // ── 尝试无密码登录 default-user ──
  let loginAttempt = null;
  if (landing.url.includes('/login')) {
    loginAttempt = await (async () => {
      // 填 handle（选择器按常见形态逐个试探）
      const filled = await page.evaluate(() => {
        const cands = ['#handle', 'input[name="handle"]', '#login_handle', 'input[type="text"]'];
        for (const sel of cands) {
          const el = document.querySelector(sel);
          if (el) {
            el.value = 'default-user';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return sel;
          }
        }
        return null;
      });
      const pwdFilled = await page.evaluate(() => {
        const el = document.querySelector('input[type="password"]');
        if (el) {
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
        return false;
      });
      // 提交
      const submitted = await page.evaluate(() => {
        const btn = document.querySelector('#login_button, button[type="submit"], .login-button');
        if (btn) { btn.click(); return btn.id || btn.className; }
        const form = document.querySelector('form');
        if (form) { form.requestSubmit?.(); return 'form.requestSubmit'; }
        return null;
      });
      await sleep(4000);
      return {
        filledHandleVia: filled,
        hadPasswordField: pwdFilled,
        submittedVia: submitted,
        urlAfter: page.url(),
      };
    })();
    console.log('[2] 登录尝试:', JSON.stringify(loginAttempt));
  }

  // ── 登录后状态：接口可达性与插件装载 ──
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
  await sleep(8000);

  const after = await page.evaluate(async () => {
    const api = await fetch('/api/users/me', { credentials: 'include' })
      .then((r) => ({ status: r.status }))
      .catch((e) => ({ status: 'ERR', err: String(e).slice(0, 80) }));
    return {
      url: location.href,
      apiUsersMe: api,
      hasMainUi: !!document.querySelector('#chat, #extensions_settings2, #send_textarea'),
      // 插件装载证据
      hasExtensionsBlock: !!document.getElementById('rm_extensions_block'),
      hasPluginSettings: !!document.getElementById('st_zip_converter_settings'),
      hasDrawerApp: !!document.querySelector('.st-converter-drawer-app'),
      hasMenuInjection: !!document.getElementById('st-zip-converter-menu-item'),
      injectedNodes: document.querySelectorAll('[data-st-zip-injected="1"]').length,
    };
  });
  console.log('[3] 登录后:', JSON.stringify(after, null, 1));

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });

  const result = {
    sampledAt: new Date().toISOString(),
    url: BASE,
    landing,
    loginAttempt,
    after,
    consoleErrors,
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  console.log('\n===== 结论 =====');
  console.log('登录门禁:', landing.url.includes('/login') ? '存在' : '无');
  console.log('登录后 API /api/users/me:', JSON.stringify(after.apiUsersMe));
  console.log('主 UI 可用:', after.hasMainUi, '| 插件设置块:', after.hasPluginSettings, '| 抽屉 app:', after.hasDrawerApp);
  console.log('注入节点:', after.injectedNodes);
  console.log('落盘:', OUT);

  await ctx.close();
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
