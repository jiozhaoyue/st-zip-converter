import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as zip from '@zip.js/zip.js';
import { zipIo } from '../src/core/zip-io.js';
import {
  convert,
  TARGETS,
  GIT_MODES,
  GIT_KEEP_PLACEHOLDER,
  isGitEntry,
  isGitMinimalKept,
  normalizeGitMode,
  gitDropReason,
} from '../src/core/transform.js';
import { generatePlan, ACTIONS } from '../src/core/plan-preview.js';
import { getWorkbenchHtml } from '../src/ui/workbench-template.js';
import { CONTROL_CONSUMERS } from '../scripts/control-consumer-guard.js';
import { stEntries } from '../fixtures/gen.js';

/**
 * gitMode（扩展 Git 历史瘦身）验收。
 *
 * 策略语义与代价的**权威依据**是任务 prd.md 的「本轮取证」表（临时目录 git 二进制实测）：
 * - 只留 config/HEAD/refs 而不留 objects/ 目录 → git 判为「不是仓库」；
 * - 补 `index` + 合成 `objects/.keep` 后，checkIsRepo/branch/pull 三条全过，且 pull 自愈为完整仓库；
 * - strip → 非仓库，接收方需重新 clone。
 * 本文件把上述结论固化为可执行契约（不依赖系统 git，纯合成包断言）。
 */

const TMP_DIRS = [];
const BRANCH = 'main';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const REMOTE = 'https://github.com/example/test-extension';

/** 独立扩展目录：避开 fixtures/gen.js 已占用的 extensions/test-extension。 */
const EXT_ROOT = 'extensions/git-ext';
const PLAIN_EXT_ROOT = 'extensions/plain-ext';

async function tmpDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tavern-git-mode-'));
  TMP_DIRS.push(dir);
  return dir;
}

/** 一个真实 clone 会产生、且本策略关心的 .git 条目集。 */
function gitEntries(root) {
  return [
    [`${root}/manifest.json`, Buffer.from(JSON.stringify({ display_name: 'Demo Ext', version: '1.0.0' }))],
    [`${root}/index.js`, Buffer.from('export const a = 1;\n')],
    // —— 元数据（minimal 保留）——
    [`${root}/.git/config`, Buffer.from(`[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${REMOTE}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`)],
    [`${root}/.git/HEAD`, Buffer.from(`ref: refs/heads/${BRANCH}\n`)],
    [`${root}/.git/index`, Buffer.from([0x44, 0x49, 0x52, 0x43, 0x00, 0x00, 0x00, 0x02])],
    [`${root}/.git/refs/heads/${BRANCH}`, Buffer.from(`${COMMIT}\n`)],
    // —— 对象存储与小头（三种非 keep 策略下都被剔除）——
    [`${root}/.git/objects/pack/pack-deadbeef.pack`, Buffer.alloc(64 * 1024, 0x41)],
    [`${root}/.git/objects/ab/cdef0123456789abcdef0123456789abcdef01`, Buffer.alloc(512, 0x42)],
    [`${root}/.git/packed-refs`, Buffer.from(`# pack-refs with: peeled fully-peeled sorted\n${COMMIT} refs/remotes/origin/${BRANCH}\n`)],
    [`${root}/.git/description`, Buffer.from('Unnamed repository; edit this file to name it.\n')],
    [`${root}/.git/hooks/pre-commit.sample`, Buffer.from('#!/bin/sh\n')],
    // —— 陷阱：名字像 .git 但不在 .git 目录内 ——
    [`${root}/.gitkeep`, Buffer.from('')],
  ];
}

function plainExtensionEntries(root) {
  return [
    [`${root}/manifest.json`, Buffer.from(JSON.stringify({ display_name: 'No Git', version: '1.0.0' }))],
    [`${root}/index.js`, Buffer.from('export const b = 2;\n')],
  ];
}

function allEntries() {
  return [...stEntries(), ...gitEntries(EXT_ROOT), ...plainExtensionEntries(PLAIN_EXT_ROOT)];
}

