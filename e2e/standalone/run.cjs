#!/usr/bin/env node
/**
 * 独立 Web 形态（含**云部署形态**）E2E 运行器
 *
 * 与 `e2e/run.cjs` 的关系：**互不干扰**。那个跑的是「宿主实例上的插件」，
 * 只扫 `e2e/specs/*.e2e.cjs`；本运行器跑的是「**自己就是站点本身**」的独立形态，
 * 并且**不需要任何实例在跑**。
 *
 * 为什么要单开一套（而不是往 `e2e/specs/` 里加文件）：
 *  1. 独立形态**没有宿主**，端口守卫（Dev/Real 白名单）在这里没有意义——那是实例侧的红线；
 *  2. 它需要**构建产物 + 静态服务器**，而起一个实例是被测对象的宿主，完全不同的前置；
 *  3. 云酒馆的真实形态是**子路径静态托管**（GitHub Pages 项目页），这只有自己起服务器才验得了。
 *
 * **两个挂载点**（同一端口、同一台服务器）：
 *  - `/st-zip-converter/` → `dist/`（构建产物）⇒ `specs/` 下的用例；
 *  - `/src-tree/` → 仓库源码树（未打包的 ESM）⇒ `specs-src/` 下的用例，
 *    它们能在真实浏览器里直接 `import` 真实模块（真 Blob / 真 Worker 路径），
 *    而不必为了这点验证去拉一遍实例的 1.5 GB 数据。
 *
 * 用法：
 *   node e2e/standalone/run.cjs                     # 需要时自动构建 → 跑全部
 *   node e2e/standalone/run.cjs --only workbench    # 只跑名字含 workbench 的
 *   node e2e/standalone/run.cjs --prefix /           # 挂根路径（对照子路径形态）
 *   node e2e/standalone/run.cjs --no-build           # 用现有 dist（会做新鲜度告警）
 *   node e2e/standalone/run.cjs --rebuild            # 强制重建（mtime 判据看不见「删了源码文件」）
 *
 * 纪律：端口显式登记（默认 4173，L0-16），被占用即报错退出，**不自动换端口**。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { startStaticServer, DEFAULT_PORT } = require('./lib/static-server.cjs');
const { openSite, waitForReady } = require('./lib/harness.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(REPO_ROOT, 'dist');
const SPEC_DIR = path.join(__dirname, 'specs');
const SPEC_SRC_DIR = path.join(__dirname, 'specs-src');
const FIXTURE_DIR = path.join(REPO_ROOT, 'test-results', 'fixtures-web');

/** 源码树挂载前缀（独立于站点前缀：站点前缀是「云部署形态」的实验变量） */
const SRC_PREFIX = '/src-tree/';

function parseArgs(argv) {
  const out = { only: '', prefix: '/st-zip-converter/', port: DEFAULT_PORT, build: true, rebuild: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--only') out.only = argv[++i] || '';
    else if (argv[i] === '--prefix') out.prefix = argv[++i] || '/';
    else if (argv[i] === '--port') out.port = Number(argv[++i]) || DEFAULT_PORT;
    else if (argv[i] === '--no-build') out.build = false;
    else if (argv[i] === '--rebuild') out.rebuild = true;
  }
  return out;
}

const state = { total: 0, passed: 0, failed: 0, failures: [], perSpec: [] };
/** 当前 spec 名（`ok()` 用它记账，产出结尾的**分项汇总** —— 读数不必再从输出里手抄） */
let currentSpec = '';
function specTally() {
  if (!currentSpec) return null;
  let t = state.perSpec.find((x) => x.name === currentSpec);
  if (!t) { t = { name: currentSpec, total: 0, passed: 0, failed: 0 }; state.perSpec.push(t); }
  return t;
}
const log = (m) => process.stdout.write(`${m}\n`);

function ok(label, cond, extra = '') {
  state.total += 1;
  const tally = specTally();
  if (tally) tally.total += 1;
  const suffix = extra ? ` — ${extra}` : '';
  if (cond) {
    state.passed += 1;
    if (tally) tally.passed += 1;
    log(`  [OK]   ${label}${suffix}`);
  } else {
    state.failed += 1;
    if (tally) tally.failed += 1;
    state.failures.push(label);
    log(`  [FAIL] ${label}${suffix}`);
  }
  return Boolean(cond);
}

function makeT() {
  return {
    ok,
    eq: (label, actual, expected) => ok(label, actual === expected,
      `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`),
    ge: (label, actual, min) => ok(label, Number(actual) >= min, `actual=${actual} 应 >= ${min}`),
    log,
  };
}

