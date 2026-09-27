import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetChatStoreStateForTest, getChatStoreProbe, importChatsToLibrary,
  listLibraryChats, probeChatStore, readLibraryChatAsJsonl, SUPPORTED_API_VERSION,
} from '../src/ui/chat-store-bridge.js';

/**
 * 聊天库桥单测（对应任务 `09-27-chatfilesys-pure-db-adapter` 的 AC-1 / AC-5）
 *
 * 这一层的核心质量属性不是「能调通」，而是 **「调不通时不能把主路径带下去」**：
 * 外部插件的实现质量不可控 ⇒ 每个用例都在问同一句话：
 * 「这个输入下，调用方还能不能不被打断地继续？」
 */

const KEY = 'ChatFilesysApi';

/** 造一个合规的假供给方 */
function installApi(overrides = {}) {
  const api = {
    apiVersion: 1,
    capabilities: { list: true, export: true, import: true },
    mode: () => 'pure',
    listChats: async () => [{ fileName: 'A.jsonl' }, { fileName: 'B.jsonl' }],
    exportChat: async ({ fileName }) => `{"chat":"${fileName}"}\n`,
    importChat: async () => ({ ok: true }),
    ...overrides,
  };
  globalThis[KEY] = Object.freeze(api);
  return api;
}

afterEach(() => {
  delete globalThis[KEY];
  __resetChatStoreStateForTest();
});

describe('chat-store-bridge · probeChatStore（AC-1 四态矩阵）', () => {
  it('无 API ⇒ 不可用，且**不抛**', () => {
    const p = probeChatStore();
    expect(p.present).toBe(false);
    expect(p.canList || p.canExport || p.canImport).toBe(false);
    expect(p.reason).toContain('未检测到');
  });

  it('apiVersion 高于本端支持 ⇒ 整体不可用（形状未知，宁可不接）', () => {
    installApi({ apiVersion: SUPPORTED_API_VERSION + 1 });
    const p = probeChatStore();
    expect(p.present).toBe(false);
    expect(p.apiVersion).toBe(SUPPORTED_API_VERSION + 1);
    expect(p.reason).toContain('高于本端支持');
  });

  it('缺成员 / 能力位与成员不一致 ⇒ 该能力单独降级', () => {
    installApi({ listChats: undefined });
    expect(probeChatStore()).toMatchObject({ present: true, canList: false, canExport: true });
    installApi({ capabilities: { list: false, export: false, import: false } });
    expect(probeChatStore()).toMatchObject({ canList: false, canExport: false, canImport: false });
  });

  it('mode() 抛异常 ⇒ mode 归为 unknown，其余探测照常', () => {
    installApi({ mode: () => { throw new Error('boom'); } });
    const p = probeChatStore();
    expect(p.present).toBe(true);
    expect(p.mode).toBe('unknown');
    expect(p.canList).toBe(true);
  });

  it('全局被塞了非对象 ⇒ 不可用且不抛', () => {
    globalThis[KEY] = 'not-an-api';
    expect(probeChatStore().present).toBe(false);
  });
});

