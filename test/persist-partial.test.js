import { describe, expect, it, vi } from 'vitest';
import { persistPartial, partialNameFor, hasRoomForPartial } from '../index.js';
import { logger } from '../src/core/logger.js';

/**
 * 半成品持久化（真增量续传的**持久化段**）。
 *
 * 契约要点（都在用例里锁住）：
 *  - 成功 ⇒ zip 落盘 + 写**暂停态专用断点**，且**顺序不可颠倒**（先 zip 后断点）；
 *  - 任一失败 ⇒ 一律降级为「没有半成品」，返回 `{ok:false, reason}`，**且留一行可观测日志**
 *    （静默降级同样是缺陷：用户点「继续」却整包重跑却毫无解释）；
 *  - 失败路径**绝不**写断点（否则断点指向一个不存在的半成品）。
 */

function makeDeps({ opfs = true, quota = true, handle = true, writeFails = false } = {}) {
  const chunks = [];
  const written = [];
  const deps = {
    supportsOpfs: () => opfs,
    quotaCheck: async () => quota,
    opfsTmpHandle: async () => {
      if (!handle) return null;
      return {
        async createWritable() {
          return {
            async write(b) {
              if (writeFails) throw new Error('磁盘写失败');
              chunks.push(b);
            },
            async close() { written.push('closed'); },
          };
        },
      };
    },
  };
  return { deps, chunks, written };
}

const base = () => ({
  partialBlob: new Blob([new Uint8Array([1, 2, 3])]),
  manifest: [{ name: 'a.txt', crc32: 7 }, { name: 'b.png', crc32: 9 }],
  taskId: 'convert-123',
  target: 'st',
  totalBytes: 4096,
});

describe('persistPartial（半成品持久化 + 暂停态断点）', () => {
  it('成功：半成品写入内容正确，断点带 partialOpfsName 与半成品清单', async () => {
    const { deps, chunks, written } = makeDeps();
    const seen = [];
    const res = await persistPartial({
      ...base(),
      setPauseCheckpoint: async (m) => { seen.push(m); return true; },
      deps,
    });

    expect(res).toEqual({ ok: true, name: partialNameFor('convert-123') });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBeInstanceOf(Blob);
    expect(chunks[0].size).toBe(3);
    expect(written).toEqual(['closed']);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      partialOpfsName: 'convert-123.partial.zip',
      target: 'st',
      partialEntries: [{ name: 'a.txt', crc32: 7 }, { name: 'b.png', crc32: 9 }],
      totalEntries: 4096,
    });
  });

  it('顺序纪律：断点**只能在半成品落盘之后**写（zip 未落盘就写断点 = 指向不存在的半成品）', async () => {
    const order = [];
    const deps = {
      supportsOpfs: () => true,
      quotaCheck: async () => true,
      opfsTmpHandle: async () => ({
        async createWritable() {
          return { async write() { order.push('zip-write'); }, async close() { order.push('zip-close'); } };
        },
      }),
    };
    await persistPartial({
      ...base(),
      setPauseCheckpoint: async () => { order.push('checkpoint'); return true; },
      deps,
    });
    expect(order).toEqual(['zip-write', 'zip-close', 'checkpoint']);
  });

  it('无半成品 / 不支持 OPFS / 配额不足 / 无句柄 / 写失败 ⇒ 一律降级且**不写断点**，各有可观测日志', async () => {
    const cases = [
      { name: 'no-partial', patch: { partialBlob: null }, opts: {} },
      { name: 'no-opfs', patch: {}, opts: { opfs: false } },
      { name: 'quota', patch: {}, opts: { quota: false } },
      { name: 'handle', patch: {}, opts: { handle: false } },
      { name: 'write-failed', patch: {}, opts: { writeFails: true } },
    ];
    for (const c of cases) {
      const { deps } = makeDeps(c.opts);
      const setPauseCheckpoint = vi.fn(async () => true);
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        const res = await persistPartial({ ...base(), ...c.patch, setPauseCheckpoint, deps });
        expect(res.ok, c.name).toBe(false);
        expect(res.reason, c.name).toBe(c.name);
        // 失败路径**绝不**写断点，也**绝不**抛
        expect(setPauseCheckpoint, c.name).not.toHaveBeenCalled();
        // 每一支都必须留一行可观测日志（含「无半成品」——它同样是「续传会重做整包」的降级）
        expect(warn, `${c.name} 必须留一行可观测日志`).toHaveBeenCalled();
        expect(warn.mock.calls.some((call) => String(call[0]).includes('重做整包')), c.name).toBe(true);
      } finally {
        warn.mockRestore();
      }
    }
  });

  it('hasRoomForPartial：拿不到 estimate 时**放行**（量不出来 ≠ 没空间，不得静默退化）', async () => {
    expect(await hasRoomForPartial(1000, null)).toBe(true);
    expect(await hasRoomForPartial(1000, {})).toBe(true);
    expect(await hasRoomForPartial(1000, { storage: {} })).toBe(true);
    expect(await hasRoomForPartial(1000, { storage: { estimate: async () => { throw new Error('拒了'); } } })).toBe(true);
    expect(await hasRoomForPartial(1000, { storage: { estimate: async () => ({ quota: 0, usage: 0 }) } })).toBe(true);
    // 有明确读数时按读数判定（10% 余量）
    const nav = (quota, usage) => ({ storage: { estimate: async () => ({ quota, usage }) } });
    expect(await hasRoomForPartial(1000, nav(10000, 8000))).toBe(true);  // 剩 2000 ≥ 1100
    expect(await hasRoomForPartial(1000, nav(10000, 9500))).toBe(false); // 剩 500 < 1100
  });
});
