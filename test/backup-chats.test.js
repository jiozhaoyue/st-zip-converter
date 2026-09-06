import { describe, expect, it } from 'vitest';
import { isBackupChatOrSnapshot } from '../src/core/inspect.js';
import { convert, TARGETS } from '../src/core/transform.js';
import { generatePlan } from '../src/core/plan-preview.js';
import { zipIo } from '../src/core/zip-io.js';
import * as zip from '../src/vendor/zip.js';

async function createZip(entries) {
  const writerTarget = new zip.BlobWriter('application/zip');
  const writer = await zipIo.createWriter(writerTarget, { level: 5 });
  for (const [name, content] of entries) {
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    await writer.add(name, data);
  }
  await writer.close();
  return await writerTarget.getData();
}

describe('Backup Chats & Snapshots (备份聊天记录与快照过滤测试)', () => {
  it('isBackupChatOrSnapshot 正确识别快照目录与各类历史备份聊天文件', () => {
    // 命中快照与备份文件
    expect(isBackupChatOrSnapshot('backups/auto-2026.json')).toBe(true);
    expect(isBackupChatOrSnapshot('data/default-user/backups/snapshot.json')).toBe(true);
    expect(isBackupChatOrSnapshot('chats/Alice/2026-09-01_backup.jsonl')).toBe(true);
    expect(isBackupChatOrSnapshot('chats/Alice/backup_2026-09-01.jsonl')).toBe(true);
    expect(isBackupChatOrSnapshot('chats/Bob/chat.jsonl.bak')).toBe(true);
    expect(isBackupChatOrSnapshot('chats/Carol/chat.backup')).toBe(true);
    expect(isBackupChatOrSnapshot('chats/Dave/session (backup).jsonl')).toBe(true);
    expect(isBackupChatOrSnapshot('group chats/Team/group_backup.jsonl')).toBe(true);

    // 活跃聊天与正常资产绝对不应误判
    expect(isBackupChatOrSnapshot('chats/Alice/2026-09-01.jsonl')).toBe(false);
    expect(isBackupChatOrSnapshot('chats/Bob/chat-session-1.jsonl')).toBe(false);
    expect(isBackupChatOrSnapshot('group chats/Team/meeting-2026.jsonl')).toBe(false);
    expect(isBackupChatOrSnapshot('characters/Alice.png')).toBe(false);
    expect(isBackupChatOrSnapshot('settings.json')).toBe(false);
  });

  it('convert 转换时默认不包含备份聊天记录与快照 (includeBackups: false 默认)', async () => {
    const sourceZip = await createZip([
      ['characters/Alice.png', 'avatar-bytes'],
      ['chats/Alice/active-chat.jsonl', '{"mes":"active"}'],
      ['chats/Alice/old-chat_backup.jsonl', '{"mes":"backup"}'],
      ['backups/system-backup-2026.json', '{}'],
      ['settings.json', '{}'],
    ]);

    const targetWriter = new zip.BlobWriter('application/zip');
    const { report } = await convert(sourceZip, targetWriter, {
      target: TARGETS.ST,
      // 未显式传 includeBackups，验证默认行为为 false
    });

    const outputBlob = await targetWriter.getData();
    const reader = await zipIo.openReader(outputBlob);
    const outNames = [];
    for await (const entry of reader.entries()) {
      outNames.push(entry.fileName);
      entry.skip();
    }
    await reader.close();

    // 活跃聊天与标准资产应保留
    expect(outNames.includes('chats/Alice/active-chat.jsonl')).toBe(true);
    expect(outNames.includes('characters/Alice.png')).toBe(true);

    // 备份聊天与快照目录必须被剔除
    expect(outNames.includes('chats/Alice/old-chat_backup.jsonl')).toBe(false);
    expect(outNames.includes('backups/system-backup-2026.json')).toBe(false);
  });

  it('convert 显式传入 includeBackups: true 时完整保留备份聊天与快照', async () => {
    const sourceZip = await createZip([
      ['characters/Alice.png', 'avatar-bytes'],
      ['chats/Alice/active-chat.jsonl', '{"mes":"active"}'],
      ['chats/Alice/old-chat_backup.jsonl', '{"mes":"backup"}'],
      ['backups/system-backup-2026.json', '{}'],
    ]);

    const targetWriter = new zip.BlobWriter('application/zip');
    await convert(sourceZip, targetWriter, {
      target: TARGETS.ST,
      includeBackups: true,
    });

    const outputBlob = await targetWriter.getData();
    const reader = await zipIo.openReader(outputBlob);
    const outNames = [];
    for await (const entry of reader.entries()) {
      outNames.push(entry.fileName);
      entry.skip();
    }
    await reader.close();

    expect(outNames.includes('chats/Alice/active-chat.jsonl')).toBe(true);
    expect(outNames.includes('chats/Alice/old-chat_backup.jsonl')).toBe(true);
    expect(outNames.includes('backups/system-backup-2026.json')).toBe(true);
  });

  it('generatePlan 默认对备份聊天与快照标记 DROP 动作', async () => {
    const sourceZip = await createZip([
      ['characters/Alice.png', 'avatar-bytes'],
      ['chats/Alice/active.jsonl', 'chat'],
      ['chats/Alice/active_backup.jsonl', 'backup-chat'],
      ['backups/auto.json', 'auto-backup'],
    ]);

    const plan = await generatePlan(sourceZip, TARGETS.ST);

    const backupCategory = plan.categories.backups;
    expect(backupCategory).toBeDefined();
    expect(backupCategory.items.length).toBe(2);
    expect(backupCategory.items.every((i) => i.action === 'DROP')).toBe(true);

    const charCategory = plan.categories.characters;
    expect(charCategory.items[0].action).not.toBe('DROP');
  });
});
