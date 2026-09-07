import * as zip from '../vendor/zip.js';
import { convert } from './transform.js';
import { generatePlan } from './plan-preview.js';
import { zipIo } from './zip-io.js';

// Dedicated Worker 转换引擎线程
self.onmessage = async (e) => {
  const { type, id, sourceBlob, target, options = {} } = e.data || {};

  if (type === 'PLAN') {
    try {
      const excludedSet = Array.isArray(options.excludedPaths)
        ? new Set(options.excludedPaths)
        : (options.excludedPaths || new Set());

      const plan = await generatePlan(sourceBlob, target, {
        ...options,
        excludedPaths: excludedSet,
        io: zipIo,
      });

      self.postMessage({
        type: 'PLAN_DONE',
        id,
        plan,
      });
    } catch (err) {
      self.postMessage({
        type: 'ERROR',
        id,
        error: err?.message || String(err),
      });
    }
  } else if (type === 'CONVERT') {
    try {
      const targetWriter = new zip.BlobWriter('application/zip');
      const excludedSet = Array.isArray(options.excludedPaths)
        ? new Set(options.excludedPaths)
        : (options.excludedPaths || new Set());

      const report = await convert(sourceBlob, targetWriter, {
        ...options,
        excludedPaths: excludedSet,
        target,
        io: zipIo,
        onProgress: (current, total, filename, crc32) => {
          self.postMessage({
            type: 'PROGRESS',
            id,
            current,
            total,
            filename,
            crc32: crc32 ?? null,
          });
        },
      });

      const resultBlob = await targetWriter.getData();
      self.postMessage({
        type: 'DONE',
        id,
        report: report.toJSON(),
        resultBlob,
      });
    } catch (err) {
      self.postMessage({
        type: 'ERROR',
        id,
        error: err?.message || String(err),
      });
    }
  }
};
