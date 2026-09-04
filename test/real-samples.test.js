// T1: 真实产物镜像测试 —— 把 Phase C 生成的真实产物 zip 逐条目过 L/PT 的真实路由规则。
// 这是 D2(平台手动导入)的自动化代理:规则直接镜像自平台源码(证据见
// research/platform-facts.md §3/§4)。产物或样本缺失时整组跳过(CI 无样本也能跑)。
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { zipIo } from '../src/core/zip-io.js';

const OUT = 'out';
const REAL = {
  lToL: path.join(OUT, 'real-l-to-l.zip'),
  lToPt: path.join(OUT, 'real-l-to-pt.zip'),
  lToTt: path.join(OUT, 'real-l-to-tt.zip'),
  ttToL: path.join(OUT, 'real-tt-to-l.zip'),
  ttToPt: path.join(OUT, 'real-tt-to-pt.zip'),
  reportLToPt: path.join(OUT, 'real-l-to-pt.json'),
  reportTtToPt: path.join(OUT, 'real-tt-to-pt.json'),
};
const has = (p) => existsSync(p);
const hasAll = (...paths) => paths.every(has);

async function listPaths(zipPath) {
  const reader = await zipIo.openReader(zipPath);
  const paths = [];
  for await (const entry of reader.entries()) {
    paths.push(entry.fileName);
    entry.skip();
  }
  await reader.close();
  return paths;
}

// ---- L 真实恢复目标(镜像 users.js getUserBackupTargets:1363 + USER_DIRECTORY_TEMPLATE) ----
const L_FILES = new Set(['settings.json', 'secrets.json']);
const L_DIRS = [
  'backups', // settings 类目(users.js:1370)
  'characters', 'User Avatars', 'backgrounds',
  'chats', 'groups', 'group chats',
  'worlds',
  'NovelAI Settings', 'KoboldAI Settings', 'OpenAI Settings', 'TextGen Settings',
  'instruct', 'context', 'QuickReplies', 'themes', 'movingUI', 'sysprompt', 'reasoning',
  'assets', 'user/files', 'user/images', 'user/workflows',
  'extensions',
  'vectors',
];
const L_GLOBAL_EXTENSION_ALIASES = [
  'public/scripts/extensions/third-party',
  'scripts/extensions/third-party',
  'extensions/third-party',
  'third-party',
];

/** 镜像 users-private.js resolveAllowedRestorePath:候选后缀依次匹配 文件/目录/别名。 */
function lResolves(entryPath) {
  const parts = entryPath.split('/').filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    const candidate = parts.slice(index).join('/');
    if (!candidate || candidate === 'manifest.json') continue;
    if (L_FILES.has(candidate)) return true;
    for (const dir of L_DIRS) {
      if (candidate === dir || candidate.startsWith(`${dir}/`)) return true;
    }
    for (const alias of L_GLOBAL_EXTENSION_ALIASES) {
      if (candidate.startsWith(`${alias}/`)) return true;
    }
  }
  return false;
}

// ---- PT 真实路由(镜像 tauri-tavern data-tree.ts / tauri-tavern-import.ts routeExtensionFile) ----
function classifyPtEntry(fileName) {
  if (fileName.startsWith('data/default-user/')) return 'user';
  if (fileName.startsWith('data/extensions/third-party/')) return 'extension-package';
  if (fileName.startsWith('data/_tauritavern/extension-sources/')) return 'extension-source';
  return 'unsupported';
}

describe.skipIf(!hasAll(REAL.lToL, REAL.ttToL))('真实产物 → L 恢复目标镜像', () => {
  it.each([
    ['real-l-to-l.zip', REAL.lToL],
    ['real-tt-to-l.zip', REAL.ttToL],
  ])('%s:除 manifest 外每个条目都命中 L 恢复目标', async (_name, zipPath) => {
    const misses = (await listPaths(zipPath)).filter((name) => name !== 'manifest.json' && !lResolves(name));
    // 汇总前 10 条,便于定位映射缺口
    expect(misses.slice(0, 10), `${misses.length} 个条目 L 恢复时不会落地`).toEqual([]);
  });
});

describe.skipIf(!hasAll(REAL.lToPt, REAL.reportLToPt))('真实产物 → PT 导入路由镜像', () => {
  it('real-l-to-pt.zip:每个条目都落进 PT 三个可识别根之一', async () => {
    const unsupported = (await listPaths(REAL.lToPt)).filter((name) => classifyPtEntry(name) === 'unsupported');
    expect(unsupported.slice(0, 10), `${unsupported.length} 个条目会被 PT 丢弃`).toEqual([]);
  });

  it('real-l-to-pt.zip:每个第三方扩展都有来源记录,或转换报告已按 PT 规则警告', async () => {
    const paths = await listPaths(REAL.lToPt);
    const folders = new Set(
      paths
        .filter((name) => classifyPtEntry(name) === 'extension-package')
        .map((name) => name.slice('data/extensions/third-party/'.length).split('/')[0]),
    );
    const recorded = new Set(
      paths
        .filter((name) => classifyPtEntry(name) === 'extension-source')
        .map((name) => name.slice('data/_tauritavern/extension-sources/'.length).split('/')[1])
        .map((name) => name.replace(/\.json$/, '')),
    );
    const report = JSON.parse(await readFile(REAL.reportLToPt, 'utf8'));
    const warned = new Set(
      report.warnings
        .map((line) => /扩展 "([^"]+)"/u.exec(line)?.[1])
        .filter(Boolean),
    );
    const unhandled = [...folders].filter((folder) => !recorded.has(folder) && !warned.has(folder));
    expect(unhandled, `以下扩展既无来源记录也无警告,PT 会静默跳过: ${unhandled.join(', ')}`).toEqual([]);
  });

  it('real-l-to-pt.zip:用户级 extensions 全部迁移或冲突丢弃,并出具迁移摘要', async () => {
    const paths = await listPaths(REAL.lToPt);
    const report = JSON.parse(await readFile(REAL.reportLToPt, 'utf8'));
    const warnings = report.warnings.join('\n');
    // L 样本确有大量用户级扩展(extensions/<name>),迁移后不应有 default-user/extensions 残留
    const residual = paths.filter((name) => /^data\/default-user\/extensions\//u.test(name));
    expect(residual.slice(0, 5), `${residual.length} 个用户级扩展条目未被迁移`).toEqual([]);
    expect(warnings).toMatch(/已将 \d+ 个用户级 extensions\/\*\* 条目迁移为 third-party/u);
    const collisions = /同名,已保留第三方副本: (.+)$/um.exec(warnings)?.[1];
    if (collisions) {
      for (const name of collisions.split(',').map((s) => s.trim())) {
        expect(
          paths.some((p) => p.startsWith(`data/extensions/third-party/${name}/`)),
          `冲突扩展 ${name} 的第三方副本应存在`,
        ).toBe(true);
      }
    }
  });
});

describe.skipIf(!hasAll(REAL.ttToPt, REAL.reportTtToPt))('真实产物 → PT(TT 源)镜像', () => {
  it('real-tt-to-pt.zip:每个条目都落进 PT 三个可识别根之一', async () => {
    const unsupported = (await listPaths(REAL.ttToPt)).filter((name) => classifyPtEntry(name) === 'unsupported');
    expect(unsupported.slice(0, 10), `${unsupported.length} 个条目会被 PT 丢弃`).toEqual([]);
  });
});
