import { describe, it, expect, beforeEach } from 'vitest';
import { logger, LOG_LEVELS } from '../src/core/logger.js';

describe('Logger Core System', () => {
  beforeEach(() => {
    logger.clear();
  });

  it('records logs with levels and timestamps', () => {
    logger.info('Test info message');
    logger.warn('Test warn message');
    logger.error('Test error message', { code: 500 });
    logger.success('Test success message');

    const entries = logger.getEntries();
    expect(entries.length).toBe(4);
    expect(entries[0].level).toBe(LOG_LEVELS.INFO);
    expect(entries[0].message).toBe('Test info message');
    expect(entries[2].level).toBe(LOG_LEVELS.ERROR);
    expect(entries[2].detail).toEqual({ code: 500 });

    const stats = logger.getStats();
    expect(stats.total).toBe(4);
    expect(stats.info).toBe(1);
    expect(stats.warn).toBe(1);
    expect(stats.error).toBe(1);
    expect(stats.success).toBe(1);
  });

  it('supports level filtering', () => {
    logger.info('Info 1');
    logger.warn('Warn 1');
    logger.info('Info 2');

    const infoOnly = logger.getEntries(LOG_LEVELS.INFO);
    expect(infoOnly.length).toBe(2);
    expect(infoOnly.every((e) => e.level === LOG_LEVELS.INFO)).toBe(true);

    const warnOnly = logger.getEntries(LOG_LEVELS.WARN);
    expect(warnOnly.length).toBe(1);
  });

  it('broadcasts to subscribers', () => {
    const received = [];
    const unsubscribe = logger.subscribe((entry) => {
      received.push(entry);
    });

    logger.info('Subscribed message 1');
    logger.warn('Subscribed message 2');
    unsubscribe();
    logger.info('Unsubscribed message');

    expect(received.length).toBe(2);
    expect(received[0].message).toBe('Subscribed message 1');
  });

  it('exports formatted text logs', () => {
    logger.info('Start process');
    logger.warn('Careful here', { field: 'value' });
    const text = logger.exportText();

    expect(text).toContain('Start process');
    expect(text).toContain('Careful here');
    expect(text).toContain('Detail:');
  });
});
