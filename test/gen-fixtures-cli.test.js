/**
 * R-17 的**双向负例守护**（`npm run gen-fixtures` 曾因入口守卫 URL 拼接缺陷**从未生效**）。
 *
 * 缺陷形态是**静默空操作**：退出码 0、零行输出、零产物 ⇒ 只断言「退出码 0」是抓不到的。
 * 故这里必须**双向**都断言：
 *   ① 作为 CLI 直跑 ⇒ **确实产出**（且 stdout 有 generated 行 —— 只查退出码会漏掉这个缺陷）
 *   ② 作为模块 import ⇒ **零副作用**（不写默认 `fixtures/` 目录、不改 `process.exitCode`）
 *
 * 两个方向各对应一种改坏方式：守卫过松 ⇒ ② 红；守卫过紧或拼错 ⇒ ① 红。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const GEN_JS = path.join(REPO_ROOT, 'fixtures', 'gen.js');
const FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures');

/** 目录快照：文件名 → 字节数（用来做「未被写入」的等价断言） */
function snapshotDir(dir) {
  return readdirSync(dir)
    .sort()
    .map((name) => {
      const st = statSync(path.join(dir, name));
      return `${name}:${st.isDirectory() ? 'dir' : st.size}`;
    });
}

function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'genfix-'));
}

describe('R-17 · fixtures/gen.js 入口守卫', () => {
  it('① 作为 CLI 直跑：确实产出三个夹具包（修复前此处为空目录）', () => {
    const outDir = tmpDir();
    const stdout = execFileSync(process.execPath, [GEN_JS, outDir], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    // 「退出码 0」不足以判定成功 —— 原缺陷正是退出码 0 且零输出、零产物
    expect(stdout).toMatch(/generated fixture-st\.zip/);
    expect(stdout).toMatch(/generated fixture-l\.zip/);
    expect(stdout).toMatch(/generated fixture-tt\.zip/);

    const produced = readdirSync(outDir).sort();
    expect(produced).toEqual(['fixture-l.zip', 'fixture-st.zip', 'fixture-tt.zip']);
    for (const name of produced) {
      expect(statSync(path.join(outDir, name)).size).toBeGreaterThan(0);
    }
  });

  it('② 作为模块 import：零副作用（不写 fixtures/、不改 exitCode）', async () => {
    const before = snapshotDir(FIXTURES_DIR);
    const exitCodeBefore = process.exitCode;

    // 带查询串强制**重新求值**（绕开模块缓存）—— 否则命中缓存、入口守卫根本不会被执行，
    // 这条断言就成了「测缓存」而不是「测守卫」
    await import(`${pathToFileURL(GEN_JS).href}?probe=${Date.now()}`);

    expect(snapshotDir(FIXTURES_DIR)).toEqual(before);
    expect(process.exitCode).toBe(exitCodeBefore);
  });

  it('③ 不给 outDir 时落到 cwd/fixtures（默认值契约，CLI 直跑依赖它）', () => {
    const cwd = tmpDir();
    execFileSync(process.execPath, [GEN_JS], { cwd, encoding: 'utf8' });

    const produced = readdirSync(path.join(cwd, 'fixtures')).sort();
    expect(produced).toEqual(['fixture-l.zip', 'fixture-st.zip', 'fixture-tt.zip']);
  });
});
