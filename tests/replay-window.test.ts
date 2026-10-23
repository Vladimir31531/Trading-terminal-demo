import { describe, expect, test } from 'bun:test';
import { MAX_CACHED_CANDLES } from '../src/chart/history-window';
import { advanceReplayWindow } from '../src/chart/replay-window';
import type { Candle } from '../src/domain/market';

const bar = (time: number, close = 100): Candle => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
});
const history = () =>
  Array.from({ length: MAX_CACHED_CANDLES }, (_, i) => bar(i * 60));

describe('live replay chart window', () => {
  test('updates the partial candle and appends only already delivered minute buckets', () => {
    const previous: Candle = {
      time: 0,
      open: 100,
      high: 105,
      low: 99,
      close: 104,
    };
    const source = [bar(-60), previous];
    const snapshot = structuredClone(source);
    const result = advanceReplayWindow(
      source,
      previous,
      [
        { time: 59, open: 104, high: 104, low: 102, close: 103 },
        { time: 60, open: 103, high: 108, low: 101, close: 107 },
        { time: 61, open: 107, high: 107, low: 105, close: 106 },
      ],
      '1m',
      false,
      { from: -2, to: 5 },
    );
    expect(result.candles).toEqual([
      bar(-60),
      { ...previous, close: 103 },
      { time: 60, open: 103, high: 108, low: 101, close: 106 },
    ]);
    expect(result.changes).toEqual(result.candles.slice(1));
    expect(result.forming).toEqual(result.candles.at(-1));
    expect(source).toEqual(snapshot);
  });

  test('many updates in one minute retain one candle with the latest Close', () => {
    let candles = [bar(0)];
    let forming: Candle | undefined = candles[0];
    for (let second = 1; second < 60; second++) {
      const result = advanceReplayWindow(
        candles,
        forming,
        [bar(second, 100 + second)],
        '1m',
        false,
        null,
      );
      candles = result.candles;
      forming = result.forming;
    }
    expect(candles).toEqual([
      { time: 0, open: 100, high: 159, low: 100, close: 159 },
    ]);
  });

  test('browsing old history keeps its window while the independent live candle advances', () => {
    const candles = [bar(0), bar(60)];
    const result = advanceReplayWindow(
      candles,
      bar(600),
      [bar(601, 102), bar(660, 103)],
      '1m',
      true,
      null,
    );
    expect(result.candles).toBe(candles);
    expect(result.changes).toEqual([]);
    expect(result.forming).toEqual(bar(660, 103));
    expect(result.hasNewer).toBe(true);
  });

  test('live eviction bounds memory and keeps the same visible dates with its offset', () => {
    const candles = history();
    const next = MAX_CACHED_CANDLES * 60;
    const result = advanceReplayWindow(
      candles,
      candles.at(-1),
      [bar(next, 101)],
      '1m',
      false,
      { from: 3090, to: 3205 },
    );
    expect(result.candles).toHaveLength(MAX_CACHED_CANDLES);
    expect(result.removedLeft).toBe(1);
    expect(result.candles[3089].time).toBe(candles[3090].time);
    expect(result.candles.at(-1)).toEqual(bar(next, 101));
  });

  test('a visible oldest candle is not evicted to display an offscreen new price', () => {
    const candles = history();
    const next = MAX_CACHED_CANDLES * 60;
    const result = advanceReplayWindow(
      candles,
      candles.at(-1),
      [bar(next)],
      '1m',
      false,
      { from: 0, to: 100 },
    );
    expect(result.candles).toBe(candles);
    expect(result.removedLeft).toBe(0);
    expect(result.hasNewer).toBe(true);
    expect(result.forming?.time).toBe(next);
  });

  test('a drag or kinetic scroll never changes cached indices, even at the live edge', () => {
    const candles = history();
    const result = advanceReplayWindow(
      candles,
      candles.at(-1),
      [bar(MAX_CACHED_CANDLES * 60)],
      '1m',
      false,
      { from: 3090, to: 3205 },
      true,
    );
    expect(result.candles).toBe(candles);
    expect(result.changes).toEqual([]);
    expect(result.removedLeft).toBe(0);
    expect(result.hasNewer).toBe(true);
  });
});
