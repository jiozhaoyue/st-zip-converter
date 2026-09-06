import { describe, it, expect } from 'vitest';
import { isTavernBuiltinAsset } from '../src/core/builtin-assets.js';

describe('Built-in Assets Pruning (酒馆原生固定资产智能过滤测试)', () => {
  it('identifies official default backgrounds correctly', () => {
    expect(isTavernBuiltinAsset('backgrounds/tavern.png')).toBe(true);
    expect(isTavernBuiltinAsset('backgrounds/Tavern.PNG')).toBe(true);
    expect(isTavernBuiltinAsset('backgrounds/default.png')).toBe(true);
    expect(isTavernBuiltinAsset('data/default-user/backgrounds/cyberpunk.png')).toBe(true);
    expect(isTavernBuiltinAsset('backgrounds/city.jpg')).toBe(true);
  });

  it('keeps user custom backgrounds intact', () => {
    expect(isTavernBuiltinAsset('backgrounds/my-custom-room-2026.png')).toBe(false);
    expect(isTavernBuiltinAsset('backgrounds/fantasy-castle-by-alice.webp')).toBe(false);
    expect(isTavernBuiltinAsset('backgrounds/wallpaper_1920x1080.jpg')).toBe(false);
  });

  it('identifies default theme and avatar files', () => {
    expect(isTavernBuiltinAsset('themes/default.css')).toBe(true);
    expect(isTavernBuiltinAsset('themes/dark.css')).toBe(true);
    expect(isTavernBuiltinAsset('User Avatars/default.png')).toBe(true);
  });

  it('keeps user custom themes and avatars intact', () => {
    expect(isTavernBuiltinAsset('themes/catppuccin-mocha.css')).toBe(false);
    expect(isTavernBuiltinAsset('User Avatars/my-cool-avatar.png')).toBe(false);
  });
});
