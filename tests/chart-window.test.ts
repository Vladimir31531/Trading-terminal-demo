import { describe, expect, test } from 'bun:test';
import {
  historyLoadDirection,
  MAX_CACHED_CANDLES,
  mergeHistoryWindow,
} from '../src/chart/history-window';
import type { Candle } from '../src/domain/market';

const PAGE_SIZE = 800;
const candles = (first: number, count: number): Candle[] =>
  Array.from({ length: count }, (_, index) => ({
    time: (first + index) * 60,
    open: 10,
    high: 12,
    low: 9,
    close: 11,
  }));

describe('history loading direction', () => {
  const available = { older: true, newer: true };

  test('approaching either loaded edge requests its page', () => {
    expect(
      historyLoadDirection(
        { from: 70, to: 180 },
        { from: 100, to: 210 },
        3_200,
        available,
      ),
    ).toBe('older');
    expect(
      historyLoadDirection(
        { from: 3_030, to: 3_140 },
        { from: 3_000, to: 3_110 },
        3_200,
        available,
      ),
    ).toBe('newer');
  });

  test('moving away from an edge does not reload the opposite page', () => {
    expect(
      historyLoadDirection({ from: 10, to: 120 }, { from: 0, to: 110 }, 3_200, {
        older: true,
        newer: false,
      }),
    ).toBeUndefined();
    expect(
      historyLoadDirection(
        { from: 3_000, to: 3_150 },
        { from: 3_010, to: 3_160 },
        3_200,
        { older: false, newer: true },
      ),
    ).toBeUndefined();
  });

  test('a wide viewport follows the pan direction even when both edges are near', () => {
    const left = { from: 40, to: 3_140 };
    const right = { from: 50, to: 3_150 };
    expect(historyLoadDirection(left, right, 3_200, available)).toBe('older');
    expect(historyLoadDirection(right, left, 3_200, available)).toBe('newer');
  });

  test('zooming out through both edges prioritizes the larger overflow', () => {
    const previous = { from: 100, to: 3_100 };
    expect(
      historyLoadDirection({ from: 0, to: 3_140 }, previous, 3_200, available),
    ).toBe('older');
    expect(
      historyLoadDirection({ from: 60, to: 3_200 }, previous, 3_200, available),
    ).toBe('newer');
  });

  test('restored ranges, zooming in, interior pans and exhausted edges stay idle', () => {
    const range = { from: 40, to: 3_150 };
    expect(historyLoadDirection(range, null, 3_200, available)).toBeUndefined();
    expect(
      historyLoadDirection(range, range, 3_200, available),
    ).toBeUndefined();
    expect(
      historyLoadDirection({ from: 50, to: 3_140 }, range, 3_200, available),
    ).toBeUndefined();
    expect(
      historyLoadDirection(
        { from: 200, to: 310 },
        { from: 210, to: 320 },
        3_200,
        available,
      ),
    ).toBeUndefined();
    expect(
      historyLoadDirection({ from: 0, to: 3_200 }, range, 3_200, {
        older: false,
        newer: false,
      }),
    ).toBeUndefined();
  });
});

