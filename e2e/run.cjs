/**
 * E2E 运行器 —— 串行跑 `e2e/specs/*.e2e.cjs`，汇总，**任一断言失败即非零退出**
 *
 * 用法：
 *   node e2e/run.cjs                       # 全部
 *   node e2e/run.cjs --only guard          # 只跑名字含 guard 的
 *   node e2e/run.cjs --only smoke          # 只跑冒烟
 *   node e2e/run.cjs --url https://127.0.0.1:8001   # 覆盖目标（仍过端口守卫）
 *
 * ⚠️ **后缀必须是 `.e2e.cjs`，不能是 `.spec.cjs`**：vitest 的默认 include 覆盖
 * `**\/*.spec.?(c|m)[jt]s?(x)`，用 `.spec.cjs` 会让 `npm test` **把这些用例当单测收集**，
 * 结果是「46 个测试文件」变成 48 个且 2 个文件失败（实测踩过）。
 *
 * 约定：
 *  - spec 模块导出 `{ name, requiresInstance?: <实例 id>, requiresInstances?: [<id>…], run(t) }`。
 *  - 夹具（`lib/harness`）由运行器负责开/关，spec 只管断言。
 *  - **不新装包**：Playwright 由 `lib/resolve-playwright` 从本机全局解析。
 *
 * 纪律：目标一律经 `lib/guard` 校验（I-4：Real 端口出现即抛错，无默认值、不自动改写）。
 */

const fs = require('fs');
const path = require('path');

const { getInstance } = require('./lib/instances.cjs');
const { openInstance } = require('./lib/harness.cjs');
const { assertDevTarget } = require('./lib/guard.cjs');

const SPEC_DIR = path.join(__dirname, 'specs');

function parseArgs(argv) {
  const out = { only: '', url: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--only') out.only = argv[++i] || '';
    else if (argv[i] === '--url') out.url = argv[++i] || '';
  }
  return out;
}

const state = { total: 0, passed: 0, failed: 0, failures: [] };

const log = (msg) => process.stdout.write(`${msg}\n`);

function ok(label, cond, extra = '') {
  state.total += 1;
  const suffix = extra ? ` — ${extra}` : '';
  if (cond) {
    state.passed += 1;
    log(`  [OK]   ${label}${suffix}`);
  } else {
    state.failed += 1;
    state.failures.push(label);
    log(`  [FAIL] ${label}${suffix}`);
  }
  return Boolean(cond);
}

/** 断言上下文：spec 通过它判定并留读数 */
function makeT() {
  return {
    ok,
    eq: (label, actual, expected) => ok(label, actual === expected, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`),
    ge: (label, actual, min) => ok(label, Number(actual) >= min, `actual=${actual} 应 >= ${min}`),
    log,
  };
}

async function main() {
  const { only, url } = parseArgs(process.argv.slice(2));

  let files = fs.readdirSync(SPEC_DIR).filter((f) => f.endsWith('.e2e.cjs')).sort();
  if (only) files = files.filter((f) => f.includes(only));
  if (!files.length) {
    log(`未找到匹配的 spec（--only ${only || '(空)'}，目录 ${SPEC_DIR}）`);
    process.exit(2);
  }

  log(`E2E 运行器：${files.length} 个 spec${only ? `（--only ${only}）` : ''}`);
  log(`端口守卫白名单：${[...require('./lib/guard.cjs').DEV_PORTS].join(' / ')}`);
  log('');

  for (const file of files) {
    const spec = require(path.join(SPEC_DIR, file));
    const label = spec.name || file.replace(/\.e2e\.cjs$/, '');
    log(`── ${label} ${'─'.repeat(Math.max(0, 58 - label.length))}`);

    // 目标实例：支持单实例（`requiresInstance`）与多实例（`requiresInstances`，逐个跑一遍）
    const ids = spec.requiresInstances
      || (spec.requiresInstance ? [spec.requiresInstance] : [null]);

    for (const id of ids) {
      let inst = id ? getInstance(id) : null;
      if (inst && url) {
        assertDevTarget(url); // 先校验再使用：Real 端口在此抛错
        inst = { ...inst, url };
      }
      if (inst) {
        try {
          assertDevTarget(inst.url);
        } catch (e) {
          ok(`${label}${id ? ` @ ${id}` : ''} 目标端口合法`, false, e.message);
          continue;
        }
      }

      let h = null;
      try {
        if (inst) {
          log(`  · 目标 ${inst.id} @ ${inst.url}`);
          h = await openInstance(inst);
          await h.goto();
        }
        const t = makeT();
        await spec.run(t, h);
      } catch (e) {
        ok(`${label}${id ? ` @ ${id}` : ''} 未抛异常`, false, (e && e.message) || String(e));
        if (e && e.stack) log(`    ${String(e.stack).split('\n').slice(1, 4).join('\n    ')}`);
      } finally {
        if (h) await h.close().catch(() => {});
      }
    }
    log('');
  }

  log('─'.repeat(62));
  log(`断言 ${state.total} 项：通过 ${state.passed} / 失败 ${state.failed}`);
  if (state.failed) {
    log('失败项：');
    for (const f of state.failures) log(`  - ${f}`);
    process.exit(1);
  }
  log('E2E 全绿');
}

main().catch((e) => {
  console.error('运行器异常：', e);
  process.exit(1);
});