async function zipFrom(entries) {
  const dir = await tmpDir();
  const outPath = path.join(dir, 'in.zip');
  const writer = await zipIo.createWriter(outPath);
  for (const [name, data] of entries) {
    await writer.add(name, data);
  }
  await writer.close();
  return outPath;
}

async function readZipMap(outPath) {
  const reader = await zipIo.openReader(outPath);
  const map = new Map();
  for await (const entry of reader.entries()) {
    map.set(entry.fileName, Buffer.from(await entry.read()));
  }
  await reader.close();
  return map;
}

async function runConvert(entries, target, options = {}) {
  const dir = await tmpDir();
  const source = await zipFrom(entries);
  const outPath = path.join(dir, `out-${target}.zip`);
  const report = await convert(source, outPath, { target, io: zipIo, ...options });
  return { report, outPath, files: await readZipMap(outPath) };
}

async function planBlob(entries) {
  const blobWriter = new zip.BlobWriter('application/zip');
  const writer = new zip.ZipWriter(blobWriter);
  for (const [name, data] of entries) {
    await writer.add(name, new zip.Uint8ArrayReader(new Uint8Array(data)));
  }
  await writer.close();
  return blobWriter.getData();
}

const gitPaths = (files) => [...files.keys()].filter((p) => p.includes('/.git/')).sort();

/** 从产出包读转换器私有清单里的该扩展条目（含 gitMeta 派生结果）。 */
function manifestEntry(files, name) {
  const raw = files.get('_convert/extensions-manifest.json');
  expect(raw, '产出包必须含 _convert/extensions-manifest.json').toBeTruthy();
  const parsed = JSON.parse(raw.toString('utf8'));
  const list = parsed.extensions || parsed.entries || [];
  const found = list.find((e) => e.name === name);
  expect(found, `清单中应有扩展 ${name}`).toBeTruthy();
  return found;
}

describe('gitMode 纯函数契约', () => {
  it('isGitEntry 只认 .git 目录本身，不把 .gitkeep 误判进去', () => {
    expect(isGitEntry('.git')).toBe(true);
    expect(isGitEntry('.git/config')).toBe(true);
    expect(isGitEntry('.git/objects/pack/x.pack')).toBe(true);
    expect(isGitEntry('.gitkeep')).toBe(false);
    expect(isGitEntry('sub/.gitkeep')).toBe(false);
    expect(isGitEntry('')).toBe(false);
  });

  it('isGitMinimalKept 保留集恰为 config/HEAD/index/refs/heads/**', () => {
    expect(isGitMinimalKept('.git/config')).toBe(true);
    expect(isGitMinimalKept('.git/HEAD')).toBe(true);
    expect(isGitMinimalKept('.git/index')).toBe(true);
    expect(isGitMinimalKept('.git/refs/heads/main')).toBe(true);
    expect(isGitMinimalKept('.git/refs/heads/feat/nested-ok')).toBe(true);
    // 对象存储、小头、remote 引用一律不保留
    expect(isGitMinimalKept('.git/objects/pack/x.pack')).toBe(false);
    expect(isGitMinimalKept('.git/packed-refs')).toBe(false);
    expect(isGitMinimalKept('.git/description')).toBe(false);
    expect(isGitMinimalKept('.git/refs/remotes/origin/main')).toBe(false);
    expect(isGitMinimalKept('.git/logs/HEAD')).toBe(false);
  });

  it('normalizeGitMode 对未知取值回落 keep（默认行为不被任意输入击穿）', () => {
    expect(normalizeGitMode(GIT_MODES.STRIP)).toBe('strip');
    expect(normalizeGitMode(GIT_MODES.MINIMAL)).toBe('minimal');
    expect(normalizeGitMode(undefined)).toBe('keep');
    expect(normalizeGitMode('bogus')).toBe('keep');
    expect(normalizeGitMode(null)).toBe('keep');
  });

  it('占位文件必须非 0 字节（个别解压实现会跳过零长度条目）', () => {
    expect(GIT_KEEP_PLACEHOLDER.length).toBeGreaterThan(0);
  });

  it('剔除文案区分两档，且各自写明代价', () => {
    expect(gitDropReason(GIT_MODES.STRIP)).toContain('重新 git clone');
    expect(gitDropReason(GIT_MODES.MINIMAL)).toContain('最小集');
  });
});

