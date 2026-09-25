/**
 * 恢复 payload 变量对照（Dev Luker 8003，认证态）——定位「restoredCount=0」的真因并给结论。
 *
 * 三种打法，同一**合成小包**（仅含 worlds/zz-probe-a.json，无真实数据）：
 *   A. 走插件模块 restoreToHost（当前代码：带 selection 全类目）
 *   B. 直接 fetch，**不带** selection
 *   C. 直接 fetch，**带** selection 全类目
 * 判读：比对三者 restoredCount/skippedCount，确定 selection 是否为必需字段，
 * 以及插件路径是否真的写入了条目。
 *
 * 用法：node pw-restore-variants.cjs
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

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
const OUT = path.join(__dirname, 'dev-restore-variants.json');
const B64 = fs.readFileSync(path.join(os.tmpdir(), 'stzc-probe', 'probe-a.b64'), 'utf8').trim();

async function main() {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 950 },
  });
  const calls = [];
  const report = { sampledAt: new Date().toISOString(), base: BASE, package: 'worlds/zz-probe-a.json（合成）' };
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    page.on('request', (r) => {
      if (/\/api\/users\/restore/.test(r.url())) calls.push(r.url());
    });
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(3000);

    const result = await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const zipBytes = bytes.slice(0);
      const mkBlob = () => new Blob([zipBytes], { type: 'application/zip' });

      const out = {};
      const summarize = (payload) => (payload && typeof payload === 'object'
        ? {
          status: payload.__status,
          restoredCount: payload.restoredCount,
          skippedCount: payload.skippedCount,
          failedCount: payload.failedCount,
          rejectedCount: payload.rejectedCount,
          mode: payload.mode,
          firstSkipped: (payload.preflight?.sampleSkippedEntries || [])[0]?.reason || null,
          error: payload.error || null,
        }
        : payload);

      // A. 插件模块（当前代码）
      try {
        const mod = await import('/scripts/extensions/third-party/st-zip-converter/src/ui/host-bridge.js');
        const res = await mod.restoreToHost(mkBlob(), { mode: 'merge', platform: 'luker' });
        out.viaPlugin = summarize(res);
      } catch (e) {
        out.viaPlugin = { error: String(e && e.message ? e.message : e) };
      }

      // 通用直连打法
      const direct = async (withSelection) => {
        const csrfRes = await fetch('/csrf-token', { credentials: 'same-origin' });
        const token = (await csrfRes.json()).token;
        const handle = (await (await fetch('/api/users/me', { credentials: 'same-origin' })).json()).handle;
        const fd = new FormData();
        fd.append('avatar', mkBlob(), 'backup.zip');
        fd.append('handle', handle);
        fd.append('mode', 'merge');
        fd.append('incremental', 'true');
        if (withSelection) {
          fd.append('selection', JSON.stringify({
            settings: true, secrets: true, characters: true, chats: true, lorebooks: true,
            presets: true, assets: true, extensions: true, globalExtensions: true, vectors: true,
          }));
        }
        const r = await fetch('/api/users/restore-backup', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'X-CSRF-Token': token },
          body: fd,
        });
        const body = await r.json().catch(() => ({}));
        body.__status = r.status;
        return body;
      };

      out.directNoSelection = summarize(await direct(false));
      out.directWithSelection = summarize(await direct(true));
      return out;
    }, B64);

    report.result = result;
    report.restoreCalls = calls;
  } catch (e) {
    report.fatal = String(e).slice(0, 300);
  } finally {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 1).slice(0, 2500));
    await ctx.close();
  }
}

main().catch((e) => { console.error('探针失败:', e); process.exit(1); });
