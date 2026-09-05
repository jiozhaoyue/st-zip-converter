/**
 * 实时日志与审计系统 (Logger)
 * 支持结构化记录、级别过滤、环形内存缓冲、事件订阅与一键文本导出。
 */

const MAX_LOG_ENTRIES = 1000;

export const LOG_LEVELS = Object.freeze({
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
  SUCCESS: 'SUCCESS',
});

let logCounter = 0;
const logBuffer = [];
const subscribers = new Set();

function formatTime(date = new Date()) {
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const h = pad(date.getHours());
  const m = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  const ms = pad(date.getMilliseconds(), 3);
  return `${h}:${m}:${s}.${ms}`;
}

/**
 * 核心日志单例
 */
export const logger = {
  /**
   * 记录一条日志
   * @param {'INFO'|'WARN'|'ERROR'|'SUCCESS'} level
   * @param {string} message
   * @param {any} [detail]
   * @returns {object}
   */
  log(level, message, detail = null) {
    const entry = {
      id: ++logCounter,
      level,
      message: String(message),
      detail: detail ?? null,
      timestamp: formatTime(),
      timeMs: Date.now(),
    };

    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_ENTRIES) {
      logBuffer.shift();
    }

    // 控制台镜像输出
    const prefix = `[st-zip-converter][${entry.timestamp}][${level}]`;
    if (level === LOG_LEVELS.ERROR) {
      console.error(prefix, message, detail ?? '');
    } else if (level === LOG_LEVELS.WARN) {
      console.warn(prefix, message, detail ?? '');
    } else {
      console.log(prefix, message, detail ?? '');
    }

    // 广播给所有订阅者
    for (const sub of subscribers) {
      try {
        sub(entry);
      } catch (err) {
        console.error('Logger subscriber error:', err);
      }
    }

    return entry;
  },

  info(message, detail) {
    return this.log(LOG_LEVELS.INFO, message, detail);
  },

  warn(message, detail) {
    return this.log(LOG_LEVELS.WARN, message, detail);
  },

  error(message, detail) {
    return this.log(LOG_LEVELS.ERROR, message, detail);
  },

  success(message, detail) {
    return this.log(LOG_LEVELS.SUCCESS, message, detail);
  },

  /**
   * 订阅日志流
   * @param {(entry: object) => void} fn
   * @returns {() => void} 退订函数
   */
  subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  },

  /**
   * 获取所有日志列表（可选级别过滤）
   * @param {string} [filterLevel] 'ALL' | 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS'
   * @returns {Array<object>}
   */
  getEntries(filterLevel = 'ALL') {
    if (!filterLevel || filterLevel === 'ALL') {
      return [...logBuffer];
    }
    return logBuffer.filter((e) => e.level === filterLevel);
  },

  /**
   * 获取日志级别统计
   */
  getStats() {
    let info = 0;
    let warn = 0;
    let error = 0;
    let success = 0;
    for (const e of logBuffer) {
      if (e.level === LOG_LEVELS.INFO) info++;
      else if (e.level === LOG_LEVELS.WARN) warn++;
      else if (e.level === LOG_LEVELS.ERROR) error++;
      else if (e.level === LOG_LEVELS.SUCCESS) success++;
    }
    return {
      total: logBuffer.length,
      info,
      warn,
      error,
      success,
    };
  },

  /**
   * 清空日志
   */
  clear() {
    logBuffer.length = 0;
    for (const sub of subscribers) {
      try {
        sub({ type: 'CLEAR' });
      } catch {}
    }
  },

  /**
   * 导出全部日志为可读文本
   * @returns {string}
   */
  exportText() {
    return logBuffer
      .map((e) => {
        let line = `[${e.timestamp}] [${e.level.padEnd(7)}] ${e.message}`;
        if (e.detail) {
          if (typeof e.detail === 'object') {
            try {
              line += `\n  Detail: ${JSON.stringify(e.detail, null, 2).replace(/\n/g, '\n  ')}`;
            } catch {
              line += `\n  Detail: [Unserializable Object]`;
            }
          } else {
            line += ` (${e.detail})`;
          }
        }
        return line;
      })
      .join('\n');
  },
};
