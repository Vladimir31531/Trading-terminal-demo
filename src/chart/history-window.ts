import type { Candle } from '../domain/market';

export const MAX_CACHED_CANDLES = 3200;
const HISTORY_THRESHOLD = 80;

export type HistoryDirection = 'older' | 'newer';

/** Load only the edge that the viewport is approaching. */
export function historyLoadDirection(
  range: { from: number; to: number },
  previous: { from: number; to: number } | null,
  count: number,
  available: { older: boolean; newer: boolean },
): HistoryDirection | undefined {
  if (!previous) return undefined;
  const olderOverflow = HISTORY_THRESHOLD - range.from;
  const newerOverflow = range.to - (count - HISTORY_THRESHOLD);
  const older =
    available.older && olderOverflow > 0 && range.from < previous.from;
  const newer = available.newer && newerOverflow > 0 && range.to > previous.to;
  if (older && newer) return olderOverflow >= newerOverflow ? 'older' : 'newer';
  if (older) return 'older';
  if (newer) return 'newer';
  return undefined;
}

/** Keep the page being approached and release the far end of the chart history. */
export function mergeHistoryWindow(
  current: Candle[],
  page: Candle[],
  direction: HistoryDirection,
  visibleRange?: { from: number; to: number } | null,
  evictionBatchSize = 1,
) {
  const combined =
    direction === 'older' ? [...page, ...current] : [...current, ...page];
  const overflow = Math.max(0, combined.length - MAX_CACHED_CANDLES);
  const outsideViewport = !visibleRange
    ? combined.length
    : direction === 'newer'
      ? Math.max(0, Math.floor(visibleRange.from))
      : Math.max(0, current.length - 1 - Math.ceil(visibleRange.to));
  // Leave room for live appends without evicting any visible candle.
  const removed = Math.max(
    overflow,
    Math.min(
      Math.ceil(overflow / evictionBatchSize) * evictionBatchSize,
      outsideViewport,
    ),
  );
  const removedLeft = direction === 'newer' ? removed : 0;
  const removedRight = direction === 'older' ? removed : 0;
  return {
    candles: combined.slice(removedLeft, combined.length - removedRight),
    // Applying this offset to both logical range endpoints retains their times.
    logicalOffset: (direction === 'older' ? page.length : 0) - removedLeft,
    removedLeft,
    removedRight,
    preservesViewport:
      !visibleRange ||
      (removedLeft <= Math.max(0, Math.floor(visibleRange.from)) &&
        removedRight <=
          Math.max(0, current.length - 1 - Math.ceil(visibleRange.to))),
  };
}
