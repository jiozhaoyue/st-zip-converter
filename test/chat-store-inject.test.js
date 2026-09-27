import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipIo } from '../src/core/zip-io.js';
import { __resetChatStoreStateForTest } from '../src/ui/chat-store-bridge.js';
import {
  exportLibraryToPack, importRestoredChatsIntoLibrary, injectLibraryChatsIntoSource,
} from '../src/ui/chat-store-inject.js';

/**
 * 编排层单测（对应任务 `09-27-chatfilesys-pure-db-adapter` 的 AC-2 / AC-3）
 *
 * 这一层验的是**串起来之后的语义**：源包优先、类目服从、失败不产出空壳包、
 * 无插件时**一个字节都不动**。全部走真实 zip（不是假 IO），
 * 因为「增强后包还能不能读」正是本任务最该被证明的事。
 */

const KEY = 'ChatFilesysApi';

async function tmpDir() {
  return await mkdtemp(path.join(os.tmpdir(), 'tavern-inject-'));
}

/** 造一个「纯库模式」源包：chats/ 只有 A，B 在库里但磁盘上没有 */
async function makePureDbLikeZip(dir, chatEntries = [['chats/A.jsonl', '{"a":1}\n']]) {
  const p = path.join(dir, 'host-backup.zip');
  const writer = await zipIo.createWriter(p);
  await writer.add('settings.json', '{"theme":"dark"}');   // 字符串由 zip-io 负责编码
  for (const [name, data] of chatEntries) await writer.add(name, data);
  await writer.close();
  return p;
}

function installApi({ chats = [{ fileName: 'A.jsonl' }, { fileName: 'B.jsonl' }], overrides = {} } = {}) {
  globalThis[KEY] = Object.freeze({
    apiVersion: 1,
    capabilities: { list: true, export: true, import: true },
    mode: () => 'pure',
    listChats: async () => chats,
    exportChat: async ({ fileName }) => `{"chat":"${fileName}"}\n`,
    importChat: async () => ({ ok: true }),
    ...overrides,
  });
}

async function readNames(source) {
  const reader = await zipIo.openReader(source);
  const out = [];
  try {
    for await (const e of reader.entries()) out.push(e.fileName);
  } finally {
    await reader.close();
  }
  return out;
}

afterEach(() => {
  delete globalThis[KEY];
  __resetChatStoreStateForTest();
});

describe('chat-store-inject · 未装聊天库时零变化', () => {
  it('无 API ⇒ 返回**同一个对象**、不做 IO、injected 0', async () => {
    const dir = await tmpDir();
    const src = await makePureDbLikeZip(dir);
    const source = { fake: true };   // 故意用非 zip 对象：一旦真去读就会炸，从而证明「没读」
    const res = await injectLibraryChatsIntoSource(source, {});
    expect(res.source).toBe(source);
    expect(res.injected).toBe(0);
    expect(res.probe.present).toBe(false);
  });
});

