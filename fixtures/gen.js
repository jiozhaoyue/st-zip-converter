import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { zipIo } from '../src/core/zip-io.js';

/**
 * 生成四个平台的迷你合成包,覆盖 R2 内容集:
 * 角色卡 / 聊天 / 世界书 / 预设 / settings / secrets / 头像 / 第三方扩展(含来源记录)。
 * 全部确定性内容,供单测与往返断言;运行 `node fixtures/gen.js [outDir]` 落盘,
 * 单测里也会调用 generateAll 直接生成到 tmp。
 */

const SELECTION = Object.freeze({
  settings: true,
  secrets: true,
  characters: true,
  chats: true,
  lorebooks: true,
  presets: true,
  assets: true,
  extensions: true,
  globalExtensions: true,
  vectors: true,
});

const MANIFEST = {
  display_name: 'Test Extension',
  loading_order: 1,
  requires: [],
  optional: [],
  js: 'index.js',
  css: '',
  author: 'fixture',
  version: '1.0.0',
  homePage: 'https://github.com/example/test-extension',
};

const EXT_SOURCE = {
  host: 'github.com',
  repo_path: 'example/test-extension',
  reference: 'main',
  remote_url: 'https://github.com/example/test-extension',
  installed_commit: '0123456789abcdef0123456789abcdef01234567',
};

function pngBytes(name) {
  // 合法 PNG 头 + 名字填充,内容确定性即可,单测不解析图像。
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([header, Buffer.from(`fixture:${name}`, 'utf8')]);
}

function json(value) {
  return Buffer.from(JSON.stringify(value, null, 2), 'utf8');
}

const CHARACTER_CARD = json({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: { name: 'Fixture Character', description: 'fixture only', first_mes: 'hi' },
});
const CHAT = Buffer.from(
  [
    JSON.stringify({ user_name: 'You', character_name: 'Fixture Character', create_date: '2026-09-01' }),
    JSON.stringify({ name: 'You', is_user: true, mes: 'hello' }),
    JSON.stringify({ name: 'Fixture Character', is_user: false, mes: 'world' }),
    '',
  ].join('\n'),
  'utf8',
);
const WORLD = json({ entries: { '0': { uid: 0, key: ['fixture'], content: 'fixture lore' } } });
const SETTINGS = json({ firstRun: false, font_scale: 1, fixtureMarker: 'st-settings' });
const SECRETS = json({ api_key_openai: 'fixture-secret-do-not-leak', api_key_anthropic: 'fixture-secret-2' });
const PRESET = json({ temperature: 1.0, fixture: true });
const EXT_INDEX = Buffer.from('// fixture extension entrypoint\n', 'utf8');

/** 平台无关的 ST 用户目录条目(摊平布局)。 */
function flatUserEntries() {
  return [
    ['characters/Fixture Character.png', pngBytes('card')],
    ['chats/Fixture Character/2026-09-01.jsonl', CHAT],
    ['worlds/fixture-world.json', WORLD],
    ['OpenAI Settings/fixture-preset.json', PRESET],
    ['settings.json', SETTINGS],
    ['secrets.json', SECRETS],
    ['User Avatars/fixture-avatar.png', pngBytes('avatar')],
    ['extensions/test-extension/manifest.json', json(MANIFEST)],
    ['extensions/test-extension/index.js', EXT_INDEX],
    // 派生缓存:默认应被丢弃(--keep-all 保留)
    ['thumbnails/fixture-avatar.png', pngBytes('thumb')],
    ['backups/auto-2026.json', Buffer.from('[]', 'utf8')],
  ];
}

export function stEntries() {
  return flatUserEntries();
}

export function lEntries() {
  return [
    ['manifest.json', json({
      schemaVersion: 1,
      createdAt: '2026-09-01T00:00:00.000Z',
      handle: 'default-user',
      selection: { ...SELECTION },
    })],
    ...flatUserEntries(),
  ];
}

export function ttEntries() {
  const prefix = (name) => `data/default-user/${name}`;
  return [
    // 用户目录整体套 data/default-user 前缀 (TT 的扩展放在 data/extensions/third-party)
    ...flatUserEntries().filter(([name]) => !name.startsWith('extensions/')).map(([name, data]) => [prefix(name), data]),
    // TT 私有:扩展包文件在 data 根的 extensions/third-party,来源记录在 _tauritavern
    ['data/extensions/third-party/test-extension/manifest.json', json(MANIFEST)],
    ['data/extensions/third-party/test-extension/index.js', EXT_INDEX],
    ['data/_tauritavern/extension-sources/global/test-extension.json', json(EXT_SOURCE)],
    // TT 私有杂项(转换器默认应丢弃并在报告列明)
    ['data/_cache/derived.bin', Buffer.from('derived-cache', 'utf8')],
    ['data/content.log', Buffer.from('log\n', 'utf8')],
  ];
}

export async function generateAll(outDir) {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(outDir, { recursive: true });
  const outputs = {};
  const packs = [
    ['fixture-st.zip', stEntries()],
    ['fixture-l.zip', lEntries()],
    ['fixture-tt.zip', ttEntries()],
  ];
  for (const [fileName, entries] of packs) {
    const outPath = path.join(outDir, fileName);
    const writer = await zipIo.createWriter(outPath);
    for (const [name, data] of entries) {
      await writer.add(name, data);
    }
    await writer.close();
    outputs[fileName] = outPath;
  }
  return outputs;
}

/**
 * 入口守卫：仅当本文件被**作为 CLI 直跑**时落盘；被 `import` 时**零副作用**。
 *
 * ⚠️ 2026-09-27 修复（R-17）：原实现用模板字符串手拼
 * `file://${process.argv[1].replace(/\\/g, '/')}`，而 Windows 上 `import.meta.url` 是
 * `file:///D:/…`（**三个**斜杠），模板拼出的是 `file://D:/…`（**两个**）⇒ **永不相等** ⇒
 * `npm run gen-fixtures` 自存在起**从未产出过任何夹具**（退出码 0、零输出、零产物 —— **静默空操作**）。
 * 改用 `node:url` 的 `pathToFileURL`（**不引新依赖**，L1-MR-11）。
 * 回归守护：`test/gen-fixtures-cli.test.js` 的**双向负例**（直跑确实产出 / import 零副作用）。
 */
const isCliEntry = (() => {
  const entry = process.argv[1];
  if (!entry) return false; // 存在性守卫：pathToFileURL(undefined) 会抛
  const entryUrl = pathToFileURL(entry).href;
  if (entryUrl === import.meta.url) return true;
  // Windows 路径大小写不敏感：`node FIXTURES/gen.js` 这类调用不应被误判成「非 CLI」
  return process.platform === 'win32' && entryUrl.toLowerCase() === import.meta.url.toLowerCase();
})();

if (isCliEntry) {
  const outDir = process.argv[2] ?? 'fixtures';
  generateAll(outDir)
    .then((outputs) => {
      for (const [name, outPath] of Object.entries(outputs)) {
        console.log(`generated ${name} -> ${outPath}`);
      }
    })
    // 显式收口失败：「静默空操作」与「失败却看不出原因」是同一类问题的两面
    .catch((err) => {
      console.error(`[fixtures/gen] 生成失败: ${err?.message || err}`);
      process.exitCode = 1;
    });
}
