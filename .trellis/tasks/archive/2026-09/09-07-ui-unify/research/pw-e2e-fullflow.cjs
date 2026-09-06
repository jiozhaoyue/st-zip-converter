/**
 * ui-unify 全流程闭环：上传 → 转换 → 待导出区 → 下载 → 工作区列表来源徽标
 */
const { chromium } = require('C:/nvm4w/nodejs/node_modules/playwright');
const fs = require('fs');
const path = require('path');

async function makeTestZip() {
  // 生成一个最小合法 ST 布局 zip（characters + settings.json）
  const { zipIo } = await import('file:///D:/Repo/Tavern-repo/My-repo/ST-zip-converter/src/core/zip-io.js').catch(() => ({ zipIo: null }));
  // Node 侧直接用 vendor 生成
  const { execSync } = require('child_process');
  const tmp = path.join(process.cwd(), '.trellis', 'tasks', '09-07-ui-unify', 'research');
  const zipPath = path.join(tmp, 'e2e-sample-st.zip');
  if (fs.existsSync(zipPath)) return zipPath;
  execSync(`node -e "
    const { zipIo } = require('D:/Repo/Tavern-repo/My-repo/ST-zip-converter/src/core/zip-io.js');
  " --input-type=commonjs 2>/dev/null || true`);
  // 用独立的 ESM 脚本生成
  const genScript = path.join(tmp, 'gen-e2e-zip.mjs');
  fs.writeFileSync(genScript, `
import { writeFileSync } from 'node:fs';
import * as zip from 'D:/Repo/Tavern-repo/My-repo/ST-zip-converter/src/vendor/zip.js';
const writer = new zip.ZipWriter(new zip.Uint8ArrayWriter(), { level: 5 });
await writer.add('characters/seraphina.json', new zip.Uint8ArrayReader(new TextEncoder().encode(JSON.stringify({ name: 'Seraphina', description: 'test card', first_mes: 'hi' }))));
await writer.add('settings.json', new zip.Uint8ArrayReader(new TextEncoder().encode(JSON.stringify({ foo: 'bar' }))));
await writer.add('chats/seraphina/0001.jsonl', new zip.Uint8ArrayReader(new TextEncoder().encode(JSON.stringify({ name: 'User', mes: 'hello' }))));
const data = await writer.close();
writeFileSync(${JSON.stringify(zipPath).replace(/\\\\/g, '/')}, Buffer.from(data));
console.log('generated', data.length);
`);
  execSync(`node ${genScript}`, { stdio: 'inherit' });
  return zipPath;
}

(async () => {
  const zipPath = await makeTestZip();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('http://127.0.0.1:4519/', { waitUntil: 'load', timeout: 25000 });
  await page.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });

  // 1. 上传 zip
  await page.setInputFiles('#file-input', zipPath);
  await page.waitForTimeout(1500);

  const checks = {};
  checks.uploadDetected = await page.textContent('#drop-main-text').catch(() => '');

  // 2. 目标格式选 Luker (l)，点转换
  await page.selectOption('#target-select', 'l');
  await page.waitForTimeout(500);
  await page.waitForTimeout(300);
  await page.click('#btn-convert');
  // 等待转换完成（进度 100% 或待导出区出现条目）
  await page.waitForFunction(() => {
    const items = document.querySelectorAll('.export-queue-item');
    return items.length > 0;
  }, { timeout: 60000 });

  // 3. 待导出区条目出现
  checks.queueItemName = await page.textContent('.export-queue-item .eq-name').catch(() => null);
  checks.queueOriginBadge = await page.textContent('.export-queue-item .origin-badge').catch(() => null);

  // 4. 展开工作区抽屉 + 待导出区子抽屉
  await page.click('#workspace-panel-drawer .inline-drawer-toggle');
  await page.waitForTimeout(300);
  const eqDrawer = await page.$('#export-queue-drawer .inline-drawer-toggle');
  if (eqDrawer) {
    const contentVisible = await page.isVisible('.export-queue-item');
    if (!contentVisible) {
      await page.evaluate(() => document.querySelector('#export-queue-drawer .inline-drawer-toggle').click());
      await page.waitForTimeout(400);
      await page.waitForTimeout(300);
    }
  }
  checks.workspaceArchiveEmpty = await page.textContent('#workspace-archive-list .archive-empty').catch(() => null);

  // 5. 点"存工作区"
  await page.waitForSelector('.export-queue-item .btn-archive-action.load-source', { state: 'visible', timeout: 10000 });
  await page.click('.export-queue-item .btn-archive-action.load-source');
  await page.waitForTimeout(1000);

  // 6. 工作区列表出现来源徽标条目
  checks.workspaceItemName = await page.textContent('#workspace-archive-list .archive-card .archive-name').catch(() => null);
  checks.workspaceOriginBadge = await page.textContent('#workspace-archive-list .archive-card .origin-badge').catch(() => null);

  // 7. 筛选条出现
  checks.filterBarChips = await page.$$eval('.archive-filter-chip', (els) => els.map((e) => e.textContent.trim()));
  checks.usageChip = await page.textContent('.usage-origin-chip').catch(() => null);

  checks.jsErrors = errors;
  console.log(JSON.stringify(checks, null, 2));
  await page.screenshot({ path: 'D:/Repo/Tavern-repo/My-repo/ST-zip-converter/.trellis/tasks/09-07-ui-unify/research/e2e-fullflow.png', fullPage: true });
  await browser.close();
})();
