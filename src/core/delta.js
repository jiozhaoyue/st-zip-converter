/**
 * 数据包增量差量引擎 (Delta Archive Engine)
 * 专门用于在外部指定基准 ZIP (Base ZIP) 的前提下，与当前最新数据进行条目级比对，
 * 仅提取新增与修改的文件条目，生成极小体积的纯增量补丁包 (Delta Zip)。
 */

import { zipIo } from './zip-io.js';
import * as zip from '../vendor/zip.js';
import { logger } from './logger.js';

/**
 * @typedef {object} DeltaEntryInfo
 * @property {string} fileName
 * @property {number} uncompressedSize
 * @property {number|undefined} crc32
 */

/**
 * 快速比对两个 ZIP 的条目元数据
 * @param {Blob|File|string} baseArchive 基准数据包
 * @param {Blob|File|string} targetArchive 当前目标数据包
 * @returns {Promise<{
 *   added: DeltaEntryInfo[],
 *   modified: DeltaEntryInfo[],
 *   unchanged: DeltaEntryInfo[],
 *   deleted: string[],
 *   baseMap: Map<string, DeltaEntryInfo>,
 *   targetMap: Map<string, DeltaEntryInfo>
 * }>}
 */
export async function compareArchives(baseArchive, targetArchive) {
  const baseReader = await zipIo.openReader(baseArchive);
  const targetReader = await zipIo.openReader(targetArchive);

  const baseMap = new Map();
  for await (const entry of baseReader.entries()) {
    baseMap.set(entry.fileName, {
      fileName: entry.fileName,
      uncompressedSize: entry.uncompressedSize ?? 0,
      crc32: entry.crc32,
    });
    entry.skip();
  }

  const added = [];
  const modified = [];
  const unchanged = [];
  const targetMap = new Map();

  for await (const entry of targetReader.entries()) {
    const info = {
      fileName: entry.fileName,
      uncompressedSize: entry.uncompressedSize ?? 0,
      crc32: entry.crc32,
    };
    targetMap.set(entry.fileName, info);

    const baseEntry = baseMap.get(entry.fileName);
    if (!baseEntry) {
      added.push(info);
    } else {
      const isSizeDiff = baseEntry.uncompressedSize !== info.uncompressedSize;
      const isCrcDiff = (baseEntry.crc32 !== undefined && info.crc32 !== undefined)
        ? baseEntry.crc32 !== info.crc32
        : false;

      if (isSizeDiff || isCrcDiff) {
        modified.push(info);
      } else {
        unchanged.push(info);
      }
    }
    entry.skip();
  }

  // 统计在基准包中存在但在当前包中已不存在的条目
  const deleted = [];
  for (const baseName of baseMap.keys()) {
    if (!targetMap.has(baseName)) {
      deleted.push(baseName);
    }
  }

  await baseReader.close();
  await targetReader.close();

  return {
    added,
    modified,
    unchanged,
    deleted,
    baseMap,
    targetMap,
  };
}

/**
 * 基于选定的外部基准 ZIP，生成纯增量补丁数据包 (Delta Patch Zip)
 * @param {Blob|File|string} baseArchive 外部基准 ZIP
 * @param {Blob|File|string} targetArchive 当前酒馆最新数据 ZIP
 * @param {object} [options]
 * @param {string} [options.baseName] 基准包文件名标识
 * @param {number} [options.level=5] 压缩等级 (0-9)
 * @param {(current: number, total: number, fileName: string) => void} [options.onProgress] 进度回调
 * @returns {Promise<{
 *   deltaBlob: Blob,
 *   stats: {
 *     addedCount: number,
 *     modifiedCount: number,
 *     unchangedCount: number,
 *     deletedCount: number,
 *     totalChanges: number
 *   },
 *   manifest: object
 * }>}
 */
export async function generateDeltaArchive(baseArchive, targetArchive, options = {}) {
  const { baseName = 'base.zip', level = 5, onProgress } = options;
  logger.info(`开始执行增量比对 (基准: ${baseName})...`);

  const diff = await compareArchives(baseArchive, targetArchive);
  const changeMap = new Map();
  diff.added.forEach((item) => changeMap.set(item.fileName, 'added'));
  diff.modified.forEach((item) => changeMap.set(item.fileName, 'modified'));

  const totalChanges = changeMap.size;
  logger.info(`比对结果: 新增 ${diff.added.length} 项，修改 ${diff.modified.length} 项，保持不变 ${diff.unchanged.length} 项`);

  const writerTarget = new zip.BlobWriter('application/zip');
  const writer = await zipIo.createWriter(writerTarget, { level });

  // 重新打开 targetReader 读取需要写入的实际文件数据
  const targetReader = await zipIo.openReader(targetArchive);
  let processed = 0;

  for await (const entry of targetReader.entries()) {
    if (changeMap.has(entry.fileName)) {
      const data = await entry.read();
      await writer.add(entry.fileName, data);
      processed++;
      if (onProgress) {
        onProgress(processed, totalChanges, entry.fileName);
      }
    } else {
      entry.skip();
    }
  }

  await targetReader.close();

  // 注入轻量增量清单 _delta_manifest.json
  const manifest = {
    generator: 'st-zip-converter',
    type: 'delta-patch',
    version: '1.0.0',
    createdAt: new Date().toISOString(),
    baseArchiveName: baseName,
    stats: {
      addedCount: diff.added.length,
      modifiedCount: diff.modified.length,
      unchangedCount: diff.unchanged.length,
      deletedCount: diff.deleted.length,
      totalChanges,
    },
    changes: {
      added: diff.added.map((e) => e.fileName),
      modified: diff.modified.map((e) => e.fileName),
      deleted: diff.deleted,
    },
  };

  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  await writer.add('_delta_manifest.json', manifestBytes);

  await writer.close();
  const deltaBlob = await writerTarget.getData();

  logger.success(`纯增量补丁包生成完成: 包含 ${totalChanges} 项变更，补丁体积: ${(deltaBlob.size / 1024).toFixed(1)} KB`);

  return {
    deltaBlob,
    stats: {
      addedCount: diff.added.length,
      modifiedCount: diff.modified.length,
      unchangedCount: diff.unchanged.length,
      deletedCount: diff.deleted.length,
      totalChanges,
    },
    manifest,
  };
}