describe('chat-store-inject · 导出侧补齐（AC-3）', () => {
  it('库里比源包多的那条被补进来；源包已有的那条**以源包为准**（内容不被顶替）', async () => {
    const dir = await tmpDir();
    const src = await makePureDbLikeZip(dir, [['chats/A.jsonl', '{"a":"原样"}\n']]);
    installApi();

    const res = await injectLibraryChatsIntoSource(src, { compressionLevel: 0 });
    expect(res.injected).toBe(1);
    expect(res.attempted).toBe(1);

    const names = await readNames(res.source);
    expect(names).toContain('chats/B.jsonl');
    const reader = await zipIo.openReader(res.source);
    const seen = new Map();
    for await (const e of reader.entries()) seen.set(e.fileName, Buffer.from(await e.read()).toString('utf8'));
    await reader.close();
    // 源包优先：A 的内容没有被供给方返回的内容顶替
    expect(seen.get('chats/A.jsonl')).toBe('{"a":"原样"}\n');
    expect(seen.get('chats/B.jsonl')).toBe('{"chat":"B.jsonl"}\n');
    // 非聊天条目原样在场
    expect(names).toContain('settings.json');
  });

  it('源包已含全部库中聊天 ⇒ 不增强（原样返回同一个对象）', async () => {
    const dir = await tmpDir();
    const src = await makePureDbLikeZip(dir, [['chats/A.jsonl', 'a\n'], ['chats/B.jsonl', 'b\n']]);
    installApi({ chats: [{ fileName: 'A.jsonl' }, { fileName: 'B.jsonl' }] });
    const res = await injectLibraryChatsIntoSource(src);
    expect(res.source).toBe(src);
    expect(res.injected).toBe(0);
    expect(res.skippedReason).toContain('已含全部');
  });

  it('类目关掉（selection.chats=false）⇒ 不读取、不注入', async () => {
    const dir = await tmpDir();
    const src = await makePureDbLikeZip(dir);
    let exported = 0;
    installApi({ overrides: { exportChat: async () => { exported += 1; return 'x\n'; } } });
    const res = await injectLibraryChatsIntoSource(src, { selection: { chats: false } });
    expect(res.source).toBe(src);
    expect(res.injected).toBe(0);
    expect(exported).toBe(0);
  });

  it('全部条目导出失败 ⇒ 用**原源包**继续（不产出「只多了一堆空条目」的包）', async () => {
    const dir = await tmpDir();
    const src = await makePureDbLikeZip(dir);
    installApi({ overrides: { exportChat: async () => '' } });
    const res = await injectLibraryChatsIntoSource(src);
    expect(res.source).toBe(src);
    expect(res.injected).toBe(0);
    expect(res.skippedReason).toContain('全部条目导出失败');
    expect(res.failed).toHaveLength(1);
  });

  it('部分失败仍产出包，并如实记下失败条数', async () => {
    const dir = await tmpDir();
    const src = await makePureDbLikeZip(dir);
    installApi({
      chats: [{ fileName: 'B.jsonl' }, { fileName: 'C.jsonl' }],
      overrides: {
        exportChat: async ({ fileName }) => {
          if (fileName === 'C.jsonl') throw new Error('该条损坏');
          return `{"chat":"${fileName}"}\n`;
        },
      },
    });
    const res = await injectLibraryChatsIntoSource(src, { compressionLevel: 0 });
    expect(res.injected).toBe(1);
    expect(res.failed).toEqual([{ fileName: 'C.jsonl', reason: '该条损坏' }]);
    expect(await readNames(res.source)).toContain('chats/B.jsonl');
  });

  it('库索引不可用 ⇒ 降级透传，不抛', async () => {
    const dir = await tmpDir();
    const src = await makePureDbLikeZip(dir);
    installApi({ overrides: { listChats: async () => { throw new Error('库离线'); } } });
    const res = await injectLibraryChatsIntoSource(src, {});
    expect(res.source).toBe(src);
    expect(res.skippedReason).toContain('库离线');
  });
});

describe('chat-store-inject · 导入侧入库', () => {
  it('包内有聊天且供给方支持 import ⇒ 逐条入库', async () => {
    const dir = await tmpDir();
    const src = await makePureDbLikeZip(dir, [['chats/A.jsonl', '{"a":1}\n'], ['chats/B.jsonl', '{"b":2}\n']]);
    const imported = [];
    installApi({ overrides: { importChat: async ({ fileName, jsonl }) => { imported.push([fileName, jsonl]); return { ok: true }; } } });
    const res = await importRestoredChatsIntoLibrary(src);
    expect(res.attempted).toBe(2);
    expect(res.imported).toBe(2);
    expect(imported.map(([n]) => n)).toEqual(['A.jsonl', 'B.jsonl']);
  });

  it('包内没有聊天 ⇒ 什么都不做（不为空包刷提示）', async () => {
    const dir = await tmpDir();
    const src = await makePureDbLikeZip(dir, []);
    let called = 0;
    installApi({ overrides: { importChat: async () => { called += 1; return { ok: true }; } } });
    const res = await importRestoredChatsIntoLibrary(src);
    expect(res.skipped).toBe('no-chats-in-pack');
    expect(called).toBe(0);
  });

  it('供给方只给 list/export 不给 import ⇒ 如实提示「已在磁盘、请用转库」，不抛', async () => {
    const dir = await tmpDir();
    const src = await makePureDbLikeZip(dir);
    installApi({ overrides: {} });
    globalThis[KEY] = Object.freeze({
      apiVersion: 1,
      capabilities: { list: true, export: true, import: false },
      mode: () => 'pure',
      listChats: async () => [],
      exportChat: async () => '',
    });
    const res = await importRestoredChatsIntoLibrary(src);
    expect(res.skipped).toBe('import-unsupported');
    expect(res.attempted).toBe(1);
  });

  it('未装聊天库 ⇒ 静默（默认路径零变化）', async () => {
    const dir = await tmpDir();
    const src = await makePureDbLikeZip(dir);
    const res = await importRestoredChatsIntoLibrary(src);
    expect(res.skipped).toBe('no-chat-store');
    expect(res.imported).toBe(0);
  });
});


