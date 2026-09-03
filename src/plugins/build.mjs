// 构建两个平台的插件 IIFE(esbuild):
//   node src/plugins/build.mjs
// 产物:dist/plugins/<platform>/{index.js, manifest.json}
import { build } from 'esbuild';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.join(here, '..', '..', 'dist', 'plugins');

const PLATFORMS = {
  luker: {
    label: 'Luker 跨平台导出',
    version: '0.1.0',
    homePage: 'https://github.com/jiozhaoyue/luker-tt-datatran',
  },
  st: {
    label: 'SillyTavern 跨平台导出',
    version: '0.1.0',
    homePage: 'https://github.com/jiozhaoyue/luker-tt-datatran',
  },
};

for (const [platform, meta] of Object.entries(PLATFORMS)) {
  const outDir = path.join(distRoot, platform);
  await mkdir(outDir, { recursive: true });
  await build({
    entryPoints: [path.join(here, 'plugin.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    outfile: path.join(outDir, 'index.js'),
    define: { __TAVERN_CONVERT_PLATFORM__: JSON.stringify(platform) },
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
  });
  const manifest = {
    display_name: meta.label,
    loading_order: 99,
    requires: [],
    optional: [],
    js: 'index.js',
    css: '',
    author: 'jiozhaoyue',
    version: meta.version,
    homePage: meta.homePage,
  };
  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`built dist/plugins/${platform}/ (index.js + manifest.json)`);
}
