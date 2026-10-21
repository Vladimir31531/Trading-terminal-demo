import type { Candle } from '../domain/market';

export const MAX_CACHED_CANDLES = 3200;

export type HistoryDirection = 'older' | 'newer';

/** Keep the page being approached and release the far end of the chart history. */
export function mergeHistoryWindow(
  current: Candle[],
  page: Candle[],
  direction: HistoryDirection,
) {
  const combined =
    direction === 'older' ? [...page, ...current] : [...current, ...page];
  const overflow = Math.max(0, combined.length - MAX_CACHED_CANDLES);
  const removedLeft = direction === 'newer' ? overflow : 0;
  const removedRight = direction === 'older' ? overflow : 0;
  return {
    candles: combined.slice(removedLeft, combined.length - removedRight),
    // Applying this offset to both logical range endpoints retains their times.
    logicalOffset: (direction === 'older' ? page.length : 0) - removedLeft,
    removedLeft,
    removedRight,
  };
}
