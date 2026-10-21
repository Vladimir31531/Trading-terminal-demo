import { type Candle, TIMEFRAMES, type Timeframe } from './market';

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const FIXED_DURATIONS: Partial<Record<Timeframe, number>> = {
  '1m': MINUTE,
  '5m': 5 * MINUTE,
  '15m': 15 * MINUTE,
  '30m': 30 * MINUTE,
  '1H': HOUR,
  '4h': 4 * HOUR,
  '1D': DAY,
};

export function candleStart(time: number, timeframe: Timeframe): number {
  const duration = FIXED_DURATIONS[timeframe];
  if (duration !== undefined) return Math.floor(time / duration) * duration;

  const date = new Date(time * 1000);
  date.setUTCHours(0, 0, 0, 0);

  if (timeframe === '1W') {
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  } else {
    date.setUTCDate(1);
  }

  return date.getTime() / 1000;
}

export interface AggregatedCandle extends Candle {
  timeframe: Timeframe;
}

/** Aggregates an ordered stream while retaining only one candle per timeframe. */
export class CandleAggregator {
  private readonly current = new Map<Timeframe, AggregatedCandle>();

  add(candle: Candle): AggregatedCandle[] {
    const completed: AggregatedCandle[] = [];

    for (const timeframe of TIMEFRAMES) {
      const time = candleStart(candle.time, timeframe);
      const existing = this.current.get(timeframe);

      if (existing?.time === time) {
        existing.high = Math.max(existing.high, candle.high);
        existing.low = Math.min(existing.low, candle.low);
        existing.close = candle.close;
      } else {
        if (existing) completed.push(existing);
        this.current.set(timeframe, { ...candle, time, timeframe });
      }
    }

    return completed;
  }

  flush(): AggregatedCandle[] {
    const remaining = [...this.current.values()];
    this.current.clear();
    return remaining;
  }
}