describe('chat-store-bridge · 失败一律归一、绝不外抛', () => {
  it('listChats 抛异常 ⇒ {ok:false, reason:原文}（不 reject）', async () => {
    installApi({ listChats: async () => { throw new Error('库炸了'); } });
    const res = await listLibraryChats({ timeoutMs: 200 });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('库炸了');
    expect(getChatStoreProbe().lastReason).toContain('库炸了');
  });

  it('未装 API 时三个入口都返回不可用，且一次都不抛', async () => {
    await expect(listLibraryChats({ timeoutMs: 50 })).resolves.toMatchObject({ ok: false });
    await expect(readLibraryChatAsJsonl({ fileName: 'A.jsonl' }, { timeoutMs: 50 }))
      .resolves.toMatchObject({ ok: false });
    await expect(importChatsToLibrary([{ fileName: 'A.jsonl', jsonl: 'x' }], { timeoutMs: 50 }))
      .resolves.toMatchObject({ unsupported: true, imported: 0 });
  });

  it('exportChat 返回空 ⇒ 判失败（不把空内容当成功注入）', async () => {
    installApi({ exportChat: async () => '' });
    const res = await readLibraryChatAsJsonl({ fileName: 'A.jsonl' }, { timeoutMs: 200 });
    expect(res).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('索引项缺 fileName ⇒ 不调用供给方，直接判失败', async () => {
    let called = 0;
    installApi({ exportChat: async () => { called += 1; return 'x'; } });
    const res = await readLibraryChatAsJsonl({}, { timeoutMs: 200 });
    expect(res.ok).toBe(false);
    expect(called).toBe(0);
  });
});

describe('chat-store-bridge · 有界等待（AC-5）', () => {
  it('listChats 永不 settle ⇒ 超时降级，不挂死', async () => {
    installApi({ listChats: () => new Promise(() => {}) });
    const started = Date.now();
    const res = await listLibraryChats({ timeoutMs: 60 });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('timeout');
    expect(Date.now() - started).toBeLessThan(2_000); // 证明真的靠超时返回，而不是内部别的东西
  });

  it('exportChat 永不 settle ⇒ 超时降级并计入失败计数', async () => {
    installApi({ exportChat: () => new Promise(() => {}) });
    const res = await readLibraryChatAsJsonl({ fileName: 'A.jsonl' }, { timeoutMs: 60 });
    expect(res).toMatchObject({ ok: false });
    expect(res.reason).toContain('timeout');
    expect(getChatStoreProbe().lastExportFailed).toBe(1);
  });

  it('importChat 永不 settle ⇒ 该条记失败，**其余条目继续处理**', async () => {
    let n = 0;
    installApi({
      importChat: async () => {
        n += 1;
        if (n === 1) return await new Promise(() => {});
        return { ok: true };
      },
    });
    const res = await importChatsToLibrary(
      [{ fileName: 'A.jsonl', jsonl: 'a' }, { fileName: 'B.jsonl', jsonl: 'b' }],
      { timeoutMs: 60 },
    );
    expect(res.imported).toBe(1);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].reason).toContain('timeout');
  });
});

describe('chat-store-bridge · 导入语义与探针出口', () => {
  it('供给方返回 {ok:false, reason} ⇒ 记为该条失败，不阻断其余', async () => {
    installApi({ importChat: async ({ fileName }) => (fileName === 'A.jsonl' ? { ok: false, reason: '冲突' } : { ok: true }) });
    const res = await importChatsToLibrary(
      [{ fileName: 'A.jsonl', jsonl: 'a' }, { fileName: 'B.jsonl', jsonl: 'b' }],
      { timeoutMs: 200 },
    );
    expect(res).toMatchObject({ ok: false, imported: 1 });
    expect(res.failed).toEqual([{ fileName: 'A.jsonl', reason: '冲突' }]);
  });

  it('缺 fileName 的条目被跳过并记因，不调用供给方', async () => {
    let called = 0;
    installApi({ importChat: async () => { called += 1; return { ok: true }; } });
    const res = await importChatsToLibrary([{ jsonl: 'a' }, { fileName: 'B.jsonl', jsonl: 'b' }], { timeoutMs: 200 });
    expect(res.imported).toBe(1);
    expect(res.failed[0].reason).toContain('缺 fileName');
    expect(called).toBe(1);
  });

  it('signal 已中止 ⇒ 不再继续调用供给方', async () => {
    let called = 0;
    installApi({ importChat: async () => { called += 1; return { ok: true }; } });
    const c = new AbortController();
    c.abort();
    const res = await importChatsToLibrary([{ fileName: 'A.jsonl', jsonl: 'a' }], { signal: c.signal });
    expect(called).toBe(0);
    expect(res.failed[0].reason).toBe('aborted');
  });

  it('探针出口冻结，且**不泄漏**凭据/路径（只有能力位与计数）', () => {
    installApi();
    const probe = getChatStoreProbe();
    expect(Object.isFrozen(probe)).toBe(true);
    expect(Object.getOwnPropertyNames(probe).sort()).toEqual([
      'apiVersion', 'canExport', 'canImport', 'canList', 'lastExportFailed', 'lastExportOk',
      'lastImportFailed', 'lastImportOk', 'lastListCount', 'lastReason', 'mode', 'present',
    ]);
    const serialized = JSON.stringify(probe);
    expect(serialized).not.toMatch(/token|csrf|handle/i);
  });
});