describe('gitMode=keep（默认，零行为变化）', () => {
  it('保留全部 .git 条目，并在清单中解析出 remoteUrl/branch/commit', async () => {
    const { files } = await runConvert(allEntries(), TARGETS.ST, { extensionMode: 'full' });

    expect(gitPaths(files)).toEqual([
      `${EXT_ROOT}/.git/HEAD`,
      `${EXT_ROOT}/.git/config`,
      `${EXT_ROOT}/.git/description`,
      `${EXT_ROOT}/.git/index`,
      `${EXT_ROOT}/.git/objects/ab/cdef0123456789abcdef0123456789abcdef01`,
      `${EXT_ROOT}/.git/objects/pack/pack-deadbeef.pack`,
      `${EXT_ROOT}/.git/packed-refs`,
      `${EXT_ROOT}/.git/refs/heads/main`,
    ].sort());

    const entry = manifestEntry(files, 'git-ext');
    expect(entry.url).toBe(REMOTE);
    expect(entry.branch).toBe(BRANCH);
    expect(entry.commit).toBe(COMMIT);
  });

  it('未传 gitMode 与传 keep 产出完全一致（默认值即 keep）', async () => {
    const a = await runConvert(allEntries(), TARGETS.ST, { extensionMode: 'full' });
    const b = await runConvert(allEntries(), TARGETS.ST, { extensionMode: 'full', gitMode: GIT_MODES.KEEP });
    expect([...a.files.keys()].sort()).toEqual([...b.files.keys()].sort());
    expect(gitPaths(a.files)).toEqual(gitPaths(b.files));
  });

  it('未知 gitMode 取值回落 keep，与 keep 产出一致', async () => {
    const a = await runConvert(allEntries(), TARGETS.ST, { extensionMode: 'full' });
    const b = await runConvert(allEntries(), TARGETS.ST, { extensionMode: 'full', gitMode: 'not-a-mode' });
    expect(gitPaths(b.files)).toEqual(gitPaths(a.files));
  });

  it('不合成任何 .git/objects/.keep', async () => {
    const { files } = await runConvert(allEntries(), TARGETS.ST, { extensionMode: 'full' });
    expect([...files.keys()].some((p) => p.endsWith('/.git/objects/.keep'))).toBe(false);
  });
});

describe('gitMode=strip', () => {
  it('产出包内 .git 条目数为 0，且 report 上报剔除字节数', async () => {
    const { files, report } = await runConvert(allEntries(), TARGETS.ST, {
      extensionMode: 'full',
      gitMode: GIT_MODES.STRIP,
    });

    expect(gitPaths(files)).toEqual([]);
    expect([...files.keys()].some((p) => p.endsWith('/.git/objects/.keep'))).toBe(false);

    const json = report.toJSON();
    // packfile 64KiB + 松散对象 512B + 各小头，必然远超阈值
    expect(json.totals.droppedBytes).toBeGreaterThan(64 * 1024);
    expect(json.dropped.some((d) => d.path.endsWith('/.git/config') && d.reason.includes('gitMode=strip'))).toBe(true);
    const packDrop = json.dropped.find((d) => d.path.endsWith('pack-deadbeef.pack'));
    expect(packDrop.bytes).toBe(64 * 1024);
  });

  it('扩展的运行期代码不受影响，且清单仍解析出 Git 元数据（解析与写出解耦）', async () => {
    const { files } = await runConvert(allEntries(), TARGETS.ST, {
      extensionMode: 'full',
      gitMode: GIT_MODES.STRIP,
    });

    expect(files.has(`${EXT_ROOT}/index.js`)).toBe(true);
    expect(files.has(`${EXT_ROOT}/manifest.json`)).toBe(true);
    // 陷阱条目：`.gitkeep` 不是 .git 条目，任何策略下都不得被误剔
    expect(files.has(`${EXT_ROOT}/.gitkeep`)).toBe(true);

    const entry = manifestEntry(files, 'git-ext');
    expect(entry.url).toBe(REMOTE);
    expect(entry.branch).toBe(BRANCH);
    expect(entry.commit).toBe(COMMIT);
  });
});

