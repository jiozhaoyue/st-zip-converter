// T6: 标准 ST/Luker 扩展结构与清单冒烟测试
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

describe('SillyTavern 标准插件工程结构 (st-zip-converter)', () => {
  it('根目录包含合规的 manifest.json', async () => {
    expect(existsSync('manifest.json')).toBe(true);
    const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
    expect(manifest.name).toBe('st-zip-converter');
    expect(manifest.display_name).toContain('酒馆');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.author).toBe('jiozhaoyue');
  });

  it('根目录包含标准的 index.html 与 style.css', async () => {
    expect(existsSync('index.html')).toBe(true);
    expect(existsSync('style.css')).toBe(true);

    const html = await readFile('index.html', 'utf8');
    expect(html).toContain('st-zip-converter');
    expect(html).toContain('<link rel="stylesheet" href="./style.css">');
    expect(html).toContain('<script type="module" src="./index.js"></script>');
  });

  it('根目录 index.js 存在且为 ESM 模块化入口', async () => {
    expect(existsSync('index.js')).toBe(true);
    const code = await readFile('index.js', 'utf8');
    expect(code).toContain('import');
    expect(code).toContain('convert');
    expect(code).toContain('detectHost');
  });
});
