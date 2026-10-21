import { describe, expect, test } from 'bun:test';
import {
  normalizeTicker,
  parseCsvCandle,
  validateCsvFile,
  validateCsvHeader,
} from '../src/domain/csv-validation';

const row = [
  '2026-01-01 23:00:00.000+00:00',
  '4323.698',
  '4323.898',
  '4323.698',
  '4323.898',
  '240',
];

describe('CSV structure', () => {
  test('requires a nonempty CSV file', () => {
    expect(() =>
      validateCsvFile({ name: 'prices.CSV', size: 1 }),
    ).not.toThrow();
    expect(() => validateCsvFile({ name: 'prices.json', size: 1 })).toThrow();
    expect(() => validateCsvFile({ name: 'prices.csv', size: 0 })).toThrow();
  });

  test('requires the exact header and column order', () => {
    expect(() =>
      validateCsvHeader(['Time', 'Open', 'High', 'Low', 'Close', 'Volume']),
    ).not.toThrow();
    expect(() =>
      validateCsvHeader(['Time', 'High', 'Open', 'Low', 'Close', 'Volume']),
    ).toThrow();
    expect(() =>
      validateCsvHeader(['Time', 'Open', 'High', 'Low', 'Close']),
    ).toThrow();
    expect(() =>
      validateCsvHeader(['time', 'Open', 'High', 'Low', 'Close', 'Volume']),
    ).toThrow();
    expect(() => parseCsvCandle(row.slice(0, 5), 2)).toThrow();
    expect(() => parseCsvCandle([...row, 'extra'], 2)).toThrow();
  });

  test('parses UTC OHLC and never uses Volume', () => {
    expect(parseCsvCandle([...row.slice(0, 5), 'unused'], 2)).toEqual({
      time: Date.parse('2026-01-01T23:00:00Z') / 1000,
      open: 4323.698,
      high: 4323.898,
      low: 4323.698,
      close: 4323.898,
    });
  });
});

describe('CSV row validation', () => {
  test('rejects invalid dates and non-UTC timestamps', () => {
    for (const time of [
      '2026-02-30 23:00:00.000+00:00',
      '2026-01-01 23:00:00+02:00',
      'invalid',
    ]) {
      expect(() => parseCsvCandle([time, ...row.slice(1)], 2)).toThrow();
    }
  });

  test('rejects duplicate and out-of-order timestamps', () => {
    const time = parseCsvCandle(row, 2).time;
    expect(() => parseCsvCandle(row, 3, time)).toThrow();
    expect(() => parseCsvCandle(row, 3, time + 1)).toThrow();
    expect(() => parseCsvCandle(row, 3, time - 1)).not.toThrow();
  });

  test('rejects non-finite values, missing prices and inconsistent ranges', () => {
    for (const value of ['', 'NaN', 'Infinity', '1e999', '0x123']) {
      expect(() =>
        parseCsvCandle([row[0], value, ...row.slice(2)], 2),
      ).toThrow();
    }
    expect(() =>
      parseCsvCandle([row[0], '10', '8', '7', '9', '0'], 2),
    ).toThrow();
    expect(() =>
      parseCsvCandle([row[0], '10', '12', '11', '12', '0'], 2),
    ).toThrow();
  });

  test('normalizes instrument tickers', () => {
    expect(normalizeTicker(' xau-usd ')).toBe('XAU-USD');
    expect(() => normalizeTicker('  ')).toThrow();
  });
});
