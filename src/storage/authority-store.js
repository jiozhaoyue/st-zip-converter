/**
 * Authority 后端可选适配器（ST-Delegation-of-authority 服务端插件）
 *
 * 探测 window.STAuthority（由宿主的 st-authority-sdk 扩展注入），不可用时全部
 * 接口安全降级返回 null/false，调用方无需分支处理。能力定位：存储与续传层
 * （大包持久暂存、断点 checkpoint），不迁移转换计算（Authority jobs 仅内置类型）。
 *
 * 复用约定：
 * - createCheckpointAdapter() 实现与 task-manager.js 持久化 adapter 相同的
 *   { save, load, remove } 接缝，注入 TaskManager 即接管断点持久化。
 * - blob 分块：storage.blob 为 base64 编码，大文件按 CHUNK_SIZE 切块落盘，
 *   清单（manifest）存 KV，读时按块重组，避免单请求超限与 base64 内存峰值。
 */

const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB/块
const KV_MANIFEST_PREFIX = 'blob-manifest:';
const KV_CHECKPOINT_PREFIX = 'task-checkpoint:';

/** 测试注入钩子（生产路径不使用） */
let testClient = undefined;

/**
 * 探测并初始化 Authority client（结果缓存）
 * @returns {Promise<object|null>} client 或 null（未安装/未授权/初始化失败）
 */
export async function getAuthorityClient() {
  if (testClient !== undefined) return testClient;
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  const sdk = window.STAuthority && window.STAuthority.AuthoritySDK;
  if (!sdk) return null;
  try {
    return await sdk.init({
      extensionId: 'third-party/st-zip-converter',
      displayName: '酒馆数据包互转工坊',
      version: '1.0.0',
      installType: 'local',
      declaredPermissions: {
        fs: { private: true },
        storage: { kv: true, blob: true },
      },
    });
  } catch (err) {
    console.warn('[authority-store] Authority 初始化失败，降级为本地存储:', err);
    return null;
  }
}

/** @private 测试专用：注入 mock client，传 undefined 恢复真实探测 */
export function __setAuthorityClientForTest(client) {
  testClient = client;
}

/** @returns {boolean} Authority 是否可用（同步粗探，最终以 getAuthorityClient 为准） */
export function isAuthorityAvailable() {
  if (testClient !== undefined) return testClient !== null;
  return typeof window !== 'undefined'
    && !!(window.STAuthority && window.STAuthority.AuthoritySDK);
}

// ===== KV 基础封装 =====

async function kvSet(client, key, value) {
  await client.storage.kv.set({ key, value });
}

async function kvGet(client, key) {
  const res = await client.storage.kv.get({ key });
  // SDK 返回形状未在 README 固化：兼容 { value } / 直接值 / { data }
  if (res === null || res === undefined) return null;
  if (typeof res === 'object' && 'value' in res) return res.value ?? null;
  if (typeof res === 'object' && 'data' in res) return res.data ?? null;
  return res;
}

// ===== 断点 checkpoint（TaskManager adapter 接缝）=====

/**
 * 生成 TaskManager 兼容的断点持久化 adapter（Authority KV），不可用时返回 null，
 * 调用方回退默认 adapter（如 task-manager.memoryAdapter）。
 * @returns {Promise<{save,load,remove}|null>}
 */
export async function createCheckpointAdapter() {
  const client = await getAuthorityClient();
  if (!client) return null;
  return {
    async save(id, manifest) {
      await kvSet(client, KV_CHECKPOINT_PREFIX + id, manifest);
    },
    async load(id) {
      return await kvGet(client, KV_CHECKPOINT_PREFIX + id);
    },
    async remove(id) {
      await client.storage.kv.set({ key: KV_CHECKPOINT_PREFIX + id, value: null });
    },
  };
}

// ===== 产物 blob 分块存取 =====

function uint8ToBase64(bytes) {
  let bin = '';
  const STEP = 0x8000; // 分段避免 apply 参数上限
  for (let i = 0; i < bytes.length; i += STEP) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return btoa(bin);
}

