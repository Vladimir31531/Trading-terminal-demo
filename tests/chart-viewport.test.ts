import { describe, expect, test } from 'bun:test';
import type { MarketRepository } from '../src/application/market-repository';
import { MAX_CACHED_CANDLES } from '../src/chart/history-window';
import {
  loadViewportHistory,
  type TimeRange,
  viewportLogicalRange,
} from '../src/chart/viewport';
import type { Candle, Timeframe } from '../src/domain/market';

const utc = (value: string): number => Date.parse(value) / 1000;
const bar = (time: number): Candle => ({
  time,
  open: 10,
  high: 12,
  low: 9,
  close: 11,
});
const minuteBars = (start: number, count: number): Candle[] =>
  Array.from({ length: count }, (_, index) => bar(start + index * 60));

function repositoryFor(candles: Candle[]) {
  const calls: Parameters<MarketRepository['loadCandles']>[] = [];
  const repository: Pick<MarketRepository, 'loadCandles'> = {
    async loadCandles(...args) {
      calls.push(args);
      const [, , before, limit = 800, after] = args;
      const eligible = candles.filter(
        (candle) =>
          (before === undefined || candle.time < before) &&
          (after === undefined || candle.time > after),
      );
      const page =
        after === undefined ? eligible.slice(-limit) : eligible.slice(0, limit);
      const first = page[0]?.time ?? after ?? before;
      const last = page.at(-1)?.time ?? before ?? after;
      return {
        candles: page,
        hasMore:
          first !== undefined && candles.some((candle) => candle.time < first),
        hasNewer:
          last !== undefined && candles.some((candle) => candle.time > last),
      };
    },
  };
  return { repository, calls };
}

describe('history for a retained timeframe viewport', () => {
  test('the first chart opens the latest page', async () => {
    const candles = minuteBars(0, 2_000);
    const { repository, calls } = repositoryFor(candles);
    const result = await loadViewportHistory(repository, 'dataset', '1m');

    expect(calls).toEqual([['dataset', '1m', undefined, 800]]);
    expect(result.candles).toEqual(candles.slice(-800));
    expect(result.hasMore).toBe(true);
    expect(result.hasNewer).toBe(false);
  });

  test('an old viewport loads around its date and retains a bounded cache', async () => {
    const candles = minuteBars(0, 20_000);
    const { repository, calls } = repositoryFor(candles);
    const range = { from: 5_950 * 60, to: 6_050 * 60 };
    const result = await loadViewportHistory(
      repository,
      'dataset',
      '1m',
      range,
    );

    expect(calls).toEqual([
      ['dataset', '1m', 6_000 * 60 + 1, 1_600],
      ['dataset', '1m', undefined, 1_600, 6_000 * 60],
    ]);
    expect(result.candles).toHaveLength(MAX_CACHED_CANDLES);
    expect(result.candles[1_599].time).toBe(6_000 * 60);
    expect(result.candles.at(-1)?.time).toBe(7_600 * 60);
    expect(new Set(result.candles.map((candle) => candle.time)).size).toBe(
      MAX_CACHED_CANDLES,
    );
    expect(result.hasMore).toBe(true);
    expect(result.hasNewer).toBe(true);
  });

  test('all nine timeframes use their UTC calendar bucket as the anchor', async () => {
    const midpoint = utc('2026-03-01T17:49:17Z');
    const expected: [Timeframe, string][] = [
      ['1m', '2026-03-01T17:49:00Z'],
      ['5m', '2026-03-01T17:45:00Z'],
      ['15m', '2026-03-01T17:45:00Z'],
      ['30m', '2026-03-01T17:30:00Z'],
      ['1H', '2026-03-01T17:00:00Z'],
      ['4h', '2026-03-01T16:00:00Z'],
      ['1D', '2026-03-01T00:00:00Z'],
      ['1W', '2026-02-23T00:00:00Z'],
      ['1M', '2026-03-01T00:00:00Z'],
    ];
    for (const [timeframe, date] of expected) {
      const { repository, calls } = repositoryFor([]);
      await loadViewportHistory(repository, 'dataset', timeframe, {
        from: midpoint - 30,
        to: midpoint + 30,
      });
      expect(calls[0][2]).toBe(utc(date) + 1);
      expect(calls[1][4]).toBe(utc(date));
    }
  });

  test('keeps edge flags when one side is empty and handles market gaps', async () => {
    const candles = [bar(60), bar(120), bar(600), bar(660)];
    const { repository } = repositoryFor(candles);
    const atStart = await loadViewportHistory(repository, 'dataset', '1m', {
      from: 0,
      to: 0,
    });
    const atEnd = await loadViewportHistory(repository, 'dataset', '1m', {
      from: 1_000,
      to: 1_000,
    });
    const inGap = await loadViewportHistory(repository, 'dataset', '1m', {
      from: 300,
      to: 420,
    });

    for (const result of [atStart, atEnd, inGap]) {
      expect(result.candles).toEqual(candles);
      expect(result.hasMore).toBe(false);
      expect(result.hasNewer).toBe(false);
    }
    const empty = await loadViewportHistory(
      repositoryFor([]).repository,
      'empty',
      '1m',
      { from: 300, to: 420 },
    );
    expect(empty).toEqual({ candles: [], hasMore: false, hasNewer: false });
  });
});

