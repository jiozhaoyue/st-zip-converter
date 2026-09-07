/**
 * 长任务管理器：宿主拉取 / 转换 / 写回共用的纯状态机。
 *
 * 职责：
 * - 每任务一个 AbortController，signal 透传给 fetch（拉取）与 zip.js add/getData（转换）
 * - 暂停 = checkpoint 落盘 → abort → state=paused，半成品保留待续传
 * - 中止 = abort + 清理半成品，state=aborted
 * - 断点清单持久化由注入的 adapter 完成（浏览器 OPFS / 测试内存 Map），core 无 DOM/存储依赖
 *
 * state: running | paused | aborted | done | failed
 */

export const TASK_STATES = Object.freeze({
  RUNNING: 'running',
  PAUSED: 'paused',
  ABORTED: 'aborted',
  DONE: 'done',
  FAILED: 'failed',
});

/** checkpoint 持久化节流：每 64 条或每 2000ms */
const CHECKPOINT_EVERY_ENTRIES = 64;
const CHECKPOINT_EVERY_MS = 2000;

/**
 * @typedef {Object} TaskRecord
 * @property {string} id
 * @property {string} label
 * @property {'running'|'paused'|'aborted'|'done'|'failed'} state
 * @property {boolean} resumable
 * @property {AbortController} controller
 * @property {number} receivedBytes
 * @property {number} totalBytes
 * @property {object|null} checkpoint 最近一次断点清单
 * @property {number} _dirtyEntries checkpoint 脏计数
 * @property {number} _lastFlushAt 最近 flush 时间戳
 */

/**
 * 持久化 adapter 接口（注入）：
 * - save(id, manifest)  持久化断点清单
 * - load(id)            读取断点清单（无则 null）
 * - remove(id)          删除断点清单与半成品
 */
export const memoryAdapter = () => {
  const store = new Map();
  return {
    async save(id, manifest) { store.set(id, JSON.parse(JSON.stringify(manifest))); },
    async load(id) { return store.get(id) ?? null; },
    async remove(id) { store.delete(id); },
  };
};

/** adapter.load 在清单不存在时返回 null（所有实现统一此约定） */
export const ADAPTER_NULL = null;

export class TaskManager {
  /**
   * @param {object} [adapter] 持久化 adapter（默认内存实现，浏览器侧传 OPFS 实现）
   */
  constructor(adapter = memoryAdapter()) {
    this.adapter = adapter;
    /** @type {Map<string, TaskRecord>} */
    this.tasks = new Map();
  }

  /**
   * 注册任务，返回控制面。
   * @param {string} id
   * @param {string} label
   * @param {object} [options]
   * @param {boolean} [options.resumable=false] 是否支持断点续传
   * @param {number} [options.totalBytes=0] 预估总量（Content-Length 或 totalEntries）
   * @returns {{ signal: AbortSignal, onCheckpoint: function(object): Promise<void> }}
   */
  start(id, label, { resumable = false, totalBytes = 0 } = {}) {
    if (this.tasks.has(id) && this.tasks.get(id).state === TASK_STATES.RUNNING) {
      throw new Error(`TaskManager: 任务 ${id} 已在运行`);
    }
    const controller = new AbortController();
    this.tasks.set(id, {
      id,
      label,
      state: TASK_STATES.RUNNING,
      resumable,
      controller,
      receivedBytes: 0,
      totalBytes,
      checkpoint: null,
      _dirtyEntries: 0,
      _lastFlushAt: 0,
    });
    return {
      signal: controller.signal,
      /**
       * 任务执行体推进断点清单：节流持久化（每 64 条或 2s；force=true 立即落盘）
       * @param {object} manifest 断点清单（如 { receivedBytes, opfsName } 或 { doneEntries }）
       * @param {{force?: boolean, bytes?: number}} [opts]
       */
      onCheckpoint: async (manifest, opts = {}) => {
        const task = this.tasks.get(id);
        if (!task || task.state !== TASK_STATES.RUNNING) return;
        if (typeof opts.bytes === 'number') task.receivedBytes = opts.bytes;
        task.checkpoint = manifest;
        task._dirtyEntries += 1;
        const now = Date.now();
        if (opts.force
          || task._dirtyEntries >= CHECKPOINT_EVERY_ENTRIES
          || (task._dirtyEntries > 0 && now - task._lastFlushAt >= CHECKPOINT_EVERY_MS)) {
          await this.adapter.save(id, manifest);
          task._dirtyEntries = 0;
          task._lastFlushAt = now;
        }
      },
    };
  }

  /**
   * 暂停：触发 checkpoint 强制落盘 → abort → state=paused
   * 幂等：非 running 状态直接返回 false。
   * @param {string} id
   * @returns {Promise<boolean>} 是否发生了暂停
   */
  async pause(id) {
    const task = this.tasks.get(id);
    if (!task || task.state !== TASK_STATES.RUNNING) return false;
    task.state = TASK_STATES.PAUSED;
    if (task.checkpoint) {
      await this.adapter.save(id, task.checkpoint);
      task._dirtyEntries = 0;
    }
    task.controller.abort();
    return true;
  }

  /**
   * 中止：abort + 清理断点清单与半成品，state=aborted
   * 幂等：非 running/paused 状态直接返回 false。
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async abort(id) {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.state !== TASK_STATES.RUNNING && task.state !== TASK_STATES.PAUSED) return false;
    if (task.state === TASK_STATES.RUNNING) {
      task.state = TASK_STATES.ABORTED;
      task.controller.abort();
    } else {
      task.state = TASK_STATES.ABORTED;
    }
    await this.adapter.remove(id);
    return true;
  }

  /**
   * 读取断点清单并标记续传（由调用方携带清单重跑任务）。
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async resume(id) {
    const task = this.tasks.get(id);
    if (!task || task.state !== TASK_STATES.PAUSED || !task.resumable) return null;
    const manifest = await this.adapter.load(id);
    return manifest;
  }

  /**
   * 任务完成：清理断点清单，state=done
   */
  async complete(id) {
    const task = this.tasks.get(id);
    if (!task) return;
    task.state = TASK_STATES.DONE;
    await this.adapter.remove(id);
  }

  /**
   * 任务失败：可续传任务保留清单（state=failed），不可续传清理
   */
  async fail(id, keepCheckpoint = false) {
    const task = this.tasks.get(id);
    if (!task) return;
    task.state = TASK_STATES.FAILED;
    if (!keepCheckpoint) await this.adapter.remove(id);
  }

  /**
   * @param {string} id
   * @returns {{ state, label, receivedBytes, totalBytes, resumable, checkpoint }|null}
   */
  get(id) {
    const task = this.tasks.get(id);
    if (!task) return null;
    return {
      state: task.state,
      label: task.label,
      receivedBytes: task.receivedBytes,
      totalBytes: task.totalBytes,
      resumable: task.resumable,
      checkpoint: task.checkpoint,
    };
  }

  /** 列出全部任务摘要（UI 渲染用） */
  list() {
    return [...this.tasks.values()].map((t) => ({
      id: t.id,
      label: t.label,
      state: t.state,
      receivedBytes: t.receivedBytes,
      totalBytes: t.totalBytes,
      resumable: t.resumable,
    }));
  }
}