describe('chart history window', () => {
  test('does not admit a page that would evict the viewport after a reversed gesture', () => {
    const current = candles(10_000, MAX_CACHED_CANDLES);
    const older = candles(9_200, PAGE_SIZE);
    const newer = candles(13_200, PAGE_SIZE);
    expect(
      mergeHistoryWindow(current, older, 'older', {
        from: 3_000,
        to: 3_110,
      }).preservesViewport,
    ).toBe(false);
    expect(
      mergeHistoryWindow(current, newer, 'newer', { from: 40, to: 150 })
        .preservesViewport,
    ).toBe(false);
    expect(current).toEqual(candles(10_000, MAX_CACHED_CANDLES));
  });

  test('protects the visible far edge when a wide zoom spans most of the cache', () => {
    const current = candles(10_000, MAX_CACHED_CANDLES);
    const visible = { from: 50, to: 3_150 };
    expect(
      mergeHistoryWindow(current, candles(9_200, PAGE_SIZE), 'older', visible)
        .preservesViewport,
    ).toBe(false);
    expect(
      mergeHistoryWindow(current, candles(13_200, PAGE_SIZE), 'newer', visible)
        .preservesViewport,
    ).toBe(false);
  });

  test('admits pages when eviction affects only candles outside the viewport', () => {
    const current = candles(10_000, MAX_CACHED_CANDLES);
    expect(
      mergeHistoryWindow(current, candles(9_200, PAGE_SIZE), 'older', {
        from: 40.25,
        to: 150.75,
      }).preservesViewport,
    ).toBe(true);
    expect(
      mergeHistoryWindow(current, candles(13_200, PAGE_SIZE), 'newer', {
        from: 3_000.25,
        to: 3_110.75,
      }).preservesViewport,
    ).toBe(true);
  });

  test('protects candles partially visible at fractional viewport boundaries', () => {
    const current = candles(10_000, MAX_CACHED_CANDLES);
    const older = candles(9_200, PAGE_SIZE);
    const newer = candles(13_200, PAGE_SIZE);
    expect(
      mergeHistoryWindow(current, newer, 'newer', {
        from: 799.5,
        to: 1_000,
      }).preservesViewport,
    ).toBe(false);
    expect(
      mergeHistoryWindow(current, newer, 'newer', { from: 800, to: 1_000 })
        .preservesViewport,
    ).toBe(true);
    expect(
      mergeHistoryWindow(current, older, 'older', {
        from: 2_000,
        to: 2_399.5,
      }).preservesViewport,
    ).toBe(false);
    expect(
      mergeHistoryWindow(current, older, 'older', { from: 2_000, to: 2_399 })
        .preservesViewport,
    ).toBe(true);
  });

  test('pages without eviction and callers without a viewport remain admissible', () => {
    const current = candles(10_000, MAX_CACHED_CANDLES);
    const visible = { from: -10, to: 3_210 };
    expect(
      mergeHistoryWindow(current, [], 'older', visible).preservesViewport,
    ).toBe(true);
    expect(
      mergeHistoryWindow(
        current.slice(0, PAGE_SIZE),
        candles(9_200, PAGE_SIZE),
        'older',
        { from: 0, to: 799 },
      ).preservesViewport,
    ).toBe(true);
    expect(
      mergeHistoryWindow(current, candles(9_200, PAGE_SIZE), 'older')
        .preservesViewport,
    ).toBe(true);
  });

  test('browsing many older pages keeps memory bounded and the viewport on the same candles', () => {
    let bars = candles(100_000, PAGE_SIZE);
    for (let page = 0; page < 30; page++) {
      const from = 40.25;
      const to = 150.75;
      const visibleStart = bars[Math.floor(from)].time;
      const visibleEnd = bars[Math.floor(to)].time;
      const previous = candles(bars[0].time / 60 - PAGE_SIZE, PAGE_SIZE);
      const result = mergeHistoryWindow(bars, previous, 'older');
      bars = result.candles;

      expect(bars.length).toBeLessThanOrEqual(MAX_CACHED_CANDLES);
      expect(bars[Math.floor(from + result.logicalOffset)].time).toBe(
        visibleStart,
      );
      expect(bars[Math.floor(to + result.logicalOffset)].time).toBe(visibleEnd);
      expect((from + result.logicalOffset) % 1).toBe(0.25);
      expect((to + result.logicalOffset) % 1).toBe(0.75);
    }
  });

  test('returning through evicted newer pages preserves the viewport and reconstructs the latest candles', () => {
    const original = candles(100_000, PAGE_SIZE);
    let bars = original;
    for (let page = 0; page < 10; page++) {
      bars = mergeHistoryWindow(
        bars,
        candles(bars[0].time / 60 - PAGE_SIZE, PAGE_SIZE),
        'older',
      ).candles;
    }
    while ((bars.at(-1)?.time ?? 0) < original[0].time) {
      const from = bars.length - 150.75;
      const to = bars.length - 40.25;
      const visibleStart = bars[Math.floor(from)].time;
      const visibleEnd = bars[Math.floor(to)].time;
      const result = mergeHistoryWindow(
        bars,
        candles((bars.at(-1)?.time ?? 0) / 60 + 1, PAGE_SIZE),
        'newer',
      );
      bars = result.candles;

      expect(bars).toHaveLength(MAX_CACHED_CANDLES);
      expect(bars[Math.floor(from + result.logicalOffset)].time).toBe(
        visibleStart,
      );
      expect(bars[Math.floor(to + result.logicalOffset)].time).toBe(visibleEnd);
    }
    expect(bars.slice(-PAGE_SIZE)).toEqual(original);
    expect(new Set(bars.map((bar) => bar.time)).size).toBe(bars.length);
    expect(
      bars.every((bar, index) => !index || bars[index - 1].time < bar.time),
    ).toBe(true);
  });

  test('short pages and exhausted history do not evict retained candles unnecessarily', () => {
    const initial = candles(50, 10);
    const previous = mergeHistoryWindow(initial, candles(45, 5), 'older');
    const exhausted = mergeHistoryWindow(previous.candles, [], 'older');
    const next = mergeHistoryWindow(exhausted.candles, candles(60, 3), 'newer');

    expect(initial).toEqual(candles(50, 10));
    expect(previous.logicalOffset).toBe(5);
    expect(exhausted.logicalOffset).toBe(0);
    expect(next.logicalOffset).toBe(0);
    expect(next.candles).toEqual(candles(45, 18));
    expect(next.removedLeft + next.removedRight).toBe(0);
  });
});
