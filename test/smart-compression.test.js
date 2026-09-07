import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { entryCompressionLevel, STORE_EXTENSIONS, zipIo } from '../src/core/zip-io.js';

const tmpDirs = [];

async function tmpDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tavern-smartcomp-'));
  tmpDirs.push(dir);
  return dir;
}

describe('entryCompressionLevel 智能分流', () => {
  it('已压缩扩展名 → Store (level 0)', () => {
    for (const ext of ['.png', '.jpg', '.mp4', '.db', '.zip', '.zst']) {
      expect(entryCompressionLevel(`characters/foo${ext}`, 5)).toBe(0);
    }
  });

  it('大写扩展名同样命中 Store', () => {
    expect(entryCompressionLevel('backgrounds/IMG_001.PNG', 5)).toBe(0);
    expect(entryCompressionLevel('assets/clip.WEBM', 9)).toBe(0);
  });

  it('无扩展名 → 用户等级', () => {
    expect(entryCompressionLevel('settings', 5)).toBe(5);
    expect(entryCompressionLevel('data/default-user/chats/room1', 7)).toBe(7);
  });

  it('文本/配置类扩展名 → 用户等级', () => {
    expect(entryCompressionLevel('settings.json', 5)).toBe(5);
    expect(entryCompressionLevel('chats/room.jsonl', 3)).toBe(3);
    expect(entryCompressionLevel('worlds/lore.md', 9)).toBe(9);
  });

  it('路径中的点不干扰：目录带点仍按基名扩展名判定', () => {
    expect(entryCompressionLevel('user.data/cache/file', 5)).toBe(5);
    expect(entryCompressionLevel('user.data/cache/file.png', 5)).toBe(0);
  });

  it('STORE_EXTENSIONS 覆盖设计规格的全部类别', () => {
    for (const ext of [
      '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico',
      '.mp4', '.webm', '.mp3', '.ogg', '.wav', '.flac',
      '.db', '.sqlite', '.sqlite3', '.zst', '.7z', '.zip', '.gz', '.br', '.rar',
    ]) {
      expect(STORE_EXTENSIONS.has(ext)).toBe(true);
    }
  });
});

describe('zipIo Store 直存统计', () => {
  it('getStoreStats：混合条目正确计数，Store 命中条目 compressionMethod=0', async () => {
    const out = path.join(await tmpDir(), 'store-stats.zip');
    const writer = await zipIo.createWriter(out, { level: 5 });
    // 首条目（保序语义）
    await writer.add('manifest.json', new TextEncoder().encode('{"schema":1}'));
    await writer.add('characters/chara.png', new Uint8Array(64).fill(1));
    await writer.add('settings.json', new TextEncoder().encode('{"a":1}'.repeat(100)));
    await writer.close();

    const stats = writer.getStoreStats();
    expect(stats.count).toBe(1);
    expect(stats.bytes).toBe(64);

    const reader = await zipIo.openReader(out);
    const methods = new Map();
    for await (const e of reader.entries()) methods.set(e.fileName, e.compressionMethod);
    await reader.close();
    expect(methods.get('characters/chara.png')).toBe(0);
    expect(methods.get('settings.json')).not.toBe(0);
    expect(methods.get('manifest.json')).not.toBe(0);
  });
});
