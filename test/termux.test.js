// T4 / AC8: Termux 可运行性 —— 运行时依赖链无原生编译、无平台限定字段;
// CLI 在受限内存(--max-old-space-size=192)下完成一次完整转换。
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, mkdtempSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { generateAll } from '../fixtures/gen.js';

const execFileAsync = promisify(execFile);

function collectProdPackages(lock) {
  const packages = lock.packages ?? {};
  const prodRoots = Object.entries(packages)
    .filter(([key, value]) => key.startsWith('node_modules/') && !key.slice('node_modules/'.length).includes('node_modules'))
    .filter(([, value]) => {
      // 只追生产依赖:从根的 dependencies 出发做闭包
      return false;
    });
  void prodRoots;
  // 从根 dependencies 开始的闭包
  const root = packages[''] ?? {};
  const prodNames = new Set(Object.keys(root.dependencies ?? {}));
  const stack = [...prodNames];
  while (stack.length > 0) {
    const name = stack.pop();
    const entry = packages[`node_modules/${name}`];
    if (!entry) continue;
    for (const dep of Object.keys(entry.dependencies ?? {})) {
      if (!prodNames.has(dep)) {
        prodNames.add(dep);
        stack.push(dep);
      }
    }
  }
  return [...prodNames].map((name) => ({ name, entry: packages[`node_modules/${name}`] })).filter((x) => x.entry);
}

describe('AC8: Termux 可运行性(结构检查)', () => {
  it('生产依赖闭包内无原生模块(gypfile/binary/安装脚本/平台限定)', () => {
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    const prod = collectProdPackages(lock);
    expect(prod.length, '应能从 lockfile 解析出生产依赖').toBeGreaterThan(0);
    const offenders = prod.filter(({ name, entry }) => {
      if (entry.gypfile || entry.binary || entry.hasInstallScript) return true;
      if (entry.os || entry.cpu) return true;
      return false;
    });
    expect(offenders.map((x) => x.name), '存在原生/平台限定依赖,Termux 不可用').toEqual([]);
  });

  it('engines.node >= 18(Termux nodejs-lts 满足)', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.engines?.node).toBe('>=18');
  });

  it('CLI 在 192MiB V8 堆上限下完成真实小包转换', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'termux-'));
    const fixtures = await generateAll(dir);
    const out = path.join(dir, 'out-pt.zip');
    const { stderr } = await execFileAsync(process.execPath, [
      '--max-old-space-size=192',
      'cli.js',
      fixtures['fixture-l.zip'],
      '--to', 'pt',
      '-o', out,
    ], { cwd: process.cwd(), timeout: 120000 });
    expect(stderr ?? '').toBe('');
  });
});