function base64ToUint8(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** blob → Uint8Array（File/Blob 统一走 arrayBuffer） */
async function blobToBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * 分块写入产物到 Authority blob 存储（按块 base64，清单存 KV）
 * @param {string} name 逻辑名（同名单块覆盖，隔离由 Authority 按用户+扩展保证）
 * @param {Blob|File} blob 产物
 * @param {{ chunkSize?: number, onProgress?: (done:number,total:number)=>void }} [opts]
 * @returns {Promise<{ name: string, size: number, chunks: number }|null>} null=Authority 不可用
 */
export async function putArtifact(name, blob, opts = {}) {
  const client = await getAuthorityClient();
  if (!client) return null;
  const chunkSize = opts.chunkSize || CHUNK_SIZE;
  const bytes = await blobToBytes(blob);
  const total = Math.max(1, Math.ceil(bytes.length / chunkSize));
  const parts = [];
  for (let i = 0; i < total; i++) {
    const partName = `${name}__part_${String(i).padStart(6, '0')}`;
    const content = uint8ToBase64(bytes.subarray(i * chunkSize, (i + 1) * chunkSize));
    const put = await client.storage.blob.put({
      name: partName,
      content,
      encoding: 'base64',
      contentType: blob.type || 'application/octet-stream',
    });
    // put 返回形状未固化：优先用返回 id，否则按名读取
    const id = (put && typeof put === 'object' && (put.id ?? put.blobId)) || partName;
    parts.push({ id, name: partName });
    if (opts.onProgress) opts.onProgress(i + 1, total);
  }
  const manifest = {
    name,
    size: bytes.length,
    contentType: blob.type || 'application/octet-stream',
    chunkSize,
    chunks: total,
    parts,
    savedAt: Date.now(),
  };
  await kvSet(client, KV_MANIFEST_PREFIX + name, manifest);
  return { name, size: bytes.length, chunks: total };
}

/**
 * 读取分块产物并重组为 Blob
 * @returns {Promise<Blob|null>} null=不存在或 Authority 不可用
 */
export async function getArtifact(name) {
  const client = await getAuthorityClient();
  if (!client) return null;
  const manifest = await kvGet(client, KV_MANIFEST_PREFIX + name);
  if (!manifest || !Array.isArray(manifest.parts)) return null;
  const buffers = [];
  for (const part of manifest.parts) {
    const got = await client.storage.blob.get({ id: part.id, name: part.name });
    // 兼容多种返回形状：base64 字符串 / { content } / ArrayBuffer|Uint8Array / Blob
    let chunkBytes = null;
    if (typeof got === 'string') {
      chunkBytes = base64ToUint8(got);
    } else if (got && typeof got === 'object') {
      const raw = got.content ?? got.data ?? got.bytes ?? got;
      if (typeof raw === 'string') {
        chunkBytes = base64ToUint8(raw);
      } else if (raw instanceof ArrayBuffer) {
        chunkBytes = new Uint8Array(raw);
      } else if (raw instanceof Blob) {
        chunkBytes = await blobToBytes(raw);
      } else if (raw && raw.buffer instanceof ArrayBuffer) {
        chunkBytes = new Uint8Array(raw.buffer, raw.byteOffset || 0, raw.byteLength);
      }
    }
    if (!chunkBytes) return null;
    buffers.push(chunkBytes);
  }
  const totalLen = buffers.reduce((n, b) => n + b.length, 0);
  const merged = new Uint8Array(totalLen);
  let off = 0;
  for (const b of buffers) { merged.set(b, off); off += b.length; }
  return new Blob([merged], { type: manifest.contentType || 'application/octet-stream' });
}

/**
 * 产物入库时镜像归档到 Authority（fire-and-forget 语义，错误只告警不阻断）
 * Authority 不可用时静默跳过；同名覆盖（最新产物为准）。
 * @param {string} name 逻辑名
 * @param {Blob|File} blob 产物
 * @returns {Promise<boolean>} 是否成功镜像
 */
export async function mirrorArtifact(name, blob) {
  try {
    const res = await putArtifact(name, blob);
    if (res) {
      console.info(`[authority-store] 产物已归档到 Authority: ${name} (${(res.size / 1048576).toFixed(1)} MB, ${res.chunks} 块)`);
      return true;
    }
    return false;
  } catch (err) {
    console.warn(`[authority-store] 产物镜像失败（不影响本地入库）: ${name}`, err);
    return false;
  }
}

/**
 * 删除产物（清单 + 全部分块）
 * @returns {Promise<boolean>}
 */
export async function deleteArtifact(name) {
  const client = await getAuthorityClient();
  if (!client) return false;
  const manifest = await kvGet(client, KV_MANIFEST_PREFIX + name);
  if (Array.isArray(manifest?.parts)) {
    for (const part of manifest.parts) {
      try {
        if (typeof client.storage.blob.delete === 'function') {
          await client.storage.blob.delete({ id: part.id, name: part.name });
        }
      } catch { /* 单块删除失败不阻断清单清理 */ }
    }
  }
  await client.storage.kv.set({ key: KV_MANIFEST_PREFIX + name, value: null });
  return true;
}
