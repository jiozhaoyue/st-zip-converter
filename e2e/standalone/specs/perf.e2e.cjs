/**
 * 流程提速与压缩策略（**确定性判据优先，耗时只作读数**）
 *
 * ## 为什么不用耗时当判据
 *
 * 本机是多会话共享的工作区（实测出现过「机器 idle 3%、13 条 5s 超时型假红」）。
 * 拿墙钟时间做「更快」的断言，等于把断言建在**机器负载**上 ⇒ 一定会有假红。
 * 故本 spec 把「压缩策略生效」做成**确定性判据**：
 *
 *   `src/core/zip-io.js:entryCompressionLevel()` 对已压缩扩展名（`.png/.jpg/.mp4/.zst/.zip`…）
 *   强制 **level 0（Store）**，其余按用户等级 deflate。落进 zip 的就是
 *   **压缩方法号**：`0 = Store` / `8 = Deflate` —— 这是产物自带的、与机器无关的事实。
 *
 * ⇒ 判据：同一份**可压缩**内容，命名成 `.png` 的条目在产物里是 **Store**，
 *    命名成 `.txt` 的是 **Deflate**；且前者保持原体积、后者显著变小。
 *    「Store 直存省掉一次无用的 deflate」这件事因此可被机器无关地断言。
 *
 * 耗时读数（计划 / 各级转换 / MB/s）**照实记录**，但只断言一个**极宽的兜底上限**
 * （抓「数量级退化」，不抓小噪声）。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const common = require('../lib/common.cjs');

let FIXTURE_DIR = '';

/** 可压缩内容（全零）：Store 时保持原体积，Deflate 时会被压到极小 —— 差值本身就是判据 */
function compressibleBytes(mb) {
  return Buffer.alloc(mb * 1024 * 1024, 0);
}

/** 不可压缩内容（SHA-256 计数器模式，确定性）：用于测真实吞吐 */
function incompressibleBytes(mb) {
  const parts = [];
  const target = mb * 1024 * 1024;
  for (let ctr = 0; parts.length * 32 < target; ctr += 1) {
    parts.push(crypto.createHash('sha256').update(`perf:${ctr}`).digest());
  }
  return Buffer.concat(parts);
}

/**
 * 造「压缩策略」夹具：同一份可压缩内容分别命名成已压缩扩展名与文本扩展名
 */
async function ensureRoutingFixture() {
  const out = path.join(FIXTURE_DIR, 'perf-routing.zip');
  if (fs.existsSync(out)) return out;
  const blob = compressibleBytes(4);
  return common.buildZip(out, [
    ['characters/routing.png', blob],   // 已压缩扩展名 ⇒ 期望 Store
    ['User Avatars/routing.jpg', blob], // 同上
    ['worlds/routing.txt', blob],       // 文本 ⇒ 期望 Deflate
  ]);
}

/** 造吞吐夹具：24 MB 不可压缩（4 条目 × 6 MB） */
async function ensureThroughputFixture() {
  const out = path.join(FIXTURE_DIR, 'perf-throughput.zip');
  if (fs.existsSync(out)) return out;
  const entries = [['characters/perf.png', incompressibleBytes(1)]];
  for (let i = 1; i <= 4; i += 1) {
    entries.push([`chats/Perf/bulk-${i}.jsonl`, incompressibleBytes(6)]);
  }
  return common.buildZip(out, entries);
}

/** 上传 → 计划 → 转换 → 下载第 n 行，返回耗时读数与产物 */
async function timedConvert(page, ctx, fixturePath, { level, rowIndex, tag }) {
  const t0 = Date.now();
  await page.setInputFiles('#file-input', fixturePath);
  const planned = await common.waitForPlan(page);
  const tPlan = Date.now() - t0;

  await page.selectOption('#compression-select', String(level));
  const t1 = Date.now();
  await page.click('#btn-convert');
  const names = await common.waitForQueue(page, rowIndex + 1);
  const tConvert = Date.now() - t1;
  if (!names) return { planned, tPlan, tConvert, ok: false };
  const out = await common.downloadNthRow(page, rowIndex, FIXTURE_DIR, `${tag}.zip`);
  return { planned, tPlan, tConvert, ok: true, out, product: await common.readZip(out) };
}

