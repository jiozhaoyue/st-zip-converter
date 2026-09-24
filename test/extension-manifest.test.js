import { describe, expect, it } from 'vitest';
import {
  AVAILABILITY,
  MANIFEST_SCHEMA_VERSION,
  SOURCE_KIND,
  buildExtensionManifest,
  buildOfficialIndex,
  deriveExtensionEntry,
  extensionFolderName,
  extensionRelativePath,
  extractGitBranch,
  extractGitRemoteUrl,
  isInstallableUrl,
  normalizeManifestEntries,
  shouldAutoOpenInstaller,
} from '../src/core/extension-manifest.js';

/**
 * 扩展清单契约（schema v2）单测。
 * 契约定义见 .trellis/tasks/09-23-extension-manifest-git/design.md §2。
 */

const GIT_META = { remoteUrl: 'https://github.com/example/ext.git', branch: 'main', commit: 'a'.repeat(40) };

describe('isInstallableUrl（与 escape.js 的 isSafeHttpUrl 同规则）', () => {
  it('放行 http / https（大小写不敏感、容忍首尾空白）', () => {
    expect(isInstallableUrl('https://github.com/a/b')).toBe(true);
    expect(isInstallableUrl('http://example.com/x')).toBe(true);
    expect(isInstallableUrl('  https://example.com/x  ')).toBe(true);
    expect(isInstallableUrl('HTTPS://EXAMPLE.COM/X')).toBe(true);
  });

  it('拒绝危险协议与非法输入', () => {
    expect(isInstallableUrl('javascript:alert(1)')).toBe(false);
    expect(isInstallableUrl('data:text/html,<script>1</script>')).toBe(false);
    expect(isInstallableUrl('vbscript:msgbox(1)')).toBe(false);
    expect(isInstallableUrl('file:///etc/passwd')).toBe(false);
    expect(isInstallableUrl('')).toBe(false);
    expect(isInstallableUrl(null)).toBe(false);
    expect(isInstallableUrl(undefined)).toBe(false);
    expect(isInstallableUrl(123)).toBe(false);
    expect(isInstallableUrl({})).toBe(false);
  });
});

describe('派生规则：sourceKind', () => {
  it('gitMeta.remoteUrl 优先 → git', () => {
    const entry = deriveExtensionEntry({
      name: 'ext', manifest: { homePage: 'https://homepage.example' }, gitMeta: GIT_META, mode: 'manifest',
    });
    expect(entry.sourceKind).toBe(SOURCE_KIND.GIT);
    expect(entry.url).toBe(GIT_META.remoteUrl);
  });

  it('无 gitMeta 时取 sourceRecord.remote_url → 仍标 git', () => {
    const entry = deriveExtensionEntry({
      name: 'ext', manifest: {}, sourceRecord: { remote_url: 'https://github.com/r/s.git' }, mode: 'manifest',
    });
    expect(entry.sourceKind).toBe(SOURCE_KIND.GIT);
    expect(entry.url).toBe('https://github.com/r/s.git');
  });

  it('只有 manifest.homePage 时 → homepage', () => {
    const entry = deriveExtensionEntry({
      name: 'ext', manifest: { homePage: 'https://example.com/ext' }, mode: 'manifest',
    });
    expect(entry.sourceKind).toBe(SOURCE_KIND.HOMEPAGE);
  });

  it('三者皆无 → unknown 且 url 为空', () => {
    const entry = deriveExtensionEntry({ name: 'ext', manifest: {}, mode: 'manifest' });
    expect(entry.sourceKind).toBe(SOURCE_KIND.UNKNOWN);
    expect(entry.url).toBe('');
  });
});

