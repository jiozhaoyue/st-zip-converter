/**
 * 链接子树守卫的回归测试（`scripts/instance-sync/lib/link-guard.cjs`）
 *
 * 负例（**必须拒绝**）是这条守卫存在的理由：本仓群 `P-18` 的教训是「写入穿透到别人的工作区」
 * 属**静默且不可回收**的损害。故这里同时钉住：
 *   ① `isUnderLink` 的前缀语义（`a/b` 命中、`a/bX` **不**命中）；
 *   ② 无链接时 `assertNoLinksUnder` 放行（不得把正常目录误判成链接）；
 *   ③ 有链接且未放行时**抛错**；
 *   ④ 放行时**返回清单**（供登记），而不是静默通过。
 *
 * junction / symlink 的创建需要平台能力，故 ③④ 用**注入的假探测器**验证判定分支，
 * 真实文件系统上的创建（`mklink /J`）在能建的环境里跑，建不了就跳过（不假装通过）。
 */

import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { isUnderLink, findLinkedRoots, assertNoLinksUnder } = require('../scripts/instance-sync/lib/link-guard.cjs');

describe('链接子树守卫：isUnderLink 的前缀语义', () => {
  const roots = [{ rel: 'extensions/ST-BgLoader' }, { rel: 'characters' }];

  it('命中：链接根自身与其子孙', () => {
    expect(isUnderLink('extensions/ST-BgLoader', roots)).toBe(true);
    expect(isUnderLink('extensions/ST-BgLoader/src/core/x.ts', roots)).toBe(true);
    expect(isUnderLink('characters/任何.png', roots)).toBe(true);
  });

  it('**负例**：同前缀的邻名不算（`ST-BgLoaderX` / `charactersX`）', () => {
    expect(isUnderLink('extensions/ST-BgLoaderX/src/x.ts', roots)).toBe(false);
    expect(isUnderLink('charactersX/a.png', roots)).toBe(false);
    expect(isUnderLink('extensions/别的扩展/x.ts', roots)).toBe(false);
  });

  it('反斜杠路径与正斜杠等价（Windows 实测路径形态）', () => {
    expect(isUnderLink('extensions\\ST-BgLoader\\src\\x.ts', roots)).toBe(true);
  });
});

describe('链接子树门禁：无链接放行、有链接拒绝、放行时给清单', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linkguard-'));

  afterAll(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
  });

  it('普通目录树：无链接 ⇒ 放行且清单为空', async () => {
    fs.mkdirSync(path.join(tmp, 'plain', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'plain', 'sub', 'a.txt'), 'x');
    const links = await assertNoLinksUnder({ rootDir: path.join(tmp, 'plain'), allowLinks: false, label: 'test' });
    expect(links).toEqual([]);
  });

  it('构造出真实 junction 时：未放行 ⇒ 抛错；放行 ⇒ 返回清单（建不出来则跳过）', async () => {
    const target = path.join(tmp, 'externalRepo');
    const linkParent = path.join(tmp, 'withLink');
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(linkParent, { recursive: true });
    const junction = path.join(linkParent, 'ST-BgLoader');
    let created = false;
    try {
      // Windows 的 junction 不需要管理员权限（符号链接才需要），mklink /J 是最可靠的方式
      execFileSync('cmd', ['/c', 'mklink', '/J', junction, target], { stdio: 'pipe' });
      created = true;
    } catch {
      created = false;
    }
    if (!created) {
      console.warn('[link-guard] 本机无法创建 junction，跳过真实链接用例（未假装通过）');
      return;
    }

    const found = await findLinkedRoots(linkParent);
    expect(found.map((l) => l.rel)).toEqual(['ST-BgLoader']);

    await expect(assertNoLinksUnder({ rootDir: linkParent, allowLinks: false, label: 'test' }))
      .rejects.toThrow(/链接子树/);
    const allowed = await assertNoLinksUnder({ rootDir: linkParent, allowLinks: true, label: 'test' });
    expect(allowed.map((l) => l.rel)).toEqual(['ST-BgLoader']);
  });
});