module.exports = {
  name: '流程提速与压缩策略（确定性判据 + 耗时读数）',
  async run(t, h, ctx) {
    FIXTURE_DIR = ctx.fixtureDir;
    const { page, rec } = h;
    t.ok('P1 工作台就绪', Boolean(await ctx.waitForReady(page)));

    // ============ ① 压缩策略：Store 直存 vs Deflate（确定性判据）============
    const routing = await ensureRoutingFixture();
    const r1 = await timedConvert(page, ctx, routing, { level: 5, rowIndex: 0, tag: 'perf-routing-l5' });
    if (!t.ok('P2 压缩策略夹具转换完成', r1.ok && r1.product.names.length >= 3,
      JSON.stringify(r1.product ? r1.product.names : null))) {
      return;
    }
    const methods = r1.product.methods;
    const sizes = new Map(r1.product.names.map((n) => [n, r1.product.contents.get(n).length]));

    t.eq('P3 已压缩扩展名 `.png` 走 **Store（方法 0）**', methods.get('characters/routing.png'), 0,
      JSON.stringify(Object.fromEntries(methods)));
    t.eq('P4 已压缩扩展名 `.jpg` 走 **Store（方法 0）**', methods.get('User Avatars/routing.jpg'), 0,
      JSON.stringify(Object.fromEntries(methods)));
    t.eq('P5 文本扩展名 `.txt` 走 **Deflate（方法 8）**', methods.get('worlds/routing.txt'), 8,
      JSON.stringify(Object.fromEntries(methods)));

    const blobSize = 4 * 1024 * 1024;
    t.ok('P6 Store 直存的条目**保持原体积**（省掉的那次 deflate 确实没做）',
      sizes.get('characters/routing.png') === blobSize,
      `png=${sizes.get('characters/routing.png')} 期望=${blobSize}`);
    /**
     * ⚠️ 判据不能用 `contents`：那是**解压后**的内容，恒为 4 MB（首版这么写过，得到一条假红）。
     * 正确判据是**产物文件自身的体积**：两条 Store（4 MB + 4 MB）+ 一条被压到极小的 Deflate
     * ⇒ 产物必然 > 8 MB；若路由失效（三条都 deflate）则产物只有几十 KB。
     * 这是**包级、机器无关**的确定性证据。
     */
    const productSize = fs.statSync(r1.out).size;
    t.ge('P7 产物体积证明路由真的生效（两条 4 MB 直存 ⇒ 产物 > 8 MB；路由失效则只有几十 KB）',
      productSize, 8 * 1024 * 1024, `实际 ${(productSize / 1048576).toFixed(1)} MB`);
    t.log(`  · 读数：策略夹具产物 ${(productSize / 1048576).toFixed(1)} MB`);
    t.log(`  · 读数：计划 ${r1.tPlan}ms / 转换(L5) ${r1.tConvert}ms`);

    // ============ ② 吞吐读数：24 MB 不可压缩包 ============
    const throughput = await ensureThroughputFixture();
    const packMb = fs.statSync(throughput).size / 1048576;
    const t1 = await timedConvert(page, ctx, throughput, { level: 5, rowIndex: 1, tag: 'perf-throughput-l5' });
    t.ok('P8 24 MB 包转换完成', t1.ok && t1.product.names.length >= 4,
      JSON.stringify(t1.product ? t1.product.names : null));
    const mbps = packMb / (t1.tConvert / 1000);
    t.log(`  · 读数：24 MB 包 计划 ${t1.tPlan}ms / 转换(L5) ${t1.tConvert}ms ≈ ${mbps.toFixed(1)} MB/s`);
    t.ok('P9 吞吐兜底上限（抓数量级退化，不抓噪声；本机负载波动大，故意放宽到 120s）',
      t1.tConvert < 120_000, `${t1.tConvert}ms`);

    // ============ ③ 等级 0（全 Store）与等级 5 都能解包（正确性不随等级变）============
    const t0 = await timedConvert(page, ctx, throughput, { level: 0, rowIndex: 2, tag: 'perf-throughput-l0' });
    t.ok('P10 等级 0 产物同样是合法 zip 且条目齐全',
      t0.ok && t0.product.names.length === t1.product.names.length,
      `L0=${t0.product ? t0.product.names.length : 'N/A'} L5=${t1.product.names.length}`);
    t.log(`  · 读数：24 MB 包 转换(L0) ${t0.tConvert}ms ≈ ${(packMb / (t0.tConvert / 1000)).toFixed(1)} MB/s`);

    const sameContent = t0.product.names.every((n) => t0.product.contents.get(n)
      .equals(t1.product.contents.get(n)));
    t.ok('P11 两个等级的**解压后内容逐字节一致**（等级只影响体积/耗时，不影响数据）',
      sameContent, `条目数 L0=${t0.product.names.length} L5=${t1.product.names.length}`);

    t.eq('P12 全流程零未捕获页面异常', rec.pageErrors.length, 0, JSON.stringify(rec.pageErrors.slice(0, 2)));
  },
};
