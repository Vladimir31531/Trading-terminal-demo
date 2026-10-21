import type { MarketRepository } from '../application/market-repository';
import { candleStart } from '../domain/aggregation';
import type { Candle, HistoryPage, Timeframe } from '../domain/market';
import { MAX_CACHED_CANDLES } from './history-window';

const INITIAL_PAGE_SIZE = 800;
const SIDE_PAGE_SIZE = MAX_CACHED_CANDLES / 2;

export interface TimeRange {
  from: number;
  to: number;
}

export async function loadViewportHistory(
  repository: Pick<MarketRepository, 'loadCandles'>,
  datasetId: string,
  timeframe: Timeframe,
  range?: TimeRange,
): Promise<HistoryPage> {
  if (!range)
    return repository.loadCandles(
      datasetId,
      timeframe,
      undefined,
      INITIAL_PAGE_SIZE,
    );

  const anchor = candleStart((range.from + range.to) / 2, timeframe);
  const [older, newer] = await Promise.all([
    repository.loadCandles(datasetId, timeframe, anchor + 1, SIDE_PAGE_SIZE),
    repository.loadCandles(
      datasetId,
      timeframe,
      undefined,
      SIDE_PAGE_SIZE,
      anchor,
    ),
  ]);
  return {
    candles: [...older.candles, ...newer.candles],
    hasMore: older.candles.length ? older.hasMore : newer.hasMore,
    hasNewer: newer.candles.length ? newer.hasNewer : older.hasNewer,
  };
}

/** Index of the first candle at or after a UTC time, or candles.length. */
function lowerBound(candles: Candle[], time: number): number {
  let left = 0;
  let right = candles.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (candles[middle].time < time) left = middle + 1;
    else right = middle;
  }
  return left;
}

function nearestIndex(candles: Candle[], time: number): number {
  const next = lowerBound(candles, time);
  if (next === candles.length) return next - 1;
  if (!next) return 0;
  return time - candles[next - 1].time <= candles[next].time - time
    ? next - 1
    : next;
}

/** Restore UTC dates, reducing an oversized range around the same calendar anchor. */
export function viewportLogicalRange(
  candles: Candle[],
  timeframe: Timeframe,
  range: TimeRange,
  maxVisibleBars: number,
): TimeRange | undefined {
  if (!candles.length) return undefined;
  const firstTime = candles[0].time;
  const lastTime = candles[candles.length - 1].time;
  const start = candleStart(range.from, timeframe);
  const end = candleStart(range.to, timeframe);
  const from = Math.min(lowerBound(candles, start), candles.length - 1);
  const afterEnd = lowerBound(candles, end);
  const to = Math.max(
    0,
    afterEnd < candles.length && candles[afterEnd].time === end
      ? afterEnd
      : afterEnd - 1,
  );
  const limit = Math.max(2, Math.min(MAX_CACHED_CANDLES, maxVisibleBars));
  const count = Math.max(2, to - from + 1);
  const clipped = count > limit || start < firstTime || end > lastTime;

  if (!clipped && from < to) return { from, to };

  const center = nearestIndex(
    candles,
    candleStart((range.from + range.to) / 2, timeframe),
  );
  const visibleCount = Math.min(count, limit, Math.max(2, candles.length));
  const halfSpan = (visibleCount - 1) / 2;
  if (visibleCount === 2 && (from >= to || candles.length === 1))
    return { from: center - halfSpan, to: center + halfSpan };

  const left = Math.max(
    0,
    Math.min(candles.length - visibleCount, center - halfSpan),
  );
  return { from: left, to: left + visibleCount - 1 };
}
