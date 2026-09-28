import { describe, expect, it, vi } from 'vitest';
import { TaskManager, TASK_STATES, memoryAdapter } from '../src/core/task-manager.js';

const flushMicro = () => new Promise((r) => setTimeout(r, 0));

describe('TaskManager 状态机', () => {
  it('start → running；signal 未中止；get 返回摘要', () => {
    const tm = new TaskManager();
    const { signal } = tm.start('t1', '宿主拉取', { resumable: true, totalBytes: 1024 });
    expect(signal.aborted).toBe(false);
    expect(tm.get('t1')).toMatchObject({
      state: 'running',
      label: '宿主拉取',
      resumable: true,
      totalBytes: 1024,
    });
  });

  it('重复 start 同 id 运行中任务抛错；结束后可重新注册', () => {
    const tm = new TaskManager();
    tm.start('t1', 'a');
    expect(() => tm.start('t1', 'b')).toThrow(/已在运行/);
    tm.tasks.get('t1').state = TASK_STATES.DONE;
    expect(() => tm.start('t1', 'b')).not.toThrow();
  });

  it('pause：running → paused，abort signal，checkpoint 强制落盘', async () => {
    const tm = new TaskManager();
    const { onCheckpoint } = tm.start('t1', '拉取', { resumable: true });
    await onCheckpoint({ receivedBytes: 500, opfsName: 'x.zip' }, { force: true, bytes: 500 });

    expect(await tm.pause('t1')).toBe(true);
    expect(tm.get('t1').state).toBe('paused');
    expect(tm.get('t1').receivedBytes).toBe(500);

    const manifest = await tm.resume('t1');
    expect(manifest).toEqual({ receivedBytes: 500, opfsName: 'x.zip' });
  });

  it('pause 幂等：paused/aborted 状态再 pause 返回 false', async () => {
    const tm = new TaskManager();
    tm.start('t1', 'a');
    expect(await tm.pause('t1')).toBe(true);
    expect(await tm.pause('t1')).toBe(false);
    expect(tm.get('t1').state).toBe('paused');
  });

  it('abort：running → aborted 并清理清单；再 abort 返回 false', async () => {
    const adapter = memoryAdapter();
    const saveSpy = vi.spyOn(adapter, 'save');
    const removeSpy = vi.spyOn(adapter, 'remove');
    const tm = new TaskManager(adapter);
    const { signal, onCheckpoint } = tm.start('t1', 'a', { resumable: true });
    await onCheckpoint({ receivedBytes: 1 }, { force: true });
    expect(saveSpy).toHaveBeenCalled();

    expect(await tm.abort('t1')).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(tm.get('t1').state).toBe('aborted');
    expect(removeSpy).toHaveBeenCalledWith('t1');
    expect(await tm.resume('t1')).toBeNull();
    expect(await tm.abort('t1')).toBe(false);
  });

  it('abort 清理 paused 任务的清单（丢弃续传）', async () => {
    const adapter = memoryAdapter();
    const tm = new TaskManager(adapter);
    tm.start('t1', 'a', { resumable: true });
    await tm.pause('t1');
    expect(await tm.abort('t1')).toBe(true);
    expect(tm.get('t1').state).toBe('aborted');
    expect(await adapter.load('t1')).toBeNull();
  });

  it('resume 仅对 paused + resumable 生效', async () => {
    const tm = new TaskManager();
    tm.start('t1', 'a'); // 非 resumable
    await tm.pause('t1');
    expect(await tm.resume('t1')).toBeNull();

    tm.start('t2', 'b', { resumable: true });
    await tm.abort('t2'); // aborted 不可 resume
    expect(await tm.resume('t2')).toBeNull();
  });

  it('complete 清理清单 → done；fail 默认清理，keepCheckpoint 保留', async () => {
    const adapter = memoryAdapter();
    const tm = new TaskManager(adapter);
    const { onCheckpoint } = tm.start('t1', 'a', { resumable: true });
    await onCheckpoint({ doneEntries: {} }, { force: true });
    await tm.complete('t1');
    expect(tm.get('t1').state).toBe('done');
    expect(await adapter.load('t1')).toBeNull();

    const { onCheckpoint: cp2 } = tm.start('t2', 'b', { resumable: true });
    await cp2({ doneEntries: { 'a.json': 111 } }, { force: true });
    await tm.fail('t2', true);
    expect(tm.get('t2').state).toBe('failed');
    expect(await adapter.load('t2')).toEqual({ doneEntries: { 'a.json': 111 } });
  });

  it('checkpoint 节流：首个 checkpoint 立即落盘，之后 64 条或 2s 触发；force 绕过', async () => {
    const adapter = memoryAdapter();
    const saveSpy = vi.spyOn(adapter, 'save');
    const tm = new TaskManager(adapter);
    const { onCheckpoint } = tm.start('t1', 'a', { resumable: true });

    await onCheckpoint({ n: 0 }, { bytes: 0 }); // 首个：_lastFlushAt=0 触发立即落盘（保证早期进度可见）
    expect(saveSpy).toHaveBeenCalledTimes(1);

    for (let i = 1; i < 64; i++) {
      await onCheckpoint({ n: i }, { bytes: i * 10 });
    }
    expect(saveSpy).toHaveBeenCalledTimes(1); // 节流窗口内不再落盘
    await onCheckpoint({ n: 64 }, { bytes: 640 }); // 第 64 条触发
    expect(saveSpy).toHaveBeenCalledTimes(2);

    await onCheckpoint({ n: 65 }, { force: true });
    expect(saveSpy).toHaveBeenCalledTimes(3);
  });

  it('onCheckpoint 在非 running 状态静默丢弃（暂停后到达的尾事件）', async () => {
    const adapter = memoryAdapter();
    const saveSpy = vi.spyOn(adapter, 'save');
    const tm = new TaskManager(adapter);
    const { onCheckpoint } = tm.start('t1', 'a', { resumable: true });
    await tm.pause('t1');
    await onCheckpoint({ n: 'late' }, { force: true });
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('list 输出全部任务摘要', () => {
    const tm = new TaskManager();
    tm.start('a', '任务A');
    tm.start('b', '任务B', { resumable: true });
    const rows = tm.list();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('内存 adapter 独立隔离', async () => {
    const a = memoryAdapter();
    const b = memoryAdapter();
    await a.save('x', { v: 1 });
    expect(await b.load('x')).toBeNull();
  });
});

describe('TaskManager 暂停态断点的专用通道（真增量续传，2026-09-28）', () => {
  // 为什么需要**专用通道**而不是把 onCheckpoint 的 RUNNING 门打开：那道门是**防尾事件**的
  // （暂停后仍可能有在途进度回调到达，写盘会把真断点覆盖成陈旧台账 —— 见上一个 describe 的用例）。
  // 而「真断点」（半成品 zip 名 + 其清单）**只能在暂停收尾之后**才存在 ⇒ 给它一条
  // 只在 PAUSED 生效、一次性的显式通道，两条保护同时成立。
  it('暂停之后经 setPauseCheckpoint 能落盘真断点', async () => {
    const adapter = memoryAdapter();
    const tm = new TaskManager(adapter);
    const { onCheckpoint, setPauseCheckpoint } = tm.start('c1', '转换', { resumable: true });
    await onCheckpoint({ phase: 'running' }, { force: true });

    expect(await tm.pause('c1')).toBe(true);
    expect(tm.get('c1').state).toBe(TASK_STATES.PAUSED);

    const manifest = { partialOpfsName: 'convert-c1.partial.zip', target: 'st', totalEntries: 42 };
    expect(await setPauseCheckpoint(manifest)).toBe(true);
    expect(await adapter.load('c1')).toEqual(manifest);
    // 内存快照同步（pause() 落盘用的是内存里的 checkpoint）
    expect(tm.get('c1').checkpoint).toEqual(manifest);
  });

  it('setPauseCheckpoint 只在 PAUSED 生效：running / aborted / done / failed 一律拒绝', async () => {
    const adapter = memoryAdapter();
    const tm = new TaskManager(adapter);

    const running = tm.start('r1', '转换', { resumable: true });
    expect(await running.setPauseCheckpoint({ partialOpfsName: 'x.zip' })).toBe(false);

    const aborted = tm.start('a1', '转换', { resumable: true });
    await tm.abort('a1');
    expect(await aborted.setPauseCheckpoint({ partialOpfsName: 'x.zip' })).toBe(false);

    const done = tm.start('d1', '转换', { resumable: true });
    await tm.complete('d1');
    expect(await done.setPauseCheckpoint({ partialOpfsName: 'x.zip' })).toBe(false);

    const failed = tm.start('f1', '转换', { resumable: true });
    await tm.fail('f1', true);
    expect(await failed.setPauseCheckpoint({ partialOpfsName: 'x.zip' })).toBe(false);
  });

  it('两条保护同时成立：暂停后的**尾事件**仍被丢弃，而真断点能被续传读到', async () => {
    const adapter = memoryAdapter();
    const tm = new TaskManager(adapter);
    const { onCheckpoint, setPauseCheckpoint } = tm.start('c9', '转换', { resumable: true });
    await tm.pause('c9');

    // ① 尾事件（通用通道）在暂停后必须被丢弃 —— 不得覆盖真断点
    onCheckpoint({ n: 'stale-tail' }, { force: true });
    // ② 专用通道写下的才是真断点
    await setPauseCheckpoint({ partialOpfsName: 'real.partial.zip', target: 'st' });
    // ③ 续传读到的必须是真断点
    expect(await tm.resume('c9')).toEqual({ partialOpfsName: 'real.partial.zip', target: 'st' });
  });
});

