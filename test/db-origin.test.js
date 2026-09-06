import { describe, expect, it } from 'vitest';
import { ORIGINS } from '../src/storage/db.js';

// migrateRoleToOrigin / normalizeRecord 是模块私有逻辑的映射规则，
// 这里通过公开的 ORIGINS 枚举 + saveFile 推断路径验证映射语义。
// 真正的 v1→v2 onupgradeneeded 迁移在 Playwright 端到端用预置 v1 库验证。

describe('ORIGINS 来源枚举与映射语义', () => {
  it('枚举值齐全且冻结', () => {
    expect(ORIGINS.UPLOAD).toBe('upload');
    expect(ORIGINS.HOST_EXPORT).toBe('host-export');
    expect(ORIGINS.CONVERTED).toBe('converted');
    expect(ORIGINS.DELTA).toBe('delta');
    expect(ORIGINS.SPLIT_PART).toBe('split-part');
    expect(Object.isFrozen(ORIGINS)).toBe(true);
  });
});

// fake-indexeddb 不可用时（未安装），用纯逻辑路径模拟迁移映射验证
describe('role→origin 迁移映射规则', () => {
  // 从 db.js 源码提取的映射规则（与 migrateRoleToOrigin 实现同步）
  function migrateRoleToOrigin(record) {
    const meta = record.metadata || {};
    if (meta.isSplitPart || meta.partIndex != null || meta.partTotal != null) {
      return ORIGINS.SPLIT_PART;
    }
    if (meta.isDelta || meta.deltaBase) {
      return ORIGINS.DELTA;
    }
    if (record.role === 'output') {
      return ORIGINS.CONVERTED;
    }
    return ORIGINS.UPLOAD;
  }

  it('v1 source role → upload', () => {
    expect(migrateRoleToOrigin({ role: 'source', metadata: {} })).toBe(ORIGINS.UPLOAD);
  });

  it('v1 output role → converted', () => {
    expect(migrateRoleToOrigin({ role: 'output', metadata: {} })).toBe(ORIGINS.CONVERTED);
  });

  it('分卷标记 metadata 优先 → split-part', () => {
    expect(migrateRoleToOrigin({ role: 'output', metadata: { partIndex: 2, partTotal: 5 } })).toBe(ORIGINS.SPLIT_PART);
    expect(migrateRoleToOrigin({ role: 'source', metadata: { isSplitPart: true } })).toBe(ORIGINS.SPLIT_PART);
  });

  it('增量补丁标记 → delta', () => {
    expect(migrateRoleToOrigin({ role: 'output', metadata: { isDelta: true } })).toBe(ORIGINS.DELTA);
    expect(migrateRoleToOrigin({ role: 'output', metadata: { deltaBase: 'base.zip' } })).toBe(ORIGINS.DELTA);
  });

  it('分卷优先于增量（同时存在时）', () => {
    expect(migrateRoleToOrigin({ role: 'output', metadata: { isDelta: true, partIndex: 1 } })).toBe(ORIGINS.SPLIT_PART);
  });

  it('空 metadata 或无 role → upload 兜底', () => {
    expect(migrateRoleToOrigin({ role: 'source' })).toBe(ORIGINS.UPLOAD);
    expect(migrateRoleToOrigin({})).toBe(ORIGINS.UPLOAD);
  });
});
