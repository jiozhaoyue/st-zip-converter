/**
 * 「独立态样式是否落到宿主页面」探针（Dev Luker 8003 认证态，只读）
 *
 * 背景：`style.css` 的独立态骨架用 `body:has(> .app-container)` 给 **body** 上背景
 * （含 radial/linear-gradient）。该选择器**含** `.app-container` 字样，因此能通过
 * `check:css-scope` 的「含双前缀」检查，却在语义上以 **body** 为主体——若宿主页面的 body
 * 下出现 `.app-container` 直接子元素（别的扩展/应用注入的容器），本插件的独立态样式
 * 就会落到宿主 body 上（渐变背景、字体、行高等），表现为「强行改变酒馆样式」。
 *
 * 本探针回答：当前宿主页面里 `body:has(> .app-container)` **是否命中**、命中的是谁、
 * body 的计算背景是什么、以及 `.app-container` 在宿主里出现在哪。
 *
 * 用法：node pw-scope-hit-probe.cjs
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
const PROFILE = path.resolve(__dirname, '../../../../.pw-profile-dev');
const OUT = path.join(__dirname, 'scope-hit.json');

async function main() {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 950 },
  });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(3500);

    const result = await page.evaluate(() => {
      const out = {};
      out.bodyHasAppContainer = document.body.matches('body:has(> .app-container)');
      out.appContainerCount = document.querySelectorAll('.app-container').length;
      out.appContainerDetail = Array.from(document.querySelectorAll('.app-container')).slice(0, 6).map((el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        cls: String(el.className).slice(0, 80),
        parentIsBody: el.parentElement === document.body,
        parent: el.parentElement ? `${el.parentElement.tagName.toLowerCase()}${el.parentElement.id ? '#' + el.parentElement.id : ''}` : null,
      }));
      const cs = getComputedStyle(document.body);
      out.bodyBackgroundImage = cs.backgroundImage;
      out.bodyBackgroundColor = cs.backgroundColor;
      out.bodyFontFamily = cs.fontFamily;
      out.ourCssPresent = Array.from(document.styleSheets).some((s) => String(s.href || '').includes('st-zip-converter'));
      // 哪个样式表的哪条规则给了 body 背景？
      const hits = [];
      for (const sheet of Array.from(document.styleSheets)) {
        let rules = null;
        try { rules = sheet.cssRules; } catch { continue; }
        for (const r of Array.from(rules)) {
          const sel = r.selectorText;
          if (!sel || !r.style) continue;
          if (!/^(body|html|:root)\b/.test(sel.trim())) continue;
          if (!r.style.background && !r.style.backgroundImage && !r.style.backgroundColor) continue;
          let matches = false;
          try { matches = document.body.matches(sel) || document.documentElement.matches(sel); } catch { matches = false; }
          hits.push({ sheet: sheet.href || '(inline)', selector: sel.slice(0, 120), matches, bgImage: (r.style.backgroundImage || '').slice(0, 90) });
        }
      }
      out.bodyLevelRules = hits;
      return out;
    });

    fs.writeFileSync(OUT, JSON.stringify({ sampledAt: new Date().toISOString(), base: BASE, result }, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 1).slice(0, 3000));
  } finally {
    await ctx.close();
  }
}

main().catch((e) => { console.error('探针失败:', e); process.exit(1); });
