import { describe, expect, it } from 'vitest';
import {
  AVAILABILITY,
  normalizeManifestEntries,
  shouldAutoOpenInstaller,
} from '../src/core/extension-manifest.js';

/**
 * 恢复端清单引导语义单测（决策 D-4 / D-6）。
 *
 * 覆盖「包内清单 → 三态分类 → 是否自动弹出安装器」这条纯逻辑链路。
 * `renderExtensionInstallerModal` 的 DOM 渲染需 `document`，不在 Node 环境下断言；
 * 其输入契约由本文件与 `test/extension-manifest.test.js` 共同锁定。
 *
 * 需求见 .trellis/tasks/09-23-extension-manifest-git/design.md §5.2 / §5.3。
 */

/** 模拟 FULL 包内清单（扩展实体已随恢复写入，无可安装项） */
const FULL_MANIFEST = {
  converter: 'st-zip-converter',
  schemaVersion: 2,
  mode: 'full',
  total: 2,
  extensions: [
    { id: 'ext-a', name: 'ext-a', displayName: 'Ext A', url: 'https://github.com/a/b', availability: 'embedded' },
    { id: 'ext-b', name: 'ext-b', displayName: 'Ext B', url: '', availability: 'embedded' },
  ],
};

/** 模拟 MANIFEST 包（混合可安装 / 不可安装） */
const MIXED_MANIFEST = {
  converter: 'st-zip-converter',
  schemaVersion: 2,
  mode: 'manifest',
  total: 3,
  extensions: [
    { id: 'ok', name: 'ok', displayName: 'OK', url: 'https://github.com/a/b', availability: 'installable' },
    { id: 'no-url', name: 'no-url', displayName: 'No URL', url: '', availability: 'unavailable' },
    { id: 'evil', name: 'evil', displayName: 'Evil', url: 'javascript:alert(1)', availability: 'installable' },
  ],
};

describe('恢复端：FULL 包不应自动弹窗（决策 D-4 / D-6）', () => {
  it('全部 embedded → 不自动弹窗', () => {
    const entries = normalizeManifestEntries(FULL_MANIFEST);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.availability === AVAILABILITY.EMBEDDED)).toBe(true);
    expect(shouldAutoOpenInstaller(entries)).toBe(false);
  });

  it('FULL 包的清单不产生官方索引语义（全部可安装 URL 也不弹窗）', () => {
    // 即便 URL 全部合法，embedded 状态也压过可安装性
    const entries = normalizeManifestEntries(FULL_MANIFEST);
    expect(entries[0].url).toBe('https://github.com/a/b');
    expect(shouldAutoOpenInstaller(entries)).toBe(false);
  });
});

describe('恢复端：MANIFEST 包的三态分类', () => {
  it('分类计数正确（installable 1 / unavailable 2）', () => {
    const entries = normalizeManifestEntries(MIXED_MANIFEST);
    const count = (state) => entries.filter((e) => e.availability === state).length;
    expect(count(AVAILABILITY.INSTALLABLE)).toBe(1);
    expect(count(AVAILABILITY.UNAVAILABLE)).toBe(2);
    expect(count(AVAILABILITY.EMBEDDED)).toBe(0);
  });

  it('恶意 URL 在归一阶段就被降级为 unavailable（而非等点击才失败）', () => {
    const entries = normalizeManifestEntries(MIXED_MANIFEST);
    const evil = entries.find((e) => e.name === 'evil');
    expect(evil.availability).toBe(AVAILABILITY.UNAVAILABLE);
  });

  it('存在可安装项 → 自动弹窗', () => {
    expect(shouldAutoOpenInstaller(normalizeManifestEntries(MIXED_MANIFEST))).toBe(true);
  });

  it('无可安装项的 MANIFEST 包（全无 URL）→ 不弹窗', () => {
    const entries = normalizeManifestEntries({
      mode: 'manifest',
      extensions: [{ name: 'a', url: '' }, { name: 'b', url: 'ftp://example.com/x' }],
    });
    expect(shouldAutoOpenInstaller(entries)).toBe(false);
  });
});

describe('恢复端：向后兼容（v1 旧包）', () => {
  it('v1 清单（无 schemaVersion / 无 availability）仍可读且可安装', () => {
    const v1 = {
      converter: 'st-zip-converter',
      mode: 'manifest',
      total: 1,
      extensions: [{
        id: 'legacy', name: 'legacy', displayName: 'Legacy', url: 'https://github.com/a/b', branch: 'main',
      }],
    };
    const entries = normalizeManifestEntries(v1);
    expect(entries[0].availability).toBe(AVAILABILITY.INSTALLABLE);
    expect(entries[0].sourceKind).toBe('git');
    expect(shouldAutoOpenInstaller(entries)).toBe(true);
  });

  it('旧包的畸形条目被剔除，不影响其余条目（防御性）', () => {
    const entries = normalizeManifestEntries({
      mode: 'manifest',
      extensions: [
        null,
        { id: 'good', name: 'good', url: 'https://github.com/a/b' },
        { notName: true },
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('good');
  });
});
