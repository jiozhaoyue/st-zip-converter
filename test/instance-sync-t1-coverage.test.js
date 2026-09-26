/**
 * T1「包 → 目标覆盖率」判定的回归测试（`scripts/instance-sync/lib/t1-coverage.cjs`）
 *
 * 为什么必须有负例：这条判定是 AC-2「源覆盖率 100%」的**唯一证据来源**。
 * 本仓纪律是「**先证明判定会报差异，再相信它报 100%**」—— 一个恒真的判定等于没有判定。
 * 因此这里同时钉住四件事：
 *   ① 路径命中（多数类目）；
 *   ② ST 角色卡**按宿主落盘名**命中（`characters/<sha256>` → `characters/<角色名>.png`）；
 *   ③ **负例**：落盘名不在目标上时**必须判缺失**（防止规则写成"永远命中"）；
 *   ④ 单列类（合成元数据 / Luker 私有状态）**既不判缺失、也不进分母**。
 *
 * 另附拆壳适配的回归：Luker 的 KV 外壳 → ST 卡片的**名字与版本**推导
 * （2026-09-26 实测过两个真实缺陷：`.png` 剥离顺序写反 ⇒ 落盘成 `孤独摇滚.png.png`；
 * V3 卡只认 `card.name` ⇒ 38 张卡被打回 sha256 兜底名）。
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  compareCoverage,
  targetCharacterNames,
  isHostPrivate,
  classifyPreManifestDeletions,
} = require('../scripts/instance-sync/lib/t1-coverage.cjs');
const { deriveStCharacterUpload, sanitizeHostName, parseLukerKey } = require('../scripts/instance-sync/lib/luker-card-adapter.cjs');

/** 造一条 Luker 的 KV 外壳条目（`value` 本身是一张标准卡片） */
function lukerShell(key, card) {
  return Buffer.from(JSON.stringify({ key, value: JSON.stringify(card) }), 'utf8');
}

describe('T1 覆盖率判定：路径优先、ST 角色卡按落盘名复核', () => {
  it('路径命中即算命中（不触发命名规则）', () => {
    const r = compareCoverage({
      entries: ['chats/a.jsonl', 'worlds/w.json'],
      targetFiles: new Set(['chats/a.jsonl', 'worlds/w.json']),
      stNameMap: null,
    });
    expect(r.missing).toEqual([]);
    expect(r.nameRuleHits).toBe(0);
    expect(r.denominator).toBe(2);
  });

  it('ST 角色卡：路径不同但宿主落盘名在 ⇒ 命中并计入 nameRuleHits', () => {
    const sha = 'characters/'.concat('a'.repeat(64));
    const r = compareCoverage({
      entries: [sha, 'chats/a.jsonl'],
      targetFiles: new Set(['characters/孤独摇滚.png', 'chats/a.jsonl']),
      stNameMap: new Map([[sha, '孤独摇滚']]),
    });
    expect(r.missing).toEqual([]);
    expect(r.nameRuleHits).toBe(1);
    expect(r.denominator).toBe(2);
  });

  it('**负例**：宿主落盘名不在目标上 ⇒ 必须判缺失（规则不得恒真）', () => {
    const sha = 'characters/'.concat('b'.repeat(64));
    const r = compareCoverage({
      entries: [sha],
      targetFiles: new Set(['characters/别的角色.png']),
      stNameMap: new Map([[sha, '孤独摇滚']]),
    });
    expect(r.missing).toEqual([sha]);
    expect(r.nameRuleHits).toBe(0);
  });

  it('**负例**：ST 目标上角色卡子目录（精灵图）不并入落盘名集合', () => {
    const names = targetCharacterNames([
      'characters/Seraphina/anger.png',
      'characters/孤独摇滚.png',
    ]);
    expect([...names]).toEqual(['孤独摇滚']);
  });

  it('单列类既不判缺失、也不进分母', () => {    const r = compareCoverage({
      entries: [
        '_convert/meta.json',
        'manifest.json',
        'characters/x.state.character_editor_assistant.json',
        'chats/a.jsonl',
      ],
      targetFiles: new Set(['chats/a.jsonl']),
      stNameMap: null,
    });
    expect(r.missing).toEqual([]);
    expect(r.missingHostMetadata.sort()).toEqual(['_convert/meta.json', 'manifest.json']);
    expect(r.missingHostPrivate).toEqual(['characters/x.state.character_editor_assistant.json']);
    expect(r.denominator).toBe(1); // 只剩 chats/a.jsonl
  });

  it('Luker 私有状态判据只认 `.state.<编辑器>.json`，不误伤普通卡片', () => {
    expect(isHostPrivate('characters/x.state.character_editor_assistant.json')).toBe(true);
    // 判据**故意取窄**：`.state.` 与 `.json` 之间必须有编辑器名（实测形态就是如此）。
    // 放宽会误伤真名里带 `.state.json` 的角色卡 —— 宁可漏判（会被 T1 报成缺失、暴露出来），
    // 不可误判（静默把真卡片从判定里剔除）。
    expect(isHostPrivate('characters/孤独摇滚.state.json')).toBe(false);
    expect(isHostPrivate('characters/带.state.的名字.json.bak')).toBe(false);
  });
});

