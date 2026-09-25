/**
 * 合成小包自检（Node，用插件自身的检测逻辑）：确认探针包被识别为 Luker 布局。
 * 用法：node check-probe-pkgs.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectLayout } from '../../../../src/core/detect.js';

const dir = path.join(os.tmpdir(), 'stzc-probe');
for (const tag of ['a', 'b']) {
  const file = path.join(dir, `probe-${tag}.zip`);
  const res = await detectLayout(new Blob([fs.readFileSync(file)]));
  console.log(`probe-${tag}: ${JSON.stringify(res)}`);
}
