/**
 * 智能增量独立分包引擎 (Smart Incremental Split Bin-Packing Engine)
 * 专为规避云酒馆单包上传限制（如 100MB）设计。
 * 核心特性：
 * 1. 绝非 .z01 裸分片！每个分包均是 100% 独立的合法标准 Zip 文件，自带完整的 Central Directory。
 * 2. 保持相对目录完整性（目标云酒馆按 Part 1、Part 2、Part 3 依次导入即可原地增量融合）。
 * 3. 优先级流式装箱：核心小文件 -> 离线扩展代码 -> 大媒体资产，充分支持庞大扩展直接打包。
 * 4. 超大单文件安全隔离：单文件超阈值时独占成包并高亮告警，绝不损毁数据。
 */

import { zipIo } from './zip-io.js';
import * as zip from '../vendor/zip.js';
import { resolveFilename } from './filename-template.js';

export const DEFAULT_THRESHOLD_MB = 100;
export const SAFETY_MARGIN = 0.95; // 预留 5% 缓冲杜绝因压缩表头/元数据导致超限

/**
 * 资产条目优先级评估
 * 优先级 1: 核心小文件与文本数据 (settings, secrets, characters, chats, worlds, presets)
 * 优先级 2: 扩展代码与资源 (extensions/*)
 * 优先级 3: 媒体大资产 (backgrounds/*, User Avatars/*, speech/*, assets/*)
 * @param {string} path 相对路径
 * @returns {number} 优先级权重 (数字越小越先打包)
 */
export function getEntryPriority(path) {
  const norm = path.replace(/\\/g, '/');
  if (
    norm === 'settings.json'
    || norm === 'secrets.json'
    || norm === 'manifest.json'
    || norm.startsWith('characters/')
    || norm.startsWith('chats/')
    || norm.startsWith('worlds/')
    || norm.startsWith('presets/')
    || norm.startsWith('data/default-user/characters/')
    || norm.startsWith('data/default-user/chats/')
    || norm.startsWith('data/default-user/worlds/')
    || norm.startsWith('data/default-user/settings.json')
  ) {
    return 1;
  }
  if (norm.startsWith('extensions/') || norm.startsWith('data/extensions/')) {
    return 2;
  }
  return 3;
}

/**
 * 将一组文件条目按单包阈值智能切分为多个独立的完整 Zip 压缩包
 * @param {Array<{ path: string, read: () => Promise<Uint8Array>|Uint8Array, size?: number }>} entries 待打包文件列表
 * @param {object} options
 * @param {number} [options.thresholdMB=100] 单包最大体积 (MB)
 * @param {string} [options.filenameTemplate] 文件名模板
 * @param {string} [options.target='st'] 目标平台代码
 * @param {string} [options.handle='default-user'] 用户标识
 * @param {number} [options.compressionLevel=5] Zip 压缩级别 (0-9)
 * @param {(currentPart: number, totalPartsEstimated: number, currentFile: string) => void} [options.onProgress] 进度通知
 * @returns {Promise<{
 *   splitId: string,
 *   totalParts: number,
 *   totalFiles: number,
 *   totalBytes: number,
 *   parts: Array<{
 *     partIndex: number,
 *     partName: string,
 *     blob: Blob,
 *     fileCount: number,
 *     sizeBytes: number,
 *     isOversized: boolean,
 *     files: string[],
 *   }>
 * }>}
 */