describe('T1 链接目录（junction）内的缺失：只报不判', () => {
  const entries = [
    'extensions/ST-BgLoader/src/core/ShortcutManager.ts',
    'chats/正常聊天.jsonl',
  ];

  it('落在链接根下的缺失归入 `missingLinked`，不拉低覆盖率判定', () => {
    const r = compareCoverage({
      entries,
      targetFiles: new Set(['chats/正常聊天.jsonl']),
      stNameMap: null,
      linkedRoots: ['extensions/ST-BgLoader'],
    });
    expect(r.missing).toEqual([]);
    expect(r.missingLinked).toEqual(['extensions/ST-BgLoader/src/core/ShortcutManager.ts']);
  });

  it('**负例**：不在链接根下的缺失仍必须判缺失（口子不得扩大）', () => {
    const r = compareCoverage({
      entries,
      targetFiles: new Set(),
      stNameMap: null,
      linkedRoots: ['extensions/ST-BgLoader'],
    });
    expect(r.missing).toEqual(['chats/正常聊天.jsonl']);
    expect(r.missingLinked.length).toBe(1);
  });

  it('**负例**：同前缀但不同目录（`ST-BgLoaderX/`）不算链接内', () => {
    const r = compareCoverage({
      entries: ['extensions/ST-BgLoaderX/a.ts'],
      targetFiles: new Set(),
      stNameMap: null,
      linkedRoots: ['extensions/ST-BgLoader'],
    });
    expect(r.missing).toEqual(['extensions/ST-BgLoaderX/a.ts']);
    expect(r.missingLinked).toEqual([]);
  });
});

describe('T2b 同步前清单的「零删除」判定：真删除与宿主自管缓存必须分开', () => {
  it('`backups/` 与 `thumbnails/` 归入宿主自管缓存（附原因），不计入「被删」', () => {
    const r = classifyPreManifestDeletions([
      'backups/settings_default-user_20260828-151439.json',
      'thumbnails/avatar/default_Seraphina.png',
    ]);
    expect(r.real).toEqual([]);
    expect(r.hostManaged.map((x) => x.prefix)).toEqual(['backups/', 'thumbnails/']);
    expect(r.hostManaged.every((x) => x.reason.length > 0)).toBe(true);
  });

  it('**负例**：缓存目录之外的一律算真删除（开脱口子不得扩大）', () => {
    const r = classifyPreManifestDeletions([
      'characters/default_Seraphina.png',
      'chats/a/b.jsonl',
      'worlds/我的世界书.json',
      'thumbnailsX/fake.png', // 前缀必须**带斜杠**才算命中目录，`thumbnailsX/` 不是 `thumbnails/`
    ]);
    expect(r.real.sort()).toEqual([
      'characters/default_Seraphina.png',
      'chats/a/b.jsonl',
      'thumbnailsX/fake.png',
      'worlds/我的世界书.json',
    ]);
  });
});

describe('Luker 角色卡拆壳适配（导入器与核对器共用的唯一实现）', () => {
  it('键尾为「原名 + 版本戳」时：先剥版本戳、再剥扩展名（回归：曾剥反 ⇒ `x.png.png`）', () => {
    expect(parseLukerKey('data\\default-user\\characters\\孤独摇滚.png-1771010065094.1455'))
      .toEqual({ avatar: '孤独摇滚', version: 1771010065094, raw: '孤独摇滚.png-1771010065094.1455' });
    // 无扩展名的名字同样成立
    expect(parseLukerKey('data/default-user/characters/武藏信浓-1762933461198.726').avatar).toBe('武藏信浓');
  });

  it('V2 卡（名字在 `name`）与 V3 卡（名字在 `data.name`）都能取到角色名', () => {
    const v2 = deriveStCharacterUpload(
      lukerShell('data\\default-user\\characters\\甲.png-1700000000000.1', { name: '甲', description: '' }),
      'deadbeef',
    );
    expect(v2.avatar).toBe('甲');
    expect(v2.fileName).toBe('甲.json');
    expect(v2.version).toBe(1700000000000);

    const v3 = deriveStCharacterUpload(
      lukerShell('data\\default-user\\characters\\乙.png-1700000000001.2', {
        spec: 'chara_card_v3', data: { name: '乙' },
      }),
      'deadbeef',
    );
    expect(v3.avatar).toBe('乙'); // 回归：曾只认 card.name，V3 卡被打回 sha256
  });

  it('`data/_uploads/` 的键尾是上传号 ⇒ 退回卡片自己的名字（不落无名 sha 文件）', () => {
    const up = deriveStCharacterUpload(
      lukerShell('data/_uploads/eb481fb751233315783ff3921ce45603-1775053336443.9421', { name: '【Sgw】又看一集' }),
      'eb481fb751233315783ff3921ce45603',
    );
    expect(up.avatar).toBe('【Sgw】又看一集');
  });

  it('宿主不可落盘的字符被收敛（Windows 非法字符 / 保留设备名 / 超长）', () => {
    expect(sanitizeHostName('a<b>c:d"e/f\\g|h?i*j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(sanitizeHostName('CON')).toBe('_CON');
    expect(sanitizeHostName('  尾部点被吞.  ')).toBe('尾部点被吞');
    const long = '长'.repeat(300);
    const out = sanitizeHostName(long);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(sanitizeHostName(long)).toBe(out); // 确定性
    expect(sanitizeHostName(`${long}x`)).not.toBe(out); // 不同长名不截成同一个（带短哈希）
  });
});
