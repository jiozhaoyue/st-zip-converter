import { describe, it, expect } from 'vitest';
import {
  resolveFilename,
  previewFilename,
  FILENAME_PRESETS,
  DEFAULT_FILENAME_TEMPLATE,
} from '../src/core/filename-template.js';

describe('Filename Template Engine & Practical Placeholders (实用文件名占位符与预设测试)', () => {
  it('resolves {part}, {category}, {user}, {mode}, {date} placeholders correctly', () => {
    const template = '{target}_{user}_{part}_{category}_{mode}_{date}.zip';
    const result = resolveFilename(template, {
      target: 'st',
      handle: 'Alice',
      part: 'part1_core',
      category: 'core',
      mode: 'split',
      date: '2026-09-06',
    });
    expect(result).toBe('st_Alice_part1_core_core_split_2026-09-06.zip');
  });

  it('handles standard split preset template', () => {
    const result = resolveFilename(FILENAME_PRESETS.SPLIT, {
      target: 'luker',
      handle: 'admin',
      part: 'part2_assets',
      date: '2026-09-06',
    });
    expect(result).toBe('luker_admin_part2_assets_2026-09-06.zip');
  });

  it('handles core backup preset template', () => {
    const result = resolveFilename(FILENAME_PRESETS.CORE, {
      target: 'pt',
      handle: 'Bob',
      date: '2026-09-06',
    });
    expect(result).toBe('pt_core_Bob_2026-09-06.zip');
  });

  it('handles aliases: {username} for {user}, {volume} for {part}', () => {
    const template = 'backup_{username}_{volume}.zip';
    const result = resolveFilename(template, {
      handle: 'admin',
      part: 'part1',
    });
    expect(result).toBe('backup_admin_part1.zip');
  });

  it('sanitizes illegal characters in resulting filenames', () => {
    const template = '{target}_{user}.zip';
    const result = resolveFilename(template, {
      target: 'st',
      handle: 'Alice/Bob:Test*?',
    });
    expect(result).toBe('st_Alice_Bob_Test__.zip');
  });
});
