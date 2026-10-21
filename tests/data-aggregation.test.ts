import { describe, expect, test } from 'bun:test';
import { CandleAggregator, candleStart } from '../src/domain/aggregation';
import { TIMEFRAMES } from '../src/domain/market';

const utc = (value: string): number => Date.parse(value) / 1000;

describe('UTC timeframe boundaries', () => {
  test('uses Monday for weekly candles across a year boundary', () => {
    expect(candleStart(utc('2026-01-01T23:00:00Z'), '1W')).toBe(
      utc('2025-12-29T00:00:00Z'),
    );
    expect(candleStart(utc('2026-01-05T00:00:00Z'), '1W')).toBe(
      utc('2026-01-05T00:00:00Z'),
    );
  });

  test('uses calendar months and UTC intraday boundaries', () => {
    expect(candleStart(utc('2026-02-28T23:59:59Z'), '1M')).toBe(
      utc('2026-02-01T00:00:00Z'),
    );
    expect(candleStart(utc('2026-03-01T00:00:00Z'), '1M')).toBe(
      utc('2026-03-01T00:00:00Z'),
    );
    expect(candleStart(utc('2026-10-20T15:59:59Z'), '4h')).toBe(
      utc('2026-10-20T12:00:00Z'),
    );
  });
});

describe('streaming OHLC aggregation', () => {
  test('retains the first open, extrema and last close across chunk boundaries', () => {
    const aggregator = new CandleAggregator();
    const time = utc('2026-01-02T10:00:00Z');
    aggregator.add({ time, open: 10, high: 14, low: 9, close: 12 });
    aggregator.add({ time: time + 30, open: 12, high: 15, low: 8, close: 11 });
    const completed = aggregator.add({
      time: time + 60,
      open: 11,
      high: 13,
      low: 10,
      close: 13,
    });

    expect(completed).toEqual([
      { timeframe: '1m', time, open: 10, high: 15, low: 8, close: 11 },
    ]);
    const remaining = aggregator.flush();
    expect(remaining).toHaveLength(TIMEFRAMES.length);
    expect(remaining.find((candle) => candle.timeframe === '5m')).toEqual({
      timeframe: '5m',
      time,
      open: 10,
      high: 15,
      low: 8,
      close: 13,
    });
    expect(aggregator.flush()).toEqual([]);
  });

  test('keeps market gaps without generating synthetic candles', () => {
    const aggregator = new CandleAggregator();
    const friday = utc('2026-01-02T21:59:00Z');
    const monday = utc('2026-01-05T00:00:00Z');
    aggregator.add({ time: friday, open: 10, high: 10, low: 10, close: 10 });
    const completed = aggregator.add({
      time: monday,
      open: 12,
      high: 12,
      low: 12,
      close: 12,
    });
    expect(
      completed.filter((candle) => candle.timeframe === '1m'),
    ).toHaveLength(1);
    expect(
      aggregator.flush().find((candle) => candle.timeframe === '1m')?.time,
    ).toBe(monday);
  });
});