/** 源文件里最新的 mtime（用于「dist 是否过期」的判据） */
function newestSourceMtime() {
  const roots = ['index.js', 'index.html', 'style.css', 'package.json', 'vite.config.js']
    .map((f) => path.join(REPO_ROOT, f));
  let newest = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      const m = fs.statSync(p).mtimeMs;
      if (m > newest) newest = m;
    }
  };
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    const m = fs.statSync(r).mtimeMs;
    if (m > newest) newest = m;
  }
  walk(path.join(REPO_ROOT, 'src'));
  return newest;
}

function ensureBuild(force) {
  const distIndex = path.join(DIST, 'index.html');
  if (force) {
    log('· --rebuild：强制重新构建（**新增/删除源码文件时 mtime 判据看不见，必须用这个**）');
  } else if (!fs.existsSync(distIndex)) {
    log('· dist/ 不存在，执行构建...');
  } else if (newestSourceMtime() > fs.statSync(distIndex).mtimeMs) {
    log('⚠ dist/ 比源码旧 —— 构建产物可能不是当前代码（读数不可解释）');
    log('· 重新构建...');
  } else {
    log('· dist/ 是新的，跳过构建（删除过源码文件时该判据**看不见** ⇒ 用 --rebuild）');
    return;
  }
  const res = spawnSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit', shell: true });
  if (res.status !== 0) {
    log(`构建失败（exit=${res.status}），终止。`);
    process.exit(1);
  }
}

/** 收集 spec：返回 [{file, dir, kind}]（kind: 'dist' | 'src'） */
function collectSpecs(only) {
  const out = [];
  const add = (dir, kind) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.e2e.cjs')).sort()) {
      if (only && !f.includes(only)) continue;
      out.push({ file: path.join(dir, f), kind });
    }
  };
  add(SPEC_DIR, 'dist');
  add(SPEC_SRC_DIR, 'src');
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.build) ensureBuild(args.rebuild);
  else if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    log('--no-build 但 dist/index.html 不存在，终止。');
    process.exit(1);
  }

  const specs = collectSpecs(args.only);
  if (!specs.length) {
    log(`未找到匹配的 spec（--only ${args.only || '(空)'}）`);
    process.exit(2);
  }

  const server = await startStaticServer({
    port: args.port,
    mounts: [
      { prefix: args.prefix, root: DIST },
      { prefix: SRC_PREFIX, root: REPO_ROOT, publicDir: path.join(REPO_ROOT, 'public') },
    ],
  });
  const distUrl = server.mounts.find((m) => m.prefix === args.prefix).url;
  const srcUrl = server.mounts.find((m) => m.prefix === SRC_PREFIX).url;

  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  log(`独立形态 E2E：${specs.length} 个 spec`);
  log(`构建产物站点：${distUrl}（云子路径形态）`);
  log(`源码树站点：${srcUrl}（未打包 ESM，供直接 import 真实模块）`);
  log(`端口：${server.port}（L0-16 登记段；占用即退出，不自动换端口）`);
  log('');

  try {
    for (const { file, kind } of specs) {
      const spec = require(file);
      const baseUrl = kind === 'src' ? srcUrl : distUrl;
      const label = `${spec.name || path.basename(file).replace(/\.e2e\.cjs$/, '')}`
        + (kind === 'src' ? '〔源码树〕' : '');
      currentSpec = label;
      log(`── ${label} ${'─'.repeat(Math.max(0, 52 - label.length))}`);
      const h = await openSite(baseUrl);
      try {
        await h.goto();
        await spec.run(makeT(), h, {
          baseUrl,
          distUrl,
          srcUrl,
          prefix: args.prefix,
          srcPrefix: SRC_PREFIX,
          fixtureDir: FIXTURE_DIR,
          repoRoot: REPO_ROOT,
          server,
          waitForReady,
        });
      } catch (e) {
        ok(`${label} 未抛异常`, false, (e && e.message) || String(e));
        if (e && e.stack) log(`    ${String(e.stack).split('\n').slice(1, 4).join('\n    ')}`);
      } finally {
        await h.close().catch(() => {});
      }
      log('');
    }
  } finally {
    await server.close();
  }

  log('─'.repeat(60));
  if (state.perSpec.length) {
    log('分项读数（每个 spec：总数 / 通过 / 失败）：');
    const width = Math.max(...state.perSpec.map((x) => x.name.length));
    for (const x of state.perSpec) {
      log(`  ${x.name.padEnd(width)}  ${String(x.total).padStart(3)} 项 / `
        + `${String(x.passed).padStart(3)} 通过`
        + (x.failed ? ` / ${String(x.failed).padStart(2)} 失败  ←` : ''));
    }
  }
  log(`断言 ${state.total} 项：通过 ${state.passed} / 失败 ${state.failed}`);
  if (state.failed) {
    log('失败项：');
    for (const f of state.failures) log(`  - ${f}`);
    process.exit(1);
  }
  log('独立形态 E2E 全绿');
}

main().catch((e) => {
  console.error('运行器异常：', e);
  process.exit(1);
});
