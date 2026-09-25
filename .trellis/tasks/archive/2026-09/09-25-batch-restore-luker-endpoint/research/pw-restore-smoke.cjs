/**
 * 恢复端点实机冒烟（Dev Luker 8003，认证态）——用**插件自己发布的模块**走真实宿主 HTTP。
 *
 * 目的（本任务 AC 关键项）：证明 R1 的端点解析在真实宿主上生效——
 *   ① 请求实际命中 `/api/users/restore-backup`（而非必然 404 的 `/api/users/restore`）；
 *   ② 宿主回 2xx 并给出 `restoredCount`；
 *   ③ 全程只用**合成小包**（仅含一个 lorebook，不含真实数据，不触碰 settings.json）。
 *
 * 用法：node pw-restore-smoke.cjs
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
const OUT = path.join(__dirname, 'dev-restore-smoke.json');
const B64 = fs.readFileSync(path.join(os.tmpdir(), 'stzc-probe', 'probe-a.b64'), 'utf8').trim();

async function main() {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 950 },
  });
  const restoreCalls = [];
  const report = { sampledAt: new Date().toISOString(), base: BASE };
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    page.on('request', (r) => {
      if (/\/api\/users\/restore/.test(r.url())) restoreCalls.push({ url: r.url(), method: r.method() });
    });
    page.on('response', async (r) => {
      if (/\/api\/users\/restore/.test(r.url())) {
        report.restoreResponse = { url: r.url(), status: r.status() };
      }
    });

    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(3000);

    const result = await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'application/zip' });

      const mod = await import('/scripts/extensions/third-party/st-zip-converter/src/ui/host-bridge.js');
      const out = { moduleLoaded: true };
      try {
        out.capabilityBefore = mod.getRestoreCapability();
        const res = await mod.restoreToHost(blob, { mode: 'merge', platform: 'luker' });
        out.restoreResult = res;
        out.capabilityAfter = mod.getRestoreCapability();
      } catch (err) {
        out.error = String(err && err.message ? err.message : err);
        out.errorCode = err && err.code ? err.code : null;
        out.capabilityAfter = mod.getRestoreCapability();
      }
      return out;
    }, B64);

    report.result = result;
    report.restoreCalls = restoreCalls;
  } catch (e) {
    report.fatal = String(e).slice(0, 300);
  } finally {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 1).slice(0, 2500));
    await ctx.close();
  }
}

main().catch((e) => { console.error('探针失败:', e); process.exit(1); });
