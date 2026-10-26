import { describe, expect, test } from 'bun:test';
import {
  loadPointValue,
  savePointValue,
} from '../src/infrastructure/trading-preferences';

function createStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe('saved trading point value', () => {
  test('uses 1 only until a value has been saved, then restores the saved value', () => {
    const storage = createStorage();
    expect(loadPointValue('gold', storage)).toBe('1');
    savePointValue('gold', '2.75', storage);
    expect(loadPointValue('gold', storage)).toBe('2.75');
    expect(loadPointValue('eur-usd', storage)).toBe('1');
    savePointValue('eur-usd', '0.01', storage);
    expect(loadPointValue('eur-usd', storage)).toBe('0.01');
    expect(loadPointValue('gold', storage)).toBe('2.75');
    expect(loadPointValue('new-instrument', storage)).toBe('1');
  });

  test('keeps the last valid value while the input contains an invalid draft', () => {
    const storage = createStorage();
    savePointValue('gold', '2.75', storage);
    savePointValue('eur-usd', '7', storage);
    for (const draft of ['', ' ', '0', '-1', 'NaN', 'Infinity', 'abc']) {
      savePointValue('gold', draft, storage);
      expect(loadPointValue('gold', storage)).toBe('2.75');
      expect(loadPointValue('eur-usd', storage)).toBe('7');
    }
  });

  test('ignores invalid stored values and reports a failed save', () => {
    expect(loadPointValue('gold', { getItem: () => 'invalid' })).toBe('1');
    expect(() =>
      savePointValue('gold', '2.75', {
        setItem: () => {
          throw new Error('Storage unavailable');
        },
      }),
    ).toThrow('Не удалось сохранить цену пункта в браузере.');
  });
});
