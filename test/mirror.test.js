import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ZipReader } from '../src/core/read.js';
import { ZipWriter } from '../src/core/write.js';
import { nodeIo } from '../src/io/node-io.js';
import { convert, TARGETS } from '../src/core/transform.js';
import { stEntries, lEntries, ttEntries } from '../fixtures/gen.js';

/**
 * 镜像测试:不启动任何平台,把 PT / L 的导入路由规则抽成断言,
 * 对转换产物逐条目验证"目标平台会把它路由到预期位置"。
 * 证据:research/platform-facts.md §3/§4。
 */

const tmpDirs = [];

async function tmpDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tavern-convert-mirror-'));
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

async function convertFixture(entries, target) {
  const source = await zipFrom(entries);
  const dir = await tmpDir();
  const outPath = path.join(dir, `out-${target}.zip`);
  await convert(source, outPath, { target, io: nodeIo });
  return readZipMap(outPath);
}

// ---- PT 侧镜像(tauri-tavern-import.ts routeExtensionFile + readUserPath 语义) ----

function classifyPtEntry(fileName) {
  if (fileName.startsWith('data/default-user/')) return 'user';
  if (fileName.startsWith('data/extensions/third-party/')) return 'extension-package';
  if (fileName.startsWith('data/_tauritavern/extension-sources/')) return 'extension-source';
  if (fileName.startsWith('data/')) return 'unsupported'; // PT 会忽略或丢弃
  return 'unsupported'; // 摊平条目 PT 的 readUserPath 返回 null → 整个不可见
}

function routeExtensionSource(fileName) {
  // PT: scope/name.json,非 json 直接丢
  const rest = fileName.slice('data/_tauritavern/extension-sources/'.length);
  const separator = rest.indexOf('/');
  if (separator <= 0) return null;
  const name = rest.slice(separator + 1);
  return name.endsWith('.json') ? { scope: rest.slice(0, separator), name: name.slice(0, -'.json'.length) } : null;
}

describe('PT 目标:tauri-tavern 导入器路由镜像', () => {
  it('l→pt:每个条目都落进 PT 可识别的三个根之一', async () => {
    const files = await convertFixture(lEntries(), TARGETS.PT);
    for (const fileName of files.keys()) {
      const kind = classifyPtEntry(fileName);
      expect(kind, `${fileName} 会被 PT 丢弃`).not.toBe('unsupported');
    }
  });

  it('l→pt:default-user 内层与 ST 用户目录同构(逐字目录名)', async () => {
    const files = await convertFixture(lEntries(), TARGETS.PT);
    // PT data-tree.ts:目录名必须与 ST USER_DIRECTORY_TEMPLATE 逐字一致
    expect(files.has('data/default-user/characters/Fixture Character.png')).toBe(true);
    expect(files.has('data/default-user/chats/Fixture Character/2026-09-01.jsonl')).toBe(true);
    expect(files.has('data/default-user/worlds/fixture-world.json')).toBe(true);
    expect(files.has('data/default-user/User Avatars/fixture-avatar.png')).toBe(true);
    expect(files.has('data/default-user/settings.json')).toBe(true);
    expect(files.has('data/default-user/secrets.json')).toBe(true);
    expect(files.has('data/default-user/OpenAI Settings/fixture-preset.json')).toBe(true);
  });

  it('l→pt:每个第三方扩展都有合法来源记录(缺记录时由 homePage 兜底)', async () => {
    const files = await convertFixture(lEntries(), TARGETS.PT);
    const folders = new Set(
      [...files.keys()]
        .filter((name) => name.startsWith('data/extensions/third-party/'))
        .map((name) => name.slice('data/extensions/third-party/'.length).split('/')[0]),
    );
    const sources = new Map();
    for (const [fileName, data] of files) {
      if (classifyPtEntry(fileName) !== 'extension-source') continue;
      const routed = routeExtensionSource(fileName);
      expect(routed, `${fileName} 应能被 PT 的来源路由解析`).not.toBeNull();
      const record = JSON.parse(data.toString('utf8'));
      expect(typeof record.remote_url).toBe('string');
      expect(record.remote_url).toMatch(/^https:\/\//iu);
      sources.set(routed.name, record);
    }
    for (const folder of folders) {
      expect(sources.has(folder), `扩展 ${folder} 缺来源记录,PT 将跳过它`).toBe(true);
    }
  });

  it('tt→pt:源记录原样可解析,缓存类目录不进包', async () => {
    const files = await convertFixture(ttEntries(), TARGETS.PT);
    for (const fileName of files.keys()) {
      expect(classifyPtEntry(fileName), fileName).not.toBe('unsupported');
    }
    const source = JSON.parse(files.get('data/_tauritavern/extension-sources/global/test-extension.json').toString('utf8'));
    expect(source.reference).toBe('main');
    expect(files.has('data/_cache/derived.bin')).toBe(false);
  });
});

// ---- L 侧镜像(users-private.js resolveAllowedRestorePath 后缀匹配语义) ----

const L_ALLOWED_FILES = new Set(['settings.json', 'secrets.json']);
const L_ALLOWED_DIRS = [
  'backups', // settings 类目包含 backups(users.js:1370)
  'characters', 'User Avatars', 'backgrounds',
  'chats', 'groups', 'group chats',
  'worlds',
  'NovelAI Settings', 'KoboldAI Settings', 'OpenAI Settings', 'TextGen Settings',
  'instruct', 'context', 'sysprompt', 'reasoning', 'themes', 'movingUI', 'QuickReplies',
  'assets', 'backgrounds', 'user/files', 'user/images', 'user/workflows',
  'extensions',
  'vectors',
];
// L 对 globalExtensions 目录的别名(users-private.js buildRestoreDirectoryAliases)
const L_EXTENSION_ALIASES = [
  'public/scripts/extensions/third-party',
  'scripts/extensions/third-party',
  'extensions/third-party',
  'third-party',
];

function lResolve(entryPath) {
  const parts = entryPath.split('/').filter(Boolean);
  const candidates = [];
  for (let index = 0; index < parts.length; index++) {
    const candidate = parts.slice(index).join('/');
    if (candidate && candidate !== 'manifest.json') candidates.push(candidate);
  }
  for (const candidate of candidates) {
    if (L_ALLOWED_FILES.has(candidate)) return 'file';
    for (const dir of L_ALLOWED_DIRS) {
      if (candidate === dir || candidate.startsWith(`${dir}/`)) return 'dir';
    }
    for (const alias of L_EXTENSION_ALIASES) {
      if (candidate.startsWith(`${alias}/`)) return 'global-extension';
    }
  }
  return null;
}

describe('L 目标:restoreUserBackupArchive 后缀匹配镜像', () => {
  it('l→l:每个条目都能命中 L 的恢复目标(否则 L 会静默跳过它)', async () => {
    const files = await convertFixture(lEntries(), TARGETS.L);
    // manifest.json 是 L 导出格式的标记与保真元数据,L 导入时按其规则跳过(
    // resolveAllowedRestorePath 显式排除),不算数据丢失。
    const misses = [...files.keys()].filter((name) => name !== 'manifest.json' && lResolve(name) === null);
    expect(misses, `以下条目 L 恢复时不会落地: ${misses.join(', ')}`).toEqual([]);
  });

  it('tt→l:剥前缀后同样全部命中', async () => {
    const files = await convertFixture(ttEntries(), TARGETS.L);
    const misses = [...files.keys()].filter((name) => name !== 'manifest.json' && lResolve(name) === null);
    expect(misses, `以下条目 L 恢复时不会落地: ${misses.join(', ')}`).toEqual([]);
  });
});