export async function splitArchiveEntries(entries, {
  thresholdMB = DEFAULT_THRESHOLD_MB,
  filenameTemplate,
  target = 'st',
  handle = 'default-user',
  compressionLevel = 5,
  onProgress,
} = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('splitArchiveEntries: 待切分条目列表不能为空');
  }

  const thresholdBytes = Math.floor(thresholdMB * 1024 * 1024 * SAFETY_MARGIN);
  const splitId = `split-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // 1. 按优先级与文件名稳定排序
  const sortedEntries = [...entries].sort((a, b) => {
    const prioA = getEntryPriority(a.path);
    const prioB = getEntryPriority(b.path);
    if (prioA !== prioB) return prioA - prioB;
    return a.path.localeCompare(b.path);
  });

  const parts = [];
  let currentPartIndex = 1;
  let currentWriterTarget = new zip.BlobWriter('application/zip');
  let currentWriter = await zipIo.createWriter(currentWriterTarget, { level: compressionLevel });
  let currentPartEstimatedBytes = 0;
  let currentPartFiles = [];
  let isCurrentPartOversized = false;

  const closeCurrentPart = async () => {
    // 写入本分卷专属的 split-manifest.json
    const manifest = {
      splitId,
      partIndex: currentPartIndex,
      partLabel: `Part ${currentPartIndex}`,
      thresholdMB,
      thresholdBytes,
      fileCount: currentPartFiles.length,
      isOversized: isCurrentPartOversized,
      files: currentPartFiles,
      generatedAt: new Date().toISOString(),
    };

    const manifestData = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
    await currentWriter.add('_convert/split-manifest.json', manifestData);

    await currentWriter.close();
    const blob = await currentWriterTarget.getData();

    const partSemantic = currentPartIndex === 1 ? 'part1' : `part${currentPartIndex}`;
    const partFilename = resolveFilename(filenameTemplate, {
      target,
      handle,
      part: partSemantic,
      mode: 'split',
      date: new Date(),
    });

    parts.push({
      partIndex: currentPartIndex,
      partName: partFilename,
      blob,
      fileCount: currentPartFiles.length,
      sizeBytes: blob.size,
      isOversized: isCurrentPartOversized,
      files: [...currentPartFiles],
    });
  };

  for (let i = 0; i < sortedEntries.length; i++) {
    const entry = sortedEntries[i];
    const data = typeof entry.read === 'function' ? await entry.read() : entry.data;
    const entrySize = data.byteLength || data.length || entry.size || 0;

    if (onProgress) {
      onProgress(currentPartIndex, Math.max(currentPartIndex, 1), entry.path);
    }

    // 判断如果加入本文件是否会超出安全阈值
    const wouldExceed = (currentPartEstimatedBytes + entrySize) > thresholdBytes;

    if (wouldExceed && currentPartFiles.length > 0) {
      // 封包当前分卷
      await closeCurrentPart();

      // 开启下一个分卷
      currentPartIndex++;
      currentWriterTarget = new zip.BlobWriter('application/zip');
      currentWriter = await zipIo.createWriter(currentWriterTarget, { level: compressionLevel });
      currentPartEstimatedBytes = 0;
      currentPartFiles = [];
      isCurrentPartOversized = false;
    }

    // 如果单个文件自身就超过阈值，单独成卷
    if (entrySize > thresholdBytes) {
      isCurrentPartOversized = true;
    }

    // 写入当前文件
    await currentWriter.add(entry.path, data);
    currentPartFiles.push(entry.path);
    currentPartEstimatedBytes += entrySize;

    // 若该超大文件单独占用当前包，且还有后续文件，则立即封口本卷
    if (isCurrentPartOversized && i < sortedEntries.length - 1) {
      await closeCurrentPart();
      currentPartIndex++;
      currentWriterTarget = new zip.BlobWriter('application/zip');
      currentWriter = await zipIo.createWriter(currentWriterTarget, { level: compressionLevel });
      currentPartEstimatedBytes = 0;
      currentPartFiles = [];
      isCurrentPartOversized = false;
    }
  }

  // 封包最后一个分卷
  if (currentPartFiles.length > 0) {
    await closeCurrentPart();
  }

  const totalFiles = parts.reduce((acc, p) => acc + p.fileCount, 0);
  const totalBytes = parts.reduce((acc, p) => acc + p.sizeBytes, 0);

  // 回填 totalParts
  parts.forEach((p) => {
    p.totalParts = parts.length;
  });

  return {
    splitId,
    totalParts: parts.length,
    totalFiles,
    totalBytes,
    parts,
  };
}
