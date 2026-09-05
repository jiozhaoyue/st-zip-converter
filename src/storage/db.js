/**
 * IndexedDB 存储适配层 (零额外依赖，纯原生 Promise 封装)
 * 提供数据包暂存、会话工作区记忆、用户偏好持久化与存储容量统计。
 */

const DB_NAME = 'st_zip_converter_db';
const DB_VERSION = 1;

const STORES = {
  FILES: 'files',
  WORKSPACE: 'workspace',
  PREFERENCES: 'preferences',
};

let dbInstance = null;

/**
 * 检查当前环境是否支持 IndexedDB
 * @returns {boolean}
 */
export function isStorageSupported() {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

/**
 * 打开或获取数据库单例连接
 * @returns {Promise<IDBDatabase|null>}
 */
export async function openDb() {
  if (!isStorageSupported()) return null;
  if (dbInstance) return dbInstance;

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORES.FILES)) {
        db.createObjectStore(STORES.FILES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.WORKSPACE)) {
        db.createObjectStore(STORES.WORKSPACE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORES.PREFERENCES)) {
        db.createObjectStore(STORES.PREFERENCES, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      dbInstance.onversionchange = () => {
        dbInstance.close();
        dbInstance = null;
      };
      resolve(dbInstance);
    };

    request.onerror = () => {
      console.warn('打开 IndexedDB 失败:', request.error);
      reject(request.error);
    };
  });
}

/**
 * 通用事务 Promise 执行包装
 * @param {string} storeName
 * @param {'readonly'|'readwrite'} mode
 * @param {function(IDBObjectStore): IDBRequest} operation
 * @returns {Promise<any>}
 */
async function runTransaction(storeName, mode, operation) {
  const db = await openDb();
  if (!db) return null;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const request = operation(store);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * 暂存上传的原始数据包或生成包
 * @param {object} item
 * @param {string} item.id 唯一标识
 * @param {string} item.name 文件名
 * @param {number} item.size 字节数
 * @param {Blob|File} item.blob 实际二进制数据
 * @param {string} [item.layout] 识别出的布局
 * @returns {Promise<string|null>}
 */
export async function saveFile({ id, name, size, blob, layout }) {
  if (!isStorageSupported()) return null;
  const fileId = id || `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id: fileId,
    name,
    size: size || blob?.size || 0,
    blob,
    layout: layout || 'unknown',
    createdAt: Date.now(),
  };

  await runTransaction(STORES.FILES, 'readwrite', (store) => store.put(record));
  return fileId;
}

/**
 * 获取暂存的数据包记录
 * @param {string} id
 * @returns {Promise<{id: string, name: string, size: number, blob: Blob, layout: string}|null>}
 */
export async function getFile(id) {
  if (!isStorageSupported() || !id) return null;
  return runTransaction(STORES.FILES, 'readonly', (store) => store.get(id));
}

/**
 * 删除指定暂存的数据包
 * @param {string} id
 */
export async function deleteFile(id) {
  if (!isStorageSupported() || !id) return;
  return runTransaction(STORES.FILES, 'readwrite', (store) => store.delete(id));
}

/**
 * 获取所有暂存文件清单（不含 blob 大对象）
 * @returns {Promise<Array<{id: string, name: string, size: number, layout: string, createdAt: number}>>}
 */
export async function listStoredFiles() {
  if (!isStorageSupported()) return [];
  const db = await openDb();
  if (!db) return [];

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.FILES, 'readonly');
    const store = tx.objectStore(STORES.FILES);
    const list = [];
    const cursorReq = store.openCursor();

    cursorReq.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        const { id, name, size, layout, createdAt } = cursor.value;
        list.push({ id, name, size, layout, createdAt });
        cursor.continue();
      } else {
        resolve(list.sort((a, b) => b.createdAt - a.createdAt));
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

/**
 * 统计暂存用量
 * @returns {Promise<{ count: number, totalBytes: number }>}
 */
export async function getStorageUsage() {
  const files = await listStoredFiles();
  let totalBytes = 0;
  for (const f of files) {
    totalBytes += (f.size || 0);
  }
  return {
    count: files.length,
    totalBytes,
  };
}

/**
 * 保存工作区状态（当前正在处理的文件、目标平台、类目选择与排除列表）
 * @param {object} state
 */
export async function saveWorkspaceState(state) {
  if (!isStorageSupported()) return;
  const record = {
    key: 'active_session',
    ...state,
    updatedAt: Date.now(),
  };
  return runTransaction(STORES.WORKSPACE, 'readwrite', (store) => store.put(record));
}

/**
 * 加载工作区状态
 * @returns {Promise<object|null>}
 */
export async function loadWorkspaceState() {
  if (!isStorageSupported()) return null;
  return runTransaction(STORES.WORKSPACE, 'readonly', (store) => store.get('active_session'));
}

/**
 * 保存用户全局偏好
 * @param {object} preferences
 */
export async function savePreferences(preferences) {
  if (!isStorageSupported()) return;
  const record = {
    key: 'user_preferences',
    ...preferences,
    updatedAt: Date.now(),
  };
  return runTransaction(STORES.PREFERENCES, 'readwrite', (store) => store.put(record));
}

/**
 * 读取用户全局偏好
 * @returns {Promise<object|null>}
 */
export async function loadPreferences() {
  if (!isStorageSupported()) return null;
  return runTransaction(STORES.PREFERENCES, 'readonly', (store) => store.get('user_preferences'));
}

/**
 * 清空所有暂存文件与工作区数据
 */
export async function clearAll() {
  if (!isStorageSupported()) return;
  const db = await openDb();
  if (!db) return;

  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORES.FILES, STORES.WORKSPACE], 'readwrite');
    tx.objectStore(STORES.FILES).clear();
    tx.objectStore(STORES.WORKSPACE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
