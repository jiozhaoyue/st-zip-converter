import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ZipReader } from '../src/core/read.js';
import { ZipWriter } from '../src/core/write.js';
import { convert, TARGETS } from '../src/core/transform.js';
import { stEntries, lEntries, ttEntries } from '../fixtures/gen.js';

const tmpDirs = [];

async function tmpDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tavern-convert-conv-'));
  tmpDirs.push(dir);
  return dir;
}

async function zipFrom(entries) {
  const dir = await tmpDir();
  const outPath = path.join(dir, 'in.zip');
  const writer = await ZipWriter.create(outPath);
  for (const [name, data] of entries) {
    writer.add(name, data);
  }
  await writer.close();
  return outPath;
}

async function readZipMap(outPath) {
  const reader = await ZipReader.open(outPath);
  const map = new Map();
  for await (const entry of reader.entries()) {
    map.set(entry.fileName, await entry.read());
  }
  await reader.close();
  return map;
}

async function runConvert(entries, target, options = {}) {
  const dir = await tmpDir();
  const source = await zipFrom(entries);
  const outPath = path.join(dir, `out-${target}.zip`);
  const report = await convert(source, outPath, { target, ...options });
  return { report, outPath, files: await readZipMap(outPath) };
}

const SECRETS_BYTES = stEntries().find(([name]) => name === 'secrets.json')[1];
const CARD_BYTES = stEntries().find(([name]) => name === 'characters/Fixture Character.png')[1];

describe('convert → st', () => {
  it('l→st:摊平、无 manifest、带 _convert 安装说明、secrets 字节一致、派生缓存丢弃', async () => {
    const { files, report } = await runConvert(lEntries(), TARGETS.ST);
    expect(files.has('manifest.json')).toBe(false);
    expect(files.has('characters/Fixture Character.png')).toBe(true);
    expect(files.has('_convert/INSTALL.md')).toBe(true);
    expect(files.has('_convert/meta.json')).toBe(true);
    expect(Buffer.compare(files.get('secrets.json'), SECRETS_BYTES)).toBe(0);
    expect(files.has('thumbnails/fixture-avatar.png')).toBe(false);
    expect(report.toJSON().dropped.some((d) => d.path.startsWith('thumbnails/'))).toBe(true);
    expect(report.toJSON().dropped.some((d) => d.path === 'manifest.json')).toBe(true);
  });

  it('st→st:角色卡字节恒等往返', async () => {
    const { files } = await runConvert(stEntries(), TARGETS.ST);
    expect(Buffer.compare(files.get('characters/Fixture Character.png'), CARD_BYTES)).toBe(0);
  });
});

describe('convert → l', () => {
  it('l→l:合成 manifest(schemaVersion/handle/selection 全 true),其余条目保留', async () => {
    const { files, report } = await runConvert(lEntries(), TARGETS.L);
    const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.handle).toBe('default-user');
    expect(Object.values(manifest.selection).every(Boolean)).toBe(true);
    expect(files.has('characters/Fixture Character.png')).toBe(true);
    expect(files.has('secrets.json')).toBe(true);
    expect(files.has('extensions/third-party/test-extension/manifest.json')).toBe(true);
    expect(report.toJSON().synthesized).toContain('manifest.json');
  });

  it('st→l:无源 manifest 也合成', async () => {
    const { files } = await runConvert(stEntries(), TARGETS.L);
    expect(JSON.parse(files.get('manifest.json').toString('utf8')).schemaVersion).toBe(1);
  });

  it('l→l 引擎旁路:dump 条目透传', async () => {
    const entries = [
      ...lEntries(),
      ['_engine_dump.bin', Buffer.from('dump-bytes')],
      ['_engine_meta.json', Buffer.from('{"engineKind":"sqlite"}', 'utf8')],
    ];
    const { files } = await runConvert(entries, TARGETS.L);
    expect(files.get('_engine_dump.bin').toString()).toBe('dump-bytes');
    expect(JSON.parse(files.get('_engine_meta.json').toString('utf8')).engineKind).toBe('sqlite');
  });

  it('l→st 引擎旁路:丢弃并警告', async () => {
    const entries = [
      ...lEntries(),
      ['_engine_dump.bin', Buffer.from('dump-bytes')],
      ['_engine_meta.json', Buffer.from('{"engineKind":"sqlite"}', 'utf8')],
    ];
    const { files, report } = await runConvert(entries, TARGETS.ST);
    expect(files.has('_engine_dump.bin')).toBe(false);
    expect(report.toJSON().warnings.join('\n')).toContain('_engine_dump.bin');
  });
});

