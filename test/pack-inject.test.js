import { describe, expect, it } from 'vitest';
import {
  collectSourceChatFileNames, describePlan, HIDDEN_LIBRARY_PREFIX,
  normalizeChatFileName, planInjection,
} from '../src/core/pack-inject.js';

/**
 * 注入决策单测（对应任务 `09-27-chatfilesys-pure-db-adapter` 的 AC-2 / AC-3）
 *
 * 判定口径（本文件的每个用例都要能回答「两侧比的是同一件事吗」）：
 * 比的是**落盘名（basename）**，不是「聊天条数 vs 文件条数」。
 */

const chat = (fileName, extra = {}) => ({ fileName, chatName: fileName.replace(/\.jsonl$/i, ''), ...extra });

describe('pack-inject · collectSourceChatFileNames', () => {
  it('收集 chats/ 与 group chats/ 下的落盘名（含角色子目录）', () => {
    const names = collectSourceChatFileNames([
      'chats/Izumi 用户画像3.jsonl',
      'chats/Seraphina/孤独摇滚1.jsonl',
      'group chats/群聊A.jsonl',
      'characters/Seraphina.png',
      'settings.json',
      'chats/Seraphina/孤独摇滚1.luker-state.chat_sync.json',   // 伴生文件不是聊天
    ]);
    expect(names).toEqual(new Set([
      'izumi 用户画像3.jsonl', // 归一为小写
      '群聊a.jsonl',
      '孤独摇滚1.jsonl',
    ]));
  });

  it('排除备份特征文件与 backups/ 目录（拿历史快照当「已有」会让当前版本被跳过）', () => {
    const names = collectSourceChatFileNames([
      'chats/A_backup.jsonl',
      'chats/backup_A.jsonl',
      'chats/A.backup.jsonl',
      'backups/chats/A.jsonl',
      'chats/真A.jsonl',
    ]);
    expect(names).toEqual(new Set(['真a.jsonl']));
  });

  it('排除插件自己的隐藏容器（__cfsys__ 是库存储伴生文件，不是聊天）', () => {
    const names = collectSourceChatFileNames([
      `chats/${HIDDEN_LIBRARY_PREFIX}/x.jsonl`,
      'chats/正常.jsonl',
    ]);
    expect(names).toEqual(new Set(['正常.jsonl']));
  });
});

describe('pack-inject · planInjection', () => {
  it('库中有、源包没有 ⇒ 注入；源包已有 ⇒ 一律以源包为准（不覆盖）', () => {
    const plan = planInjection({
      libraryChats: [chat('A.jsonl'), chat('B.jsonl')],
      sourceChatNames: collectSourceChatFileNames(['chats/A.jsonl']),
    });
    expect(plan.inject.map((i) => i.hubPath)).toEqual(['chats/B.jsonl']);
    expect(plan.skipped.alreadyPresent).toBe(1);
    expect(plan.libraryCount).toBe(2);
    expect(plan.sourceCount).toBe(1);
  });

  it('落盘名归一后比对：大小写不同也算同一条（Windows 文件系统语义）', () => {
    const plan = planInjection({
      libraryChats: [chat('Izumi.jsonl')],
      sourceChatNames: collectSourceChatFileNames(['chats/izumi.jsonl']),
    });
    expect(plan.inject).toEqual([]);
    expect(plan.skipped.alreadyPresent).toBe(1);
  });

  it('类目关掉 ⇒ 一条都不注入（用户明确说不要聊天）', () => {
    const plan = planInjection({
      libraryChats: [chat('A.jsonl'), chat('B.jsonl')],
      sourceChatNames: [],
      selection: { chats: false, characters: true },
    });
    expect(plan.inject).toEqual([]);
    expect(plan.skipped.categoryOff).toBe(2);
  });

  it('群聊落 group chats/，普通聊天落 chats/', () => {
    const plan = planInjection({
      libraryChats: [chat('单人.jsonl'), chat('多人群.jsonl', { isGroup: true })],
      sourceChatNames: [],
    });
    const byName = Object.fromEntries(plan.inject.map((i) => [i.fileName, i.hubPath]));
    expect(byName['单人.jsonl']).toBe('chats/单人.jsonl');
    expect(byName['多人群.jsonl']).toBe('group chats/多人群.jsonl');
  });

  it('库索引里的无效项被记入 invalid，不影响其余条目', () => {
    const plan = planInjection({
      libraryChats: [null, {}, { fileName: '' }, { fileName: 'not-a-jsonl.txt' }, chat('好的.jsonl')],
      sourceChatNames: [],
    });
    expect(plan.inject.map((i) => i.fileName)).toEqual(['好的.jsonl']);
    expect(plan.skipped.invalid).toBe(4);
  });

  it('隐藏容器前缀的库条目不得注入（也不得被计入 invalid）', () => {
    const plan = planInjection({
      libraryChats: [chat(`${HIDDEN_LIBRARY_PREFIX}内部探针.jsonl`)],
      sourceChatNames: [],
    });
    expect(plan.inject).toEqual([]);
    expect(plan.skipped.hidden).toBe(1);
    expect(plan.skipped.invalid).toBe(0);
  });

  it('库索引自身重名 ⇒ 只注第一条（避免包内重名条目）', () => {
    const plan = planInjection({
      libraryChats: [chat('Dup.jsonl'), chat('dup.jsonl')],
      sourceChatNames: [],
    });
    expect(plan.inject).toHaveLength(1);
    expect(plan.skipped.alreadyPresent).toBe(1);
  });

  it('空库 / 空源 ⇒ 空计划，且不抛', () => {
    const plan = planInjection({ libraryChats: [], sourceChatNames: [] });
    expect(plan.inject).toEqual([]);
    expect(plan.libraryCount).toBe(0);
    expect(describePlan(plan)).toContain('待补 0 条');
  });

  it('默认跳过带备份特征的库条目，includeBackups=true 时才注入', () => {
    const args = { libraryChats: [chat('A_backup.jsonl')], sourceChatNames: [] };
    expect(planInjection(args).inject).toEqual([]);
    expect(planInjection({ ...args, includeBackups: true }).inject).toHaveLength(1);
  });
});

describe('pack-inject · normalizeChatFileName', () => {
  it('NFC 归一：分解形态与合成形态视作同一个名字', () => {
    const composed = 'café.jsonl';        // é 合成
    const decomposed = 'café.jsonl';
    expect(composed).not.toBe(decomposed);   // 前提：确实是两个不同的串，否则这条用例是恒真的     // e + 组合重音
    expect(normalizeChatFileName(composed)).toBe(normalizeChatFileName(decomposed));
  });
});