/**
 * 「从聊天库导出」的单测（E2E 另有 `specs/library-export.e2e.cjs` 走真按钮；这里只测编排语义）
 *
 * 为什么要单测：E2E 慢且依赖浏览器；而这条编排有若干**只有靠注入才测得到**的分支
 * （库索引失败 / 类目关断 / 全条导出失败 / 只给 list 不给 export）。
 */
describe('chat-store-inject · 从聊天库导出（exportLibraryToPack）', () => {
  it('成功路径：库里的聊天进产物，且落位在 chats/ 下（含角色子目录）', async () => {
    installApi({ chats: [{ fileName: 'Solo.jsonl' }, { fileName: 'Char/双人.jsonl' }] });
    const res = await exportLibraryToPack({ target: 'st', compressionLevel: 0 });
    expect(res.ok).toBe(true);
    expect(res.count).toBe(2);
    const reader = await zipIo.openReader(res.blob);
    const names = [];
    const texts = new Map();
    for await (const e of reader.entries()) {
      names.push(e.fileName);
      texts.set(e.fileName, Buffer.from(await e.read()).toString('utf8'));
    }
    await reader.close();
    expect(names).toContain('chats/Solo.jsonl');
    expect(names).toContain('chats/Char/双人.jsonl');
    // 内容来自供给方（`installApi` 的默认 exportChat 返回 `{"chat":"<fileName>"}`）
    expect(texts.get('chats/Solo.jsonl')).toContain('"chat":"Solo.jsonl"');
    // 隐藏容器即便出现在索引里也不得进产物
    expect(names.some((n) => n.includes('__cfsys__'))).toBe(false);
  });

  it('未装聊天库 ⇒ ok:false + 可读原因（不抛）', async () => {
    const res = await exportLibraryToPack({ target: 'st' });
    expect(res).toMatchObject({ ok: false, count: 0 });
    expect(res.reason).toContain('未检测到聊天库');
  });

  it('只给 list 不给 export ⇒ 明确说明缺哪个能力', async () => {
    globalThis[KEY] = Object.freeze({
      apiVersion: 1,
      capabilities: { list: true, export: false, import: false },
      mode: () => 'pure',
      listChats: async () => [{ fileName: 'A.jsonl' }],
    });
    const res = await exportLibraryToPack({ target: 'st' });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('export');
  });

  it('库索引失败 ⇒ 降级为可读原因（不抛）', async () => {
    installApi({ overrides: { listChats: async () => { throw new Error('库离线'); } } });
    const res = await exportLibraryToPack({ target: 'st' });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('库离线');
  });

  it('聊天类目关断 ⇒ 不导出（尊重用户选择）', async () => {
    let exported = 0;
    installApi({ overrides: { exportChat: async () => { exported += 1; return 'x\n'; } } });
    const res = await exportLibraryToPack({ target: 'st', selection: { chats: false } });
    expect(res.ok).toBe(false);
    expect(exported).toBe(0);
  });

  it('全部条目导出失败 ⇒ ok:false 且**不产出空壳包**', async () => {
    installApi({ overrides: { exportChat: async () => '' } });
    const res = await exportLibraryToPack({ target: 'st' });
    expect(res.ok).toBe(false);
    expect(res.blob).toBeNull();
    expect(res.failed.length).toBeGreaterThan(0);
  });

  it('部分失败仍产出包，并如实记下失败条目', async () => {
    installApi({
      chats: [{ fileName: 'OK.jsonl' }, { fileName: '坏.jsonl' }],
      overrides: {
        exportChat: async ({ fileName }) => {
          if (fileName === '坏.jsonl') throw new Error('该条损坏');
          return '{"a":1}\n';
        },
      },
    });
    const res = await exportLibraryToPack({ target: 'st', compressionLevel: 0 });
    expect(res.ok).toBe(true);
    expect(res.count).toBe(1);
    expect(res.failed).toEqual([{ fileName: '坏.jsonl', reason: '该条损坏' }]);
  });

  it('signal 已中止 ⇒ 立即返回 aborted，不读任何一条', async () => {
    let exported = 0;
    installApi({ overrides: { exportChat: async () => { exported += 1; return 'x\n'; } } });
    const c = new AbortController();
    c.abort();
    const res = await exportLibraryToPack({ target: 'st', signal: c.signal });
    expect(res.ok).toBe(false);
    // 中止发生在**读索引**这一步 ⇒ 归一后如实报出「索引不可用 + 原因」
    expect(res.reason).toContain('aborted');
    expect(exported).toBe(0);
  });
});