describe('派生规则：availability', () => {
  it('FULL 模式恒为 embedded（包内已有实体）', () => {
    const withUrl = deriveExtensionEntry({ name: 'a', gitMeta: GIT_META, mode: 'full' });
    const noUrl = deriveExtensionEntry({ name: 'b', manifest: {}, mode: 'full' });
    expect(withUrl.availability).toBe(AVAILABILITY.EMBEDDED);
    expect(noUrl.availability).toBe(AVAILABILITY.EMBEDDED);
  });

  it('MANIFEST 模式 + 可用 URL → installable', () => {
    const entry = deriveExtensionEntry({ name: 'a', gitMeta: GIT_META, mode: 'manifest' });
    expect(entry.availability).toBe(AVAILABILITY.INSTALLABLE);
  });

  it('MANIFEST 模式 + 无 URL → unavailable', () => {
    const entry = deriveExtensionEntry({ name: 'a', manifest: {}, mode: 'manifest' });
    expect(entry.availability).toBe(AVAILABILITY.UNAVAILABLE);
  });

  it('MANIFEST 模式 + 非 http URL → unavailable（homePage 是恶意协议时）', () => {
    const entry = deriveExtensionEntry({
      name: 'a', manifest: { homePage: 'javascript:alert(1)' }, mode: 'manifest',
    });
    expect(entry.availability).toBe(AVAILABILITY.UNAVAILABLE);
    expect(entry.sourceKind).toBe(SOURCE_KIND.HOMEPAGE);
  });
});

describe('派生规则：notes', () => {
  it('unavailable 时给出「无法在线安装」提示', () => {
    const entry = deriveExtensionEntry({ name: 'a', manifest: {}, mode: 'manifest' });
    expect(entry.notes).toContain('无法在线安装');
  });

  it('homepage 来源 + 可安装时提示「可能失败」', () => {
    const entry = deriveExtensionEntry({
      name: 'a', manifest: { homePage: 'https://example.com/ext' }, mode: 'manifest',
    });
    expect(entry.notes).toContain('扩展主页而非 Git 仓库');
  });

  it('git 来源 + 可安装时不产生 notes 字段', () => {
    const entry = deriveExtensionEntry({ name: 'a', gitMeta: GIT_META, mode: 'manifest' });
    expect(entry.notes).toBeUndefined();
  });

  it('embedded 条目不带 notes（包内已有实体，无需提示）', () => {
    const entry = deriveExtensionEntry({ name: 'a', manifest: {}, mode: 'full' });
    expect(entry.notes).toBeUndefined();
  });
});

