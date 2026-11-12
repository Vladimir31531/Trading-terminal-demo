import { describe, expect, test } from 'bun:test';
import {
  normalizeTradeCharacteristic,
  type TradeCharacteristic,
  validateTradeCharacteristicSelections,
} from '../src/domain/trade-characteristics';

const characteristic: TradeCharacteristic = {
  id: 'setup',
  name: '  Торговая модель  ',
  values: ['  Пробой ', ' Отскок  '],
  createdAt: 123,
};

describe('trade characteristics', () => {
  test('normalizes editable fields without changing identity or mutating input', () => {
    const result = normalizeTradeCharacteristic(characteristic);
    expect(result).toEqual({
      id: 'setup',
      name: 'Торговая модель',
      values: ['Пробой', 'Отскок'],
      createdAt: 123,
    });
    expect(characteristic.name).toBe('  Торговая модель  ');
    expect(characteristic.values).toEqual(['  Пробой ', ' Отскок  ']);
    expect(result.values).not.toBe(characteristic.values);
  });

  test('requires a title and at least one named choice', () => {
    expect(() =>
      normalizeTradeCharacteristic({ ...characteristic, name: '  ' }),
    ).toThrow('Укажите название');
    for (const values of [[], [''], ['Пробой', '  ']])
      expect(() =>
        normalizeTradeCharacteristic({ ...characteristic, values }),
      ).toThrow('непустое значение');
  });

  test('rejects choices that become duplicates after trimming', () => {
    expect(() =>
      normalizeTradeCharacteristic({
        ...characteristic,
        values: [' Пробой', 'Пробой '],
      }),
    ).toThrow('не должны повторяться');
    expect(
      normalizeTradeCharacteristic({
        ...characteristic,
        values: ['BUY', 'buy'],
      }).values,
    ).toEqual(['BUY', 'buy']);
  });

  test('accepts an exact selection from every active characteristic', () => {
    const normalized = normalizeTradeCharacteristic(characteristic);
    expect(() =>
      validateTradeCharacteristicSelections([normalized], { setup: 'Пробой' }),
    ).not.toThrow();
    expect(() => validateTradeCharacteristicSelections([], {})).not.toThrow();
  });

  test('requires active choices and rejects stale values or deleted characteristics', () => {
    const normalized = normalizeTradeCharacteristic(characteristic);
    const invalidSelections: Record<string, string>[] = [
      {},
      { setup: '' },
      { setup: 'Удалённое значение' },
    ];
    for (const selections of invalidSelections)
      expect(() =>
        validateTradeCharacteristicSelections([normalized], selections),
      ).toThrow('Выберите значение');
    expect(() =>
      validateTradeCharacteristicSelections([], { setup: 'Пробой' }),
    ).toThrow('Список характеристик изменился');
  });
});