describe('convert → tt', () => {
  it('st→tt:default-user 前缀、扩展移到 data 根、extension-sources 从 homePage 合成', async () => {
    const { files } = await runConvert(stEntries(), TARGETS.TT);
    expect(files.has('data/default-user/characters/Fixture Character.png')).toBe(true);
    expect(files.has('data/default-user/secrets.json')).toBe(true);
    expect(files.has('data/default-user/settings.json')).toBe(true);
    expect(files.has('data/extensions/third-party/test-extension/manifest.json')).toBe(true);
    const source = JSON.parse(files.get('data/_tauritavern/extension-sources/global/test-extension.json').toString('utf8'));
    expect(source.remote_url).toBe('https://github.com/example/test-extension');
    expect(source.reference).toBe('');
    expect(files.has('data/default-user/thumbnails/fixture-avatar.png')).toBe(false);
  });

  it('tt→tt 规范化:源记录原样保留、私有目录默认丢弃', async () => {
    const { files, report } = await runConvert(ttEntries(), TARGETS.TT);
    const source = JSON.parse(files.get('data/_tauritavern/extension-sources/global/test-extension.json').toString('utf8'));
    expect(source.reference).toBe('main');
    expect(source.installed_commit).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(files.has('data/_cache/derived.bin')).toBe(false);
    expect(files.has('data/content.log')).toBe(false);
    expect(files.has('data/default-user/secrets.json')).toBe(true);
    expect(report.toJSON().dropped.some((d) => d.path === '_cache/derived.bin')).toBe(true);
  });
});

describe('convert → pt', () => {
  it('l→pt:TT 布局 + extension-sources 从 homePage 合成(reference 置空)', async () => {
    const { files } = await runConvert(lEntries(), TARGETS.PT);
    expect(files.has('data/default-user/characters/Fixture Character.png')).toBe(true);
    expect(files.has('data/default-user/secrets.json')).toBe(true);
    expect(files.has('data/extensions/third-party/test-extension/index.js')).toBe(true);
    const source = JSON.parse(files.get('data/_tauritavern/extension-sources/global/test-extension.json').toString('utf8'));
    expect(source.remote_url).toBe('https://github.com/example/test-extension');
    expect(source.reference).toBe('');
    expect(source.installed_commit).toBe('');
  });

  it('tt→pt:来源记录原样保留(更新链不断),缓存丢弃', async () => {
    const { files } = await runConvert(ttEntries(), TARGETS.PT);
    const source = JSON.parse(files.get('data/_tauritavern/extension-sources/global/test-extension.json').toString('utf8'));
    expect(source.remote_url).toBe('https://github.com/example/test-extension');
    expect(source.reference).toBe('main');
    expect(source.installed_commit).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(files.has('data/_cache/derived.bin')).toBe(false);
  });

  it('homePage 非 https:警告且不合成来源记录', async () => {
    const entries = stEntries().map(([name, data]) => {
      if (name === 'extensions/third-party/test-extension/manifest.json') {
        const manifest = JSON.parse(data.toString('utf8'));
        manifest.homePage = 'http://insecure.example';
        return [name, Buffer.from(JSON.stringify(manifest), 'utf8')];
      }
      return [name, data];
    });
    const { files, report } = await runConvert(entries, TARGETS.PT);
    expect(files.has('data/_tauritavern/extension-sources/global/test-extension.json')).toBe(false);
    expect(report.toJSON().warnings.join('\n')).toContain('test-extension');
  });
});

