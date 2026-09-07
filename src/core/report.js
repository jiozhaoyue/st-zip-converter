/**
 * 转换报告:每模块复制/丢弃/合成计数、丢弃清单与警告。
 * PRD R2:丢弃项必须逐条列出;R3:人类可读 + --json 机器可读。
 */

export const MODULES = Object.freeze({
  settings: 'settings',
  secrets: 'secrets',
  characters: 'characters',
  chats: 'chats',
  lorebooks: 'lorebooks',
  presets: 'presets',
  assets: 'assets',
  extensions: 'extensions',
  meta: 'meta',
  derived: 'derived',
  other: 'other',
});

const PRESET_DIRS = [
  'OpenAI Settings/',
  'NovelAI Settings/',
  'KoboldAI Settings/',
  'TextGen Settings/',
  'instruct/',
  'context/',
  'sysprompt/',
  'reasoning/',
  'themes/',
  'movingUI/',
  'QuickReplies/',
];

/** hub(ST 摊平)路径 → 报告模块名。 */
export function classifyModule(hubPath) {
  if (hubPath === 'settings.json') return MODULES.settings;
  if (hubPath === 'secrets.json') return MODULES.secrets;
  if (hubPath === 'manifest.json' || hubPath.startsWith('_engine_') || hubPath.startsWith('_tauritavern/')) {
    return MODULES.meta;
  }
  if (hubPath.startsWith('characters/')) return MODULES.characters;
  if (hubPath.startsWith('chats/') || hubPath.startsWith('groups/') || hubPath.startsWith('group chats/')) {
    return MODULES.chats;
  }
  if (hubPath.startsWith('worlds/')) return MODULES.lorebooks;
  if (PRESET_DIRS.some((dir) => hubPath.startsWith(dir))) return MODULES.presets;
  if (
    hubPath.startsWith('User Avatars/')
    || hubPath.startsWith('assets/')
    || hubPath.startsWith('backgrounds/')
    || hubPath.startsWith('user/')
  ) {
    return MODULES.assets;
  }
  if (hubPath.startsWith('extensions/')) return MODULES.extensions;
  return MODULES.other;
}

export class Report {
  #sourceLayout;
  #target;
  #modules = new Map();
  #dropped = [];
  #filtered = [];
  #warnings = [];
  #synthesized = [];
  #storeBypass = { count: 0, bytes: 0 };

  constructor(sourceLayout, target) {
    this.#sourceLayout = sourceLayout;
    this.#target = target;
  }

  get target() {
    return this.#target;
  }

  /**
   * 记录 Store 直存统计（已压缩扩展名条目绕过 deflate 的数量与字节量）
   * @param {number} count
   * @param {number} bytes
   */
  setStoreBypass(count, bytes) {
    this.#storeBypass = { count: count || 0, bytes: bytes || 0 };
  }

  setSourceLayout(layout) {
    this.#sourceLayout = layout;
  }

  #module(name) {
    let bucket = this.#modules.get(name);
    if (!bucket) {
      bucket = { copied: 0, dropped: 0, synthesized: 0, filtered: 0, bytes: 0 };
      this.#modules.set(name, bucket);
    }
    return bucket;
  }

  copied(hubPath, bytes = 0) {
    const bucket = this.#module(classifyModule(hubPath));
    bucket.copied += 1;
    bucket.bytes += bytes;
  }

  dropped(hubPath, reason) {
    const bucket = this.#module(classifyModule(hubPath));
    bucket.dropped += 1;
    this.#dropped.push({ path: hubPath, reason });
  }

  filtered(hubPath, category) {
    const bucket = this.#module(classifyModule(hubPath));
    bucket.filtered = (bucket.filtered || 0) + 1;
    this.#filtered.push({ path: hubPath, category });
  }

  synthesized(hubPath) {
    const bucket = this.#module(classifyModule(hubPath));
    bucket.synthesized += 1;
    this.#synthesized.push(hubPath);
  }

  warn(message) {
    this.#warnings.push(message);
  }

  toJSON() {
    return {
      sourceLayout: this.#sourceLayout,
      target: this.#target,
      modules: Object.fromEntries([...this.#modules.entries()].sort(([a], [b]) => a.localeCompare(b))),
      dropped: this.#dropped,
      filtered: this.#filtered,
      synthesized: this.#synthesized,
      warnings: this.#warnings,
      storeBypass: { ...this.#storeBypass },
      totals: {
        copied: [...this.#modules.values()].reduce((sum, m) => sum + m.copied, 0),
        dropped: this.#dropped.length,
        filtered: this.#filtered.length,
        synthesized: this.#synthesized.length,
        warnings: this.#warnings.length,
      },
    };
  }

  toHuman() {
    const json = this.toJSON();
    const lines = [];
    lines.push(`转换报告: ${json.sourceLayout} -> ${json.target}`);
    lines.push('模块            复制   丢弃   合成   字节');
    for (const [name, m] of Object.entries(json.modules)) {
      lines.push(
        `${name.padEnd(14)} ${String(m.copied).padStart(6)} ${String(m.dropped).padStart(6)} ${String(m.synthesized).padStart(6)} ${String(m.bytes).padStart(10)}`,
      );
    }
    lines.push(
      `合计            ${String(json.totals.copied).padStart(6)} ${String(json.totals.dropped).padStart(6)} ${String(json.totals.synthesized).padStart(6)}`,
    );
    if (json.dropped.length > 0) {
      lines.push(`丢弃清单 (${json.dropped.length}):`);
      for (const item of json.dropped) {
        lines.push(`  - ${item.path}  [${item.reason}]`);
      }
    }
    if (json.warnings.length > 0) {
      lines.push(`警告 (${json.warnings.length}):`);
      for (const warning of json.warnings) {
        lines.push(`  ! ${warning}`);
      }
    }
    return lines.join('\n');
  }
}
