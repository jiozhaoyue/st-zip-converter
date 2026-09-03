export const LAYOUTS = Object.freeze({
  ST: 'st',            // zip 根摊平 ST 用户目录,无 manifest
  L: 'l',              // 同 ST 摊平 + manifest.json{schemaVersion,handle,selection}
  TT: 'tt',            // data/ 根(TT 导出,PT 的 TT 迁移包同形)
  PT_NATIVE: 'pt-native', // PT 原生归档(manifest 带 per-file moduleId/sha256),v1 不支持
  UNKNOWN: 'unknown',
});

/**
 * 识别源布局。判定顺序按 design.md §3:
 * 1) data/default-user/ 或 data/_tauritavern/ 前缀 → tt
 * 2) 根 manifest.json 解析:format/files[].moduleId → pt-native;schemaVersion+selection → l
 * 3) 根 characters/ 或 settings.json → st
 * 4) 其余 unknown
 */
export async function detectFromReader(reader) {
  let hasDataRoot = false;
  let hasCharactersRoot = false;
  let hasSettingsRoot = false;
  let manifestBuffer = null;

  for await (const entry of reader.entries()) {
    const name = entry.fileName;
    if (name === 'manifest.json') {
      manifestBuffer = await entry.read();
      continue;
    }
    if (name.startsWith('data/default-user/') || name.startsWith('data/_tauritavern/')) {
      hasDataRoot = true;
    } else if (name.startsWith('characters/') || name === 'characters') {
      hasCharactersRoot = true;
    } else if (name === 'settings.json') {
      hasSettingsRoot = true;
    }
    entry.skip();
  }

  if (hasDataRoot) {
    return { layout: LAYOUTS.TT, evidence: 'entries under data/default-user or data/_tauritavern' };
  }

  const manifest = manifestBuffer ? parseJson(manifestBuffer) : null;
  if (manifest && typeof manifest === 'object') {
    const perFileManifest = Array.isArray(manifest.files)
      && manifest.files.some((file) => file && typeof file === 'object' && 'moduleId' in file);
    if (manifest.format || perFileManifest) {
      return { layout: LAYOUTS.PT_NATIVE, evidence: 'manifest carries per-file moduleId list' };
    }
    if ('schemaVersion' in manifest && 'selection' in manifest) {
      return { layout: LAYOUTS.L, evidence: 'manifest.json has schemaVersion+selection' };
    }
  }

  if (hasCharactersRoot || hasSettingsRoot) {
    return { layout: LAYOUTS.ST, evidence: 'flat user directory entries (characters/ or settings.json)' };
  }

  return { layout: LAYOUTS.UNKNOWN, evidence: 'no recognizable layout marker' };
}

const JSON_DECODER = new TextDecoder();

function parseJson(data) {
  try {
    return JSON.parse(JSON_DECODER.decode(data));
  } catch {
    return null;
  }
}