describe('convert → 源 TT 布局 → st/l 的私有元数据', () => {
  it('tt→l:合成 manifest,扩展落位 extensions/third-party,来源记录不进 L 包', async () => {
    const { files } = await runConvert(ttEntries(), TARGETS.L);
    expect(JSON.parse(files.get('manifest.json').toString('utf8')).schemaVersion).toBe(1);
    expect(files.has('extensions/third-party/test-extension/manifest.json')).toBe(true);
    expect(files.has('data/default-user/characters/Fixture Character.png')).toBe(false);
    expect(files.has('_tauritavern/extension-sources/global/test-extension.json')).toBe(false);
  });

  it('tt→st:前缀剥离、secrets 保留', async () => {
    const { files } = await runConvert(ttEntries(), TARGETS.ST);
    expect(files.has('characters/Fixture Character.png')).toBe(true);
    expect(Buffer.compare(files.get('secrets.json'), SECRETS_BYTES)).toBe(0);
    expect(files.has('_cache/derived.bin')).toBe(false);
  });
});

describe('PT 用户级扩展迁移(T1 发现的保真缺口)', () => {
  const userExt = (homePage) => ([
    ['extensions/my-user-ext/manifest.json', Buffer.from(JSON.stringify({
      display_name: 'User Ext', js: 'index.js', homePage,
    }), 'utf8')],
    ['extensions/my-user-ext/index.js', Buffer.from('// user ext', 'utf8')],
  ]);
  const thirdPartyDupe = ([
    ['extensions/third-party/dupe/manifest.json', Buffer.from(JSON.stringify({
      display_name: 'TP Dupe', js: 'index.js', homePage: 'https://github.com/example/dupe',
    }), 'utf8')],
    ['extensions/third-party/dupe/index.js', Buffer.from('// tp dupe', 'utf8')],
  ]);
  const userDupe = ([
    ['extensions/dupe/manifest.json', Buffer.from(JSON.stringify({
      display_name: 'User Dupe', js: 'index.js', homePage: 'https://github.com/example/user-dupe',
    }), 'utf8')],
    ['extensions/dupe/index.js', Buffer.from('// user dupe', 'utf8')],
  ]);

  it('st→pt:用户级扩展迁移为 third-party 布局并合成来源记录', async () => {
    const { files, report } = await runConvert([...stEntries(), ...userExt('https://github.com/example/user-ext')], TARGETS.PT);
    expect(files.has('data/extensions/third-party/my-user-ext/manifest.json')).toBe(true);
    expect(files.has('data/extensions/third-party/my-user-ext/index.js')).toBe(true);
    expect(files.has('data/default-user/extensions/my-user-ext/index.js')).toBe(false);
    const source = JSON.parse(files.get('data/_tauritavern/extension-sources/global/my-user-ext.json').toString('utf8'));
    expect(source.remote_url).toBe('https://github.com/example/user-ext');
    expect(report.toJSON().warnings.join('\n')).toMatch(/已将 2 个用户级/u);
  });

  it('st→pt:与 third-party 同名的用户级扩展被丢弃并保留第三方副本', async () => {
    const { files, report } = await runConvert([...stEntries(), ...thirdPartyDupe, ...userDupe], TARGETS.PT);
    expect(files.has('data/extensions/third-party/dupe/index.js')).toBe(true);
    const manifest = JSON.parse(files.get('data/extensions/third-party/dupe/manifest.json').toString('utf8'));
    expect(manifest.display_name).toBe('TP Dupe');
    expect(files.has('data/default-user/extensions/dupe/index.js')).toBe(false);
    expect(report.toJSON().warnings.join('\n')).toContain('dupe');
  });

  it('st→tt:用户级扩展保持原位(TT 目录表有 extensions)', async () => {
    const { files } = await runConvert([...stEntries(), ...userExt('https://github.com/example/user-ext')], TARGETS.TT);
    expect(files.has('data/default-user/extensions/my-user-ext/manifest.json')).toBe(true);
    expect(files.has('data/extensions/third-party/my-user-ext/manifest.json')).toBe(false);
  });
});

