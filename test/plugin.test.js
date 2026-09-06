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
    expect(manifest.js).toBe('index.js');
    expect(manifest.css).toBe('style.css');
  });

  it('根目录包含标准的 index.html 与 style.css', async () => {
    expect(existsSync('index.html')).toBe(true);
    expect(existsSync('style.css')).toBe(true);

    const html = await readFile('index.html', 'utf8');
    expect(html).toContain('st-zip-converter');
    expect(html).toContain('<link rel="stylesheet" href="./style.css">');
    expect(html).toContain('<script type="module" src="./index.js"></script>');
  });

  it('根目录 index.js 存在且包含模态工作台与宿主自适应启动能力', async () => {
    expect(existsSync('index.js')).toBe(true);
    const code = await readFile('index.js', 'utf8');
    expect(code).toContain('import');
    expect(code).toContain('convert');
    expect(code).toContain('detectHost');
    expect(code).toContain('openConverterModal');
    expect(code).toContain('mountSettingsDrawer');
  });

  it('index.html 包含轻量清单模式 (manifest) 与完整离线包 (full) 单选控制', async () => {
    const html = await readFile('index.html', 'utf8');
    expect(html).toContain('name="extension-mode" value="manifest"');
    expect(html).toContain('name="extension-mode" value="full"');
    expect(html).toContain('id="keep-dev-files-check"');
  });

  it('host-bridge 导出了 discoverHostExtensions, installExtensionViaHost, checkHostThirdPartyAnomaly, deleteExtensionViaHost 与 mountSettingsDrawer', async () => {
    const {
      discoverHostExtensions,
      installExtensionViaHost,
      renderExtensionInstallerModal,
      checkHostThirdPartyAnomaly,
      deleteExtensionViaHost,
      mountSettingsDrawer,
      registerMenuButton,
    } = await import('../src/ui/host-bridge.js');
    expect(typeof discoverHostExtensions).toBe('function');
    expect(typeof installExtensionViaHost).toBe('function');
    expect(typeof renderExtensionInstallerModal).toBe('function');
    expect(typeof checkHostThirdPartyAnomaly).toBe('function');
    expect(typeof deleteExtensionViaHost).toBe('function');
    expect(typeof mountSettingsDrawer).toBe('function');
    expect(typeof registerMenuButton).toBe('function');

    // PT / TT 平台自适应：原生支持 third-party，不应报告异常
    const ptCheck = await checkHostThirdPartyAnomaly('pt');
    expect(ptCheck.hasAnomaly).toBe(false);
    const ttCheck = await checkHostThirdPartyAnomaly('tt');
    expect(ttCheck.hasAnomaly).toBe(false);
  });
});
