import * as zip from '@zip.js/zip.js';
import { convert } from './transform.js';
import { zipIo } from './zip-io.js';

// Dedicated Worker 转换引擎线程
self.onmessage = async (e) => {
  const { type, id, sourceBlob, target, options = {} } = e.data || {};
  if (type === 'CONVERT') {
    try {
      const targetWriter = new zip.BlobWriter('application/zip');
      const report = await convert(sourceBlob, targetWriter, {
        ...options,
        target,
        io: zipIo,
        onProgress: (current, total, filename) => {
          self.postMessage({
            type: 'PROGRESS',
            id,
            current,
            total,
            filename,
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