describe('TT 用户目录内的私有变体(T1 发现)', () => {
  const ttWithUserPrivates = () => [
    ...ttEntries(),
    ['data/default-user/tauritavern-settings.json', Buffer.from('{"lanSync":true}', 'utf8')],
    ['data/default-user/user/lan-sync/automation.json', Buffer.from('{}', 'utf8')],
    ['data/default-user/user/cache/index_v1.json', Buffer.from('{}', 'utf8')],
    ['data/default-user/content.log', Buffer.from('log', 'utf8')],
  ];

  it('tt→l:应用私有设置与派生缓存默认丢弃', async () => {
    const { files, report } = await runConvert(ttWithUserPrivates(), TARGETS.L);
    expect(files.has('tauritavern-settings.json')).toBe(false);
    expect(files.has('user/lan-sync/automation.json')).toBe(false);
    expect(files.has('user/cache/index_v1.json')).toBe(false);
    expect(files.has('content.log')).toBe(false);
    const dropped = report.toJSON().dropped.map((d) => d.path);
    expect(dropped).toContain('tauritavern-settings.json');
    expect(dropped).toContain('user/cache/index_v1.json');
  });

  it('tt→tt:应用私有设置原位保留(TT 需要它),派生缓存丢弃', async () => {
    const { files } = await runConvert(ttWithUserPrivates(), TARGETS.TT);
    expect(files.has('data/default-user/tauritavern-settings.json')).toBe(true);
    expect(files.has('data/default-user/user/lan-sync/automation.json')).toBe(true);
    expect(files.has('data/default-user/user/cache/index_v1.json')).toBe(false);
  });

  it('tt→st --keep-all:全部保留在 hub 根', async () => {
    const { files } = await runConvert(ttWithUserPrivates(), TARGETS.ST, { keepAll: true });
    expect(files.has('tauritavern-settings.json')).toBe(true);
    expect(files.has('user/lan-sync/automation.json')).toBe(true);
    expect(files.has('user/cache/index_v1.json')).toBe(true);
    expect(files.has('content.log')).toBe(true);
  });

  it('st→l:third-party 根下散文件对 tt/pt 丢弃、对 l 保留', async () => {
    const withGitkeep = [...stEntries(), ['extensions/third-party/.gitkeep', Buffer.from('', 'utf8')]];
    const toL = await runConvert(withGitkeep, TARGETS.L);
    expect(toL.files.has('extensions/third-party/.gitkeep')).toBe(true);
    const toPt = await runConvert(withGitkeep, TARGETS.PT);
    expect(toPt.files.has('data/extensions/third-party/.gitkeep')).toBe(false);
    expect(toPt.report.toJSON().dropped.some((d) => d.path.endsWith('.gitkeep'))).toBe(true);
  });
});

describe('keep-all', () => {
  it('tt→st --keep-all:派生缓存与 TT 私有目录保留(去 data/ 前缀)', async () => {
    const { files } = await runConvert(ttEntries(), TARGETS.ST, { keepAll: true });
    expect(files.has('thumbnails/fixture-avatar.png')).toBe(true);
    expect(files.has('backups/auto-2026.json')).toBe(true);
    expect(files.has('_cache/derived.bin')).toBe(true);
    expect(files.has('content.log')).toBe(true);
  });

  it('tt→tt --keep-all:私有目录原位保留', async () => {
    const { files } = await runConvert(ttEntries(), TARGETS.TT, { keepAll: true });
    expect(files.has('data/_cache/derived.bin')).toBe(true);
    expect(files.has('data/content.log')).toBe(true);
  });
});

describe('错误处理', () => {
  it('无效目标:抛错', async () => {
    const source = await zipFrom(stEntries());
    await expect(convert(source, path.join(await tmpDir(), 'x.zip'), { target: 'nope' }))
      .rejects.toThrow(/target/);
  });
});
