#!/usr/bin/env node
/**
 * 独立 Web 形态（含**云部署形态**）E2E 运行器
 *
 * 与 `e2e/run.cjs` 的关系：**互不干扰**。那个跑的是「宿主实例上的插件」，
 * 只扫 `e2e/specs/*.e2e.cjs`；本运行器跑的是「**自己就是站点本身**」的独立形态，
 * 只扫 `e2e/standalone/specs/*.e2e.cjs`，并且**不需要任何实例在跑**。
 *
 * 为什么要单开一套（而不是往 `e2e/specs/` 里加文件）：
 *  1. 独立形态**没有宿主**，端口守卫（Dev/Real 白名单）在这里没有意义——那是实例侧的红线；
 *  2. 它需要**构建产物 + 静态服务器**，而起一个实例是被测对象的宿主，完全不同的前置；
 *  3. 云酒馆的真实形态是**子路径静态托管**（GitHub Pages 项目页），这只有自己起服务器才验得了。
 *
 * 用法：
 *   node e2e/standalone/run.cjs                     # 需要时自动构建 → 挂子路径 → 跑全部
 *   node e2e/standalone/run.cjs --only workbench    # 只跑名字含 workbench 的
 *   node e2e/standalone/run.cjs --prefix /           # 挂根路径（对照子路径形态）
 *   node e2e/standalone/run.cjs --no-build           # 用现有 dist（会做新鲜度告警）
 *
 * 纪律：端口显式登记（默认 4173，L0-16），被占用即报错退出，**不自动换端口**。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const { startStaticServer, DEFAULT_PORT } = require('./lib/static-server.cjs');
const { openSite, waitForReady } = require('./lib/harness.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(REPO_ROOT, 'dist');
const SPEC_DIR = path.join(__dirname, 'specs');
const FIXTURE_DIR = path.join(REPO_ROOT, 'test-results', 'fixtures-web');

function parseArgs(argv) {
  const out = { only: '', prefix: '/st-zip-converter/', port: DEFAULT_PORT, build: true };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--only') out.only = argv[++i] || '';
    else if (argv[i] === '--prefix') out.prefix = argv[++i] || '/';
    else if (argv[i] === '--port') out.port = Number(argv[++i]) || DEFAULT_PORT;
    else if (argv[i] === '--no-build') out.build = false;
  }
  return out;
}

const state = { total: 0, passed: 0, failed: 0, failures: [] };
const log = (m) => process.stdout.write(`${m}\n`);

function ok(label, cond, extra = '') {
  state.total += 1;
  const suffix = extra ? ` — ${extra}` : '';
  if (cond) { state.passed += 1; log(`  [OK]   ${label}${suffix}`); }
  else { state.failed += 1; state.failures.push(label); log(`  [FAIL] ${label}${suffix}`); }
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
  const roots = [
    path.join(REPO_ROOT, 'index.js'),
    path.join(REPO_ROOT, 'index.html'),
    path.join(REPO_ROOT, 'style.css'),
    path.join(REPO_ROOT, 'package.json'),
    path.join(REPO_ROOT, 'vite.config.js'),
  ];
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

function ensureBuild() {
  const distIndex = path.join(DIST, 'index.html');
  if (!fs.existsSync(distIndex)) {
    log('· dist/ 不存在，执行构建...');
  } else {
    const distM = fs.statSync(distIndex).mtimeMs;
    if (newestSourceMtime() > distM) {
      log('⚠ dist/ 比源码旧 —— 构建产物可能不是当前代码（读数不可解释）');
      log('· 重新构建...');
    } else {
      log('· dist/ 是新的，跳过构建（--no-build 同效）');
      return;
    }
  }
  const res = spawnSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit', shell: true });
  if (res.status !== 0) {
    log(`构建失败（exit=${res.status}），终止。`);
    process.exit(1);
  }
}

/** 现场生成夹具（进程内缓存由各 spec 自行保障；此处只保证目录存在） */
function ensureFixtureDir() {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  return FIXTURE_DIR;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.build) ensureBuild();
  else if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    log('--no-build 但 dist/index.html 不存在，终止。');
    process.exit(1);
  }

  let files = fs.existsSync(SPEC_DIR)
    ? fs.readdirSync(SPEC_DIR).filter((f) => f.endsWith('.e2e.cjs')).sort()
    : [];
  if (args.only) files = files.filter((f) => f.includes(args.only));
  if (!files.length) {
    log(`未找到匹配的 spec（--only ${args.only || '(空)'}，目录 ${SPEC_DIR}）`);
    process.exit(2);
  }

  const server = await startStaticServer({ root: DIST, prefix: args.prefix, port: args.port });
  log(`独立形态 E2E：${files.length} 个 spec`);
  log(`站点：${server.url}（挂载前缀 ${server.prefix} —— 云托管的真实形态）`);
  log(`夹具目录：${ensureFixtureDir()}`);
  log('');

  try {
    for (const file of files) {
      const spec = require(path.join(SPEC_DIR, file));
      const label = spec.name || file.replace(/\.e2e\.cjs$/, '');
      log(`── ${label} ${'─'.repeat(Math.max(0, 56 - label.length))}`);
      const h = await openSite(server.url);
      try {
        await h.goto();
        await spec.run(makeT(), h, {
          baseUrl: server.url,
          prefix: server.prefix,
          fixtureDir: FIXTURE_DIR,
          repoRoot: REPO_ROOT,
          server,
          waitForReady,
          pathToFileURL,
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