describe('UTC dates to a target timeframe viewport', () => {
  test('restores the same historical interval after a coarser timeframe round trip', () => {
    const start = utc('2026-08-15T00:00:00Z');
    const candles = minuteBars(start, 24 * 60);
    const range = { from: start + 10 * 3_600, to: start + 12 * 3_600 };
    const days = [bar(start - 86_400), bar(start), bar(start + 86_400)];
    expect(viewportLogicalRange(days, '1D', range, 3_200)).toEqual({
      from: 0.5,
      to: 1.5,
    });
    expect(viewportLogicalRange(candles, '1m', range, 3_200)).toEqual({
      from: 600,
      to: 720,
    });
  });

  test('maps weekly and monthly dates to calendar candles rather than fixed durations', () => {
    const months = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'].map(
      (date) => bar(utc(`${date}T00:00:00Z`)),
    );
    expect(
      viewportLogicalRange(
        months,
        '1M',
        { from: utc('2026-02-28T23:00:00Z'), to: utc('2026-03-02T02:00:00Z') },
        3_200,
      ),
    ).toEqual({ from: 1, to: 2 });
    const weeks = ['2025-12-22', '2025-12-29', '2026-01-05'].map((date) =>
      bar(utc(`${date}T00:00:00Z`)),
    );
    expect(
      viewportLogicalRange(
        weeks,
        '1W',
        { from: utc('2026-01-01T15:00:00Z'), to: utc('2026-01-06T02:00:00Z') },
        3_200,
      ),
    ).toEqual({ from: 1, to: 2 });
  });

  test('retains available dates around gaps without inventing missing candles', () => {
    const candles = [60, 120, 600, 660].map(bar);
    expect(
      viewportLogicalRange(candles, '1m', { from: 120, to: 600 }, 3_200),
    ).toEqual({ from: 1, to: 2 });
    expect(
      viewportLogicalRange(candles, '1m', { from: 240, to: 300 }, 3_200),
    ).toEqual({ from: 0.5, to: 1.5 });
  });

  test('reduces an oversized finer timeframe around the requested calendar center', () => {
    const candles = minuteBars(0, 3_200);
    const range = { from: 0, to: 3_000 * 60 };
    const logical = viewportLogicalRange(candles, '1m', range, 401);
    expect(logical).toEqual({ from: 1_300, to: 1_700 });
    expect(((logical?.from ?? 0) + (logical?.to ?? 0)) / 2).toBe(1_500);

    const clipped = viewportLogicalRange(
      minuteBars(1_000 * 60, 3_200),
      '1m',
      { from: 0, to: 3_000 * 60 },
      401,
    );
    expect(clipped).toEqual({ from: 300, to: 700 });
  });

  test('handles empty, single-candle and clipped source edges', () => {
    const range: TimeRange = { from: 0, to: 600 };
    expect(viewportLogicalRange([], '1m', range, 3_200)).toBeUndefined();
    expect(viewportLogicalRange([bar(300)], '1m', range, 3_200)).toEqual({
      from: -0.5,
      to: 0.5,
    });
    expect(
      viewportLogicalRange(minuteBars(0, 20), '1m', { from: -600, to: 180 }, 5),
    ).toEqual({ from: 0, to: 3 });
  });
});