describe('gitMode=minimal', () => {
  const EXPECTED_MINIMAL = [
    `${EXT_ROOT}/.git/HEAD`,
    `${EXT_ROOT}/.git/config`,
    `${EXT_ROOT}/.git/index`,
    `${EXT_ROOT}/.git/objects/.keep`,
    `${EXT_ROOT}/.git/refs/heads/${BRANCH}`,
  ].sort();

  it('保留集恰好为 config/HEAD/index/refs/heads/<br> + 合成的 objects/.keep', async () => {
    const { files } = await runConvert(allEntries(), TARGETS.ST, {
      extensionMode: 'full',
      gitMode: GIT_MODES.MINIMAL,
    });

    expect(gitPaths(files)).toEqual(EXPECTED_MINIMAL);
    // objects 下除占位文件外不得有任何对象存储
    const objectPaths = [...files.keys()].filter((p) => p.includes('/.git/objects/'));
    expect(objectPaths).toEqual([`${EXT_ROOT}/.git/objects/.keep`]);
    // 合成条目内容非空——它是「保证目录存在」的唯一手段（本项目管线丢弃空目录条目）
    expect(files.get(`${EXT_ROOT}/.git/objects/.keep`).length).toBe(GIT_KEEP_PLACEHOLDER.length);
  });

  it('清单仍解析出 Git 元数据（三模式一致）', async () => {
    const { files } = await runConvert(allEntries(), TARGETS.ST, {
      extensionMode: 'full',
      gitMode: GIT_MODES.MINIMAL,
    });
    const entry = manifestEntry(files, 'git-ext');
    expect(entry.url).toBe(REMOTE);
    expect(entry.branch).toBe(BRANCH);
    expect(entry.commit).toBe(COMMIT);
  });

  it('report 上报剔除条目与字节数，并给出接收方需联网的警告', async () => {
    const { report } = await runConvert(allEntries(), TARGETS.ST, {
      extensionMode: 'full',
      gitMode: GIT_MODES.MINIMAL,
    });
    const json = report.toJSON();
    expect(json.totals.droppedBytes).toBeGreaterThan(64 * 1024);
    expect(json.dropped.some((d) => d.reason.includes('gitMode=minimal'))).toBe(true);
    expect(json.warnings.some((w) => w.includes('gitMode=minimal'))).toBe(true);
    expect(json.synthesized.some((p) => p.endsWith('/.git/objects/.keep'))).toBe(true);
  });

  it('非 .git 条目与 keep 模式字节级一致（只动 .git）', async () => {
    const keep = await runConvert(allEntries(), TARGETS.ST, { extensionMode: 'full' });
    const minimal = await runConvert(allEntries(), TARGETS.ST, {
      extensionMode: 'full',
      gitMode: GIT_MODES.MINIMAL,
    });

    const nonGit = (files) => [...files.keys()].filter((p) => !p.includes('/.git/')).sort();
    expect(nonGit(minimal.files)).toEqual(nonGit(keep.files));
    for (const p of nonGit(keep.files)) {
      expect(Buffer.compare(minimal.files.get(p), keep.files.get(p)), p).toBe(0);
    }
  });

  it('本无 .git 的扩展不产生任何合成条目（不凭空造目录）', async () => {
    const { files } = await runConvert(allEntries(), TARGETS.ST, {
      extensionMode: 'full',
      gitMode: GIT_MODES.MINIMAL,
    });
    expect([...files.keys()].some((p) => p.startsWith(`${PLAIN_EXT_ROOT}/.git/`))).toBe(false);
    expect(files.has(`${PLAIN_EXT_ROOT}/index.js`)).toBe(true);
  });

  it('TT 目标下合成路径走 targetEntryPath 映射（data/extensions/third-party/**）', async () => {
    const { files } = await runConvert(allEntries(), TARGETS.TT, {
      extensionMode: 'full',
      gitMode: GIT_MODES.MINIMAL,
    });
    expect(files.has('data/extensions/third-party/git-ext/.git/objects/.keep')).toBe(true);
  });
});

