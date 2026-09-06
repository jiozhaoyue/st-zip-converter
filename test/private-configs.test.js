import { describe, it, expect } from 'vitest';
import { categoryOfHubPath, CATEGORIES } from '../src/core/inspect.js';
import { targetEntryPath, TARGETS, routeSource } from '../src/core/transform.js';
import { LAYOUTS } from '../src/core/detect.js';

describe('Private Configs & Transparent Passthrough (私有配置与透明保真沙箱测试)', () => {
  it('correctly categorizes private configs and rich assets into standard categories', () => {
    // Settings category
    expect(categoryOfHubPath('stats.json')).toBe(CATEGORIES.SETTINGS);
    expect(categoryOfHubPath('macros.json')).toBe(CATEGORIES.SETTINGS);
    expect(categoryOfHubPath('user_data.json')).toBe(CATEGORIES.SETTINGS);

    // Presets category
    expect(categoryOfHubPath('custom_styles.css')).toBe(CATEGORIES.PRESETS);
    expect(categoryOfHubPath('custom.css')).toBe(CATEGORIES.PRESETS);
    expect(categoryOfHubPath('quick-replies/qr.json')).toBe(CATEGORIES.PRESETS);
    expect(categoryOfHubPath('quick_replies/qr.json')).toBe(CATEGORIES.PRESETS);
    expect(categoryOfHubPath('regex/script.json')).toBe(CATEGORIES.PRESETS);

    // Assets category
    expect(categoryOfHubPath('expressions/Alice/joy.png')).toBe(CATEGORIES.ASSETS);
    expect(categoryOfHubPath('sprites/Alice/default.png')).toBe(CATEGORIES.ASSETS);
    expect(categoryOfHubPath('speech/alice-tts-01.wav')).toBe(CATEGORIES.ASSETS);
    expect(categoryOfHubPath('sounds/bell.mp3')).toBe(CATEGORIES.ASSETS);
  });

  it('safely wraps Luker private files into _compat/luker/ when converting to non-Luker platforms', () => {
    // Target ST (摊平)
    expect(targetEntryPath('stats.json', TARGETS.ST)).toBe('_compat/luker/stats.json');
    expect(targetEntryPath('macros.json', TARGETS.ST)).toBe('_compat/luker/macros.json');

    // Target PT (data/default-user/)
    expect(targetEntryPath('stats.json', TARGETS.PT)).toBe('data/default-user/_compat/luker/stats.json');

    // Target TT (data/default-user/)
    expect(targetEntryPath('stats.json', TARGETS.TT)).toBe('data/default-user/_compat/luker/stats.json');

    // Target L (Luker) -> preserves root location
    expect(targetEntryPath('stats.json', TARGETS.L)).toBe('stats.json');
    expect(targetEntryPath('macros.json', TARGETS.L)).toBe('macros.json');
  });

  it('unwraps _compat/luker/ back to original location when converting back to Luker', () => {
    const unwrapToLuker = targetEntryPath('_compat/luker/stats.json', TARGETS.L);
    expect(unwrapToLuker).toBe('stats.json');

    const unwrapMacros = targetEntryPath('_compat/luker/macros.json', TARGETS.L);
    expect(unwrapMacros).toBe('macros.json');
  });

  it('routes compat paths correctly in routeSource', () => {
    const routedSt = routeSource('_compat/luker/stats.json', LAYOUTS.ST);
    expect(routedSt.kind).toBe('compat');
    expect(routedSt.hubPath).toBe('_compat/luker/stats.json');

    const routedTt = routeSource('data/default-user/_compat/luker/stats.json', LAYOUTS.TT);
    expect(routedTt.kind).toBe('compat');
    expect(routedTt.hubPath).toBe('_compat/luker/stats.json');
  });
});
