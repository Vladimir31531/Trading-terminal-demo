import { describe, expect, spyOn, test } from 'bun:test';
import {
  loadChartTimeZone,
  saveChartTimeZone,
} from '../src/infrastructure/chart-preferences';

function createStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe('saved chart time zone', () => {
  test('defaults to Chisinau and restores a saved IANA time zone', () => {
    const storage = createStorage();
    expect(loadChartTimeZone(storage)).toBe('Europe/Chisinau');
    saveChartTimeZone('Europe/Chisinau', storage);
    expect(loadChartTimeZone(storage)).toBe('Europe/Chisinau');
    saveChartTimeZone('America/New_York', storage);
    expect(loadChartTimeZone(storage)).toBe('America/New_York');
    saveChartTimeZone('UTC', storage);
    expect(loadChartTimeZone(storage)).toBe('UTC');
  });

  test('ignores invalid stored time zones and preserves the last valid choice', () => {
    const storage = createStorage();
    saveChartTimeZone('Asia/Kolkata', storage);
    for (const value of ['', ' ', 'Mars/Olympus', 'invalid']) {
      expect(loadChartTimeZone({ getItem: () => value })).toBe(
        'Europe/Chisinau',
      );
      saveChartTimeZone(value, storage);
      expect(loadChartTimeZone(storage)).toBe('Asia/Kolkata');
    }
  });

  test('reports read failures and falls back to Chisinau', () => {
    const warning = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(
        loadChartTimeZone({
          getItem: () => {
            throw new Error('Storage unavailable');
          },
        }),
      ).toBe('Europe/Chisinau');
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  test('reports a failed save', () => {
    expect(() =>
      saveChartTimeZone('Europe/Chisinau', {
        setItem: () => {
          throw new Error('Storage unavailable');
        },
      }),
    ).toThrow('Не удалось сохранить часовой пояс графика в браузере.');
  });
});