describe('gitMode 与 extensionMode=manifest 的联动', () => {
  it('轻量清单模式整体不打包 .git，也不合成 .keep、不按 gitMode 上报', async () => {
    const { files, report } = await runConvert(allEntries(), TARGETS.ST, {
      extensionMode: 'manifest',
      gitMode: GIT_MODES.MINIMAL,
    });

    expect(gitPaths(files)).toEqual([]);
    expect([...files.keys()].some((p) => p.startsWith(EXT_ROOT))).toBe(false);
    const json = report.toJSON();
    expect(json.dropped.some((d) => d.reason.startsWith('gitMode='))).toBe(false);
    expect(json.dropped.some((d) => d.reason.includes('轻量清单模式'))).toBe(true);
  });
});

describe('plan-preview 的 gitMode 预测', () => {
  const extItems = (plan) => plan.categories.extensions.items;
  /** 受 gitMode 管辖的 .git 条目。 */
  const managedGitItems = (plan) => extItems(plan).filter((i) => i.hubPath.includes('/.git/'));
  /** 由**既有 junk 清洗**先手丢弃的 .git 条目（hooks/logs）——gitMode 不得改变它们的理由。 */
  const junkGitItems = (plan) => extItems(plan)
    .filter((i) => i.hubPath.includes('/.git/hooks/') || i.hubPath.includes('/.git/logs/'));

  it('keep：.git 条目按原动作预测，且无 .keep 合成项；junk 清洗维持原判', async () => {
    const plan = await generatePlan(await planBlob(allEntries()), TARGETS.ST, {
      extensionMode: 'full',
    });
    const managed = managedGitItems(plan).filter((i) => !junkGitItems(plan).includes(i));
    expect(managed.length).toBeGreaterThan(0);
    expect(managed.every((i) => i.action !== ACTIONS.DROP)).toBe(true);
    // .git/hooks/* 一直由 isJunkOrDevFile 清洗，与 gitMode 无关——这条是防回归断言
    expect(junkGitItems(plan).every((i) => i.reason.includes('安全清洗'))).toBe(true);
    expect(plan.synthesizedItems.some((s) => s.targetPath.endsWith('/.git/objects/.keep'))).toBe(false);
  });

  it('strip：受管辖的 .git 条目全部预测为 DROP，且理由为 strip 文案', async () => {
    const plan = await generatePlan(await planBlob(allEntries()), TARGETS.ST, {
      extensionMode: 'full',
      gitMode: GIT_MODES.STRIP,
    });
    const managed = managedGitItems(plan).filter((i) => !junkGitItems(plan).includes(i));
    expect(managed.length).toBeGreaterThan(0);
    expect(managed.every((i) => i.action === ACTIONS.DROP)).toBe(true);
    expect(managed.every((i) => i.reason.includes('gitMode=strip'))).toBe(true);
  });

  it('minimal：白名单条目不 DROP、对象存储 DROP，并预测出 .keep 合成项', async () => {
    const plan = await generatePlan(await planBlob(allEntries()), TARGETS.ST, {
      extensionMode: 'full',
      gitMode: GIT_MODES.MINIMAL,
    });
    const kept = ['config', 'HEAD', 'index', `refs/heads/${BRANCH}`]
      .map((suffix) => extItems(plan).find((i) => i.hubPath === `${EXT_ROOT}/.git/${suffix}`));

    for (const item of kept) {
      expect(item, '白名单条目应存在').toBeTruthy();
      expect(item.action).not.toBe(ACTIONS.DROP);
    }

    const dropped = managedGitItems(plan)
      .filter((i) => i.action === ACTIONS.DROP && !i.hubPath.includes('/.git/hooks/'));
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.every((i) => i.reason.includes('gitMode=minimal'))).toBe(true);
    expect(dropped.some((i) => i.hubPath.endsWith('.pack'))).toBe(true);

    const synthesized = plan.synthesizedItems.filter((s) => s.targetPath.endsWith('/.git/objects/.keep'));
    expect(synthesized.length).toBe(1);
    expect(synthesized[0].targetPath).toBe(`${EXT_ROOT}/.git/objects/.keep`);
  });

  it('类目未勾选时不预测 .keep（与 transform 的跳过路径对齐）', async () => {
    const plan = await generatePlan(await planBlob(allEntries()), TARGETS.ST, {
      extensionMode: 'full',
      gitMode: GIT_MODES.MINIMAL,
      selection: { extensions: false },
    });
    expect(plan.synthesizedItems.some((s) => s.targetPath.endsWith('/.git/objects/.keep'))).toBe(false);
  });

  it('manifest 模式不预测 .keep', async () => {
    const plan = await generatePlan(await planBlob(allEntries()), TARGETS.ST, {
      extensionMode: 'manifest',
      gitMode: GIT_MODES.MINIMAL,
    });
    expect(plan.synthesizedItems.some((s) => s.targetPath.endsWith('/.git/objects/.keep'))).toBe(false);
  });
});