describe('buildExtensionManifest（私有清单）', () => {
  const inputs = [
    { name: 'with-git', manifest: { display_name: 'With Git' }, gitMeta: GIT_META, sourceRecord: {} },
    { name: 'no-url', manifest: { display_name: 'No URL' }, gitMeta: {}, sourceRecord: {} },
  ];

  it('带 schemaVersion 2 与 mode/total/converter 顶层字段', () => {
    const m = buildExtensionManifest({ extensions: inputs, mode: 'manifest', generatedAt: '2020-01-01T00:00:00.000Z' });
    expect(m.converter).toBe('st-zip-converter');
    expect(m.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(m.schemaVersion).toBe(2);
    expect(m.mode).toBe('manifest');
    expect(m.total).toBe(2);
    expect(m.generatedAt).toBe('2020-01-01T00:00:00.000Z');
  });

  it('条目状态按模式派生（同名输入，两种模式产出不同 availability）', () => {
    const asManifest = buildExtensionManifest({ extensions: inputs, mode: 'manifest', generatedAt: 'x' });
    const asFull = buildExtensionManifest({ extensions: inputs, mode: 'full', generatedAt: 'x' });
    expect(asManifest.extensions.map((e) => e.availability))
      .toEqual([AVAILABILITY.INSTALLABLE, AVAILABILITY.UNAVAILABLE]);
    expect(asFull.extensions.map((e) => e.availability))
      .toEqual([AVAILABILITY.EMBEDDED, AVAILABILITY.EMBEDDED]);
  });

  it('保留原始 manifest 字段供恢复端参考', () => {
    const m = buildExtensionManifest({ extensions: inputs, mode: 'manifest', generatedAt: 'x' });
    expect(m.extensions[0].manifest.display_name).toBe('With Git');
  });

  it('空扩展列表产出 total 0（调用方据此不写文件）', () => {
    const m = buildExtensionManifest({ extensions: [], mode: 'manifest', generatedAt: 'x' });
    expect(m.total).toBe(0);
    expect(m.extensions).toEqual([]);
  });
});

describe('buildOfficialIndex（官方索引，仅 MANIFEST 产出）', () => {
  it('过滤 unavailable 条目（写入空 URL 会让宿主 Content Downloader 报错）', () => {
    const index = buildOfficialIndex([
      { id: 'ok', name: 'ok', displayName: 'OK', description: '', url: 'https://github.com/a/b', branch: 'main', commit: '', type: 'extension', availability: AVAILABILITY.INSTALLABLE },
      { id: 'bad', name: 'bad', displayName: 'Bad', description: '', url: '', branch: 'main', commit: '', type: 'extension', availability: AVAILABILITY.UNAVAILABLE },
    ]);
    expect(index.extension).toHaveLength(1);
    expect(index.extension[0].id).toBe('ok');
  });

  it('全部不可安装时返回 null（调用方跳过写文件）', () => {
    const index = buildOfficialIndex([
      { id: 'a', name: 'a', displayName: 'A', description: '', url: '', branch: 'main', commit: '', type: 'extension', availability: AVAILABILITY.UNAVAILABLE },
    ]);
    expect(index).toBeNull();
  });

  it('embedded 条目不写入官方索引（避免宿主对包内实体重复安装）', () => {
    const index = buildOfficialIndex([
      { id: 'emb', name: 'emb', displayName: 'Emb', description: '', url: 'https://github.com/a/b', branch: 'main', commit: '', type: 'extension', availability: AVAILABILITY.EMBEDDED },
    ]);
    expect(index).toBeNull();
  });

  it('只输出官方字段集，不泄漏 availability/manifest 等私有字段', () => {
    const index = buildOfficialIndex([
      { id: 'ok', name: 'ok', displayName: 'OK', description: 'd', url: 'https://github.com/a/b', branch: 'main', commit: 'c', type: 'extension', availability: AVAILABILITY.INSTALLABLE, manifest: { secret: 1 }, sourceKind: 'git' },
    ]);
    expect(Object.keys(index.extension[0]).sort())
      .toEqual(['branch', 'commit', 'description', 'id', 'name', 'type', 'url']);
  });
});

describe('normalizeManifestEntries（恢复端归一）', () => {
  it('v1 旧清单（无 availability）按 mode 推断——manifest 模式', () => {
    const entries = normalizeManifestEntries({
      mode: 'manifest',
      extensions: [
        { name: 'has-url', url: 'https://github.com/a/b' },
        { name: 'no-url', url: '' },
      ],
    });
    expect(entries[0].availability).toBe(AVAILABILITY.INSTALLABLE);
    expect(entries[1].availability).toBe(AVAILABILITY.UNAVAILABLE);
  });

  it('缺 mode 字段时按 MANIFEST 推断（v1 清单本就只有 MANIFEST 模式产出）', () => {
    const entries = normalizeManifestEntries({
      extensions: [{ name: 'a', url: '' }],
    });
    expect(entries[0].availability).toBe(AVAILABILITY.UNAVAILABLE);
  });

  it('非法 availability 取值回退到推断规则', () => {
    const entries = normalizeManifestEntries({
      mode: 'manifest',
      extensions: [{ name: 'a', url: 'https://github.com/a/b', availability: 'weird-value' }],
    });
    expect(entries[0].availability).toBe(AVAILABILITY.INSTALLABLE);
  });

  it('非 http(s) URL 强制 unavailable，即便声明为 installable', () => {
    const entries = normalizeManifestEntries({
      mode: 'manifest',
      extensions: [{ name: 'a', url: 'javascript:alert(1)', availability: AVAILABILITY.INSTALLABLE }],
    });
    expect(entries[0].availability).toBe(AVAILABILITY.UNAVAILABLE);
  });

  it('embedded 条目不被 URL 规则降级（包内实体与 URL 无关）', () => {
    const entries = normalizeManifestEntries({
      mode: 'full',
      extensions: [{ name: 'a', url: '', availability: AVAILABILITY.EMBEDDED }],
    });
    expect(entries[0].availability).toBe(AVAILABILITY.EMBEDDED);
  });

  it('畸形输入安全兜底（非对象 / extensions 非数组 / 条目非对象）', () => {
    expect(normalizeManifestEntries(null)).toEqual([]);
    expect(normalizeManifestEntries('nope')).toEqual([]);
    expect(normalizeManifestEntries({ extensions: 'nope' })).toEqual([]);
    expect(normalizeManifestEntries({ extensions: [null, 'x', 123] })).toEqual([]);
  });

  it('兼容 id 缺 name 的条目，并补齐展示字段', () => {
    const entries = normalizeManifestEntries({
      mode: 'manifest',
      extensions: [{ id: 'by-id', url: 'https://github.com/a/b' }],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('by-id');
    expect(entries[0].displayName).toBe('by-id');
    expect(entries[0].branch).toBe('main');
    expect(entries[0].type).toBe('extension');
  });

  it('notes 非字符串时归一为空串（渲染端据此跳过）', () => {
    const entries = normalizeManifestEntries({
      mode: 'manifest',
      extensions: [{ name: 'a', url: '', notes: { bad: true } }],
    });
    expect(entries[0].notes).toBe('');
  });
});

describe('shouldAutoOpenInstaller（决策 D-4：仅可安装项才弹窗）', () => {
  it('存在 installable 条目 → true', () => {
    expect(shouldAutoOpenInstaller([
      { availability: AVAILABILITY.EMBEDDED },
      { availability: AVAILABILITY.INSTALLABLE },
    ])).toBe(true);
  });

  it('全部 embedded → false（不打扰用户）', () => {
    expect(shouldAutoOpenInstaller([
      { availability: AVAILABILITY.EMBEDDED },
      { availability: AVAILABILITY.EMBEDDED },
    ])).toBe(false);
  });

  it('全部 unavailable → false', () => {
    expect(shouldAutoOpenInstaller([{ availability: AVAILABILITY.UNAVAILABLE }])).toBe(false);
  });

  it('空数组 / 非数组 → false', () => {
    expect(shouldAutoOpenInstaller([])).toBe(false);
    expect(shouldAutoOpenInstaller(null)).toBe(false);
  });
});

describe('路径与 Git 解析 helper（自 transform.js 迁入）', () => {
  it('extensionFolderName 取扩展目录名', () => {
    expect(extensionFolderName('extensions/my-ext/index.js')).toBe('my-ext');
    expect(extensionFolderName('extensions/my-ext')).toBe('my-ext');
    expect(extensionFolderName('characters/x.png')).toBe('');
  });

  it('extensionRelativePath 取扩展内相对路径', () => {
    expect(extensionRelativePath('extensions/my-ext/.git/config')).toBe('.git/config');
    expect(extensionRelativePath('extensions/my-ext')).toBe('my-ext');
    expect(extensionRelativePath('characters/x.png')).toBe('');
  });

  it('extractGitRemoteUrl 优先 origin，其次任意 url', () => {
    const config = '[remote "origin"]\n\turl = https://github.com/a/b.git\n';
    expect(extractGitRemoteUrl(config)).toBe('https://github.com/a/b.git');
    expect(extractGitRemoteUrl('[remote "upstream"]\n\turl = https://github.com/u/v.git\n'))
      .toBe('https://github.com/u/v.git');
    expect(extractGitRemoteUrl('')).toBeNull();
  });

  it('extractGitBranch 解析 refs/heads 引用', () => {
    expect(extractGitBranch('ref: refs/heads/main\n')).toBe('main');
    expect(extractGitBranch('ref: refs/heads/feature/x\n')).toBe('feature/x');
    expect(extractGitBranch('')).toBeNull();
  });
});
