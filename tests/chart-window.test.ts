import { describe, expect, test } from 'bun:test';
import {
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

describe('chart history window', () => {
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
