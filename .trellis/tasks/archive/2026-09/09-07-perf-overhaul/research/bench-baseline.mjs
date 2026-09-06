import { zipIo } from '../../../../src/core/zip-io.js';
import * as zip from '../../../../src/vendor/zip.js';

const data = new Uint8Array(5 * 1024 * 1024);
for (let i = 0; i < data.length; i++) data[i] = (i * 7 + (i >> 9)) & 0xff;

{
  const files = Array.from({length: 20}, (_, k) => data.slice(k * 256 * 1024, (k+1) * 256 * 1024));
  const t0 = performance.now();
  const writer = await zipIo.createWriter(new zip.BlobWriter('application/zip'), { level: 5 });
  for (const f of files) await writer.add(`f${Math.random()}.bin`, f);
  await writer.close();
  console.log('串行 20x256KB (createWriter level5):', Math.round(performance.now() - t0), 'ms');
}

{
  const buf = data.slice(0, 256 * 1024);
  const t0 = performance.now();
  const out = await new Response(new Blob([buf]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
  console.log('原生 CompressionStream 256KB:', Math.round(performance.now() - t0), 'ms →', Math.round(out.byteLength/1024), 'KB');
}
