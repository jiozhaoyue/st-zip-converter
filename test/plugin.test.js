// T6: 插件构建产物冒烟 —— esbuild 产物可在无 DOM 的 Node 环境安全求值,
// 平台标识(esbuild define)正确,导出 API 句柄存在;manifest 符合 ST 扩展规范。
// 真实 UI 与平台端点行为仍需 Dev 实例人工验证(AC9 平台侧)。
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

describe.each([
  ['luker', path.join('dist', 'plugins', 'luker')],
  ['st', path.join('dist', 'plugins', 'st')],
])('插件产物(%s)', (platform, dir) => {
  it('index.js 与 manifest.json 存在且非空', async () => {
    const code = await readFile(path.join(dir, 'index.js'), 'utf8');
    expect(code.length).toBeGreaterThan(50_000); // 自包含 zip.js + 转换核心
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    expect(manifest.js).toBe('index.js');
    expect(manifest.display_name.length).toBeGreaterThan(0);
    expect(Array.isArray(manifest.requires)).toBe(true);
  });

  it(`IIFE 在无 DOM 环境求值成功,平台标识为 ${platform},暴露转换 API`, async () => {
    const code = await readFile(path.join(dir, 'index.js'), 'utf8');
    const previous = globalThis.__tavernConvert;
    delete globalThis.__tavernConvert;
    // IIFE:直接求值;document 未定义 → UI 挂载被跳过,不崩
    new Function(code)();
    const api = globalThis.__tavernConvert;
    expect(api).toBeDefined();
    expect(api.PLATFORM).toBe(platform);
    expect(typeof api.convertBackup).toBe('function');
    expect(typeof api.fetchBackupBlob).toBe('function');
    if (previous) globalThis.__tavernConvert = previous;
  });
});
