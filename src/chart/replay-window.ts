import type { Candle, Timeframe } from '../domain/market';
import { aggregateReplayCandle } from '../domain/simulation';
import { mergeHistoryWindow } from './history-window';

const EVICTION_BATCH_SIZE = 800;

/** Advance live candles while retaining a bounded historical viewport. */
export function advanceReplayWindow(
  candles: Candle[],
  forming: Candle | undefined,
  seconds: readonly Candle[],
  timeframe: Timeframe,
  hasNewer: boolean,
  range: { from: number; to: number } | null,
  interacting = false,
) {
  const changes: Candle[] = [];
  for (const second of seconds) {
    forming = aggregateReplayCandle(forming, second, timeframe);
    if (changes.at(-1)?.time === forming.time)
      changes[changes.length - 1] = forming;
    else changes.push(forming);
  }
  if (hasNewer || !changes.length)
    return { candles, forming, changes: [], hasNewer, removedLeft: 0 };

  const lastTime = candles.at(-1)?.time ?? -Infinity;
  const replacement = changes.find((bar) => bar.time === lastTime);
  const current = replacement
    ? [...candles.slice(0, -1), replacement]
    : candles;
  const appended = changes.filter((bar) => bar.time > lastTime);
  const window = mergeHistoryWindow(
    current,
    appended,
    'newer',
    range,
    EVICTION_BATCH_SIZE,
  );
  if (!window.preservesViewport || (interacting && window.removedLeft > 0))
    return { candles, forming, changes: [], hasNewer: true, removedLeft: 0 };
  return {
    candles: window.candles,
    forming,
    changes: changes.filter((bar) => bar.time >= lastTime),
    hasNewer: false,
    removedLeft: window.removedLeft,
  };
}
