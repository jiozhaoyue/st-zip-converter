import { ZipReader } from '../core/read.js';
import { ZipWriter } from '../core/write.js';
import { detectFromReader, LAYOUTS } from '../core/detect.js';

/**
 * Node 侧 IO 适配器(CLI 与测试用)。
 * 适配器契约见 src/core/transform.js 头注释;浏览器侧对应 src/io/zipjs-io.js。
 */
export const nodeIo = {
  openReader: (sourcePath) => ZipReader.open(sourcePath),
  createWriter: (destination) => ZipWriter.create(destination),
};

/** Node 便捷入口:直接识别 zip 文件路径的布局(浏览器侧走 zipjsIo.openReader)。 */
export { LAYOUTS };

/** Node 便捷入口:直接识别 zip 文件路径的布局(浏览器侧走 zipjsIo.openReader)。 */
export async function detectLayout(filePath) {
  const reader = await ZipReader.open(filePath);
  try {
    return await detectFromReader(reader);
  } finally {
    await reader.close();
  }
}