describe('gitMode UI 契约', () => {
  // 项目不引入 jsdom（依赖自包含 L1-MR-11），故 UI 契约落在「模板产出 + 消费点」两层。
  const MODES = [
    ['独立态', { isStandalone: true }],
    ['插件抽屉态', { isDrawer: true }],
    ['模态态', { isModal: true }],
  ];

  it.each(MODES)('%s 均产出三档单选且默认为 keep', (_label, opts) => {
    const html = getWorkbenchHtml(opts);
    for (const value of ['keep', 'minimal', 'strip']) {
      expect(html, `缺少 git-mode=${value}`).toContain(`name="git-mode" value="${value}"`);
    }
    // 默认必须是 keep：PRD 裁决「默认行为零变化」，改动默认值即回归
    expect(html).toContain('name="git-mode" value="keep" checked');
    expect(html).not.toContain('name="git-mode" value="minimal" checked');
    expect(html).not.toContain('name="git-mode" value="strip" checked');
  });

  it('每档都写明代价（R3 的影响说明走 title，避免新增 CSS）', () => {
    const html = getWorkbenchHtml({ isStandalone: true });
    // minimal 必须点明「接收方要联网」这一前提，strip 必须点明「失去在线更新」
    expect(html).toMatch(/title="[^"]*联网[^"]*"/);
    expect(html).toMatch(/title="[^"]*重新 git clone[^"]*"/);
    // 三档齐全（keep 也应说明「包最大」的代价）
    expect((html.match(/<label class="ext-mode-opt" title="[^"]*">\s*<input type="radio" name="git-mode"/g) || []).length).toBe(3);
  });

  it('控件消费点守卫已登记 name:git-mode，且 index.js 存在真实读取点', async () => {
    expect(CONTROL_CONSUMERS['name:git-mode'], '未登记消费点则守卫应拦下该控件').toBeTruthy();

    const src = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    // 读取点（getGitMode）与透传点必须同时存在——只有其一即为半接线
    expect(src).toContain('input[name="git-mode"]:checked');
    expect((src.match(/gitMode: getGitMode\(\)/g) || []).length).toBeGreaterThanOrEqual(4);
    // 轻量清单模式下联动禁用（否则又是一枚「勾了没反应」的控件）
    expect(src).toContain('syncGitModeAvailability');
  });
});
