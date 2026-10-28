import type {
  IChartApi,
  IPanePrimitive,
  IPanePrimitivePaneView,
  IPrimitivePaneRenderer,
  PaneAttachedParameter,
  UTCTimestamp,
} from 'lightweight-charts';
import { drawScene, type SceneItem } from 'lightweight-charts-drawing';
import { candleStart } from '../domain/aggregation';
import type { Candle } from '../domain/market';

interface CandleDay {
  day: string | number;
  midnight: boolean;
}

function dayFormatter(timeZone: string): Intl.DateTimeFormat | undefined {
  return timeZone === 'UTC'
    ? undefined
    : new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      });
}

function candleDay(time: number, formatter?: Intl.DateTimeFormat): CandleDay {
  if (!formatter) {
    const day = candleStart(time, '1D');
    return { day, midnight: time === day };
  }
  const parts = formatter.formatToParts(time * 1000);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  return {
    day: `${value('year')}-${value('month')}-${value('day')}`,
    midnight:
      time % 1 === 0 &&
      value('hour') === '00' &&
      value('minute') === '00' &&
      value('second') === '00',
  };
}

function collectDayBoundaries(
  candles: readonly Pick<Candle, 'time'>[],
  classify: (time: number) => CandleDay,
): UTCTimestamp[] {
  const times: UTCTimestamp[] = [];
  let previousDay: string | number | undefined;
  for (const { time } of candles) {
    const { day, midnight } = classify(time);
    if (previousDay === undefined ? midnight : day !== previousDay)
      times.push(time as UTCTimestamp);
    previousDay = day;
  }
  return times;
}

export function dayBoundaryTimes(
  candles: readonly Pick<Candle, 'time'>[],
  timeZone = 'UTC',
): UTCTimestamp[] {
  const formatter = dayFormatter(timeZone);
  return collectDayBoundaries(candles, (time) => candleDay(time, formatter));
}

/** Background grid accents, independent of editable and persisted drawings. */
export class DaySeparators implements IPanePrimitive {
  private times: UTCTimestamp[] = [];
  private candleTimes: number[] = [];
  private candleDays = new Map<number, CandleDay>();
  private formatter?: Intl.DateTimeFormat;
  private timeZone = 'UTC';
  private requestUpdate?: () => void;
  private readonly views: IPanePrimitivePaneView[];

  constructor(chart: IChartApi) {
    const renderer: IPrimitivePaneRenderer = {
      draw() {},
      drawBackground: (target) => {
        target.useMediaCoordinateSpace(({ context, mediaSize }) => {
          const lines: SceneItem[] = [];
          for (const time of this.times) {
            const x = chart.timeScale().timeToCoordinate(time);
            if (x === null || x < -1 || x > mediaSize.width + 1) continue;
            lines.push({
              t: 'line',
              a: { x, y: 0 },
              b: { x, y: mediaSize.height },
              stroke: '#a3a3a3',
              strokeWidth: 2,
            });
          }
          drawScene(context, lines, {
            fontFamily: chart.options().layout.fontFamily,
            anchors: { fillAt: () => '#ffffff', selected: false },
          });
        });
      },
    };
    // Normal-layer backgrounds are drawn after the grid and before candles.
    this.views = [{ zOrder: () => 'normal', renderer: () => renderer }];
  }

  attached({ requestUpdate }: PaneAttachedParameter): void {
    this.requestUpdate = requestUpdate;
  }

  detached(): void {
    this.requestUpdate = undefined;
  }

  setCandles(candles: readonly Pick<Candle, 'time'>[], timeZone = 'UTC'): void {
    // Replay updates OHLC repeatedly while the candle timestamps stay unchanged.
    if (
      this.timeZone === timeZone &&
      candles.length === this.candleTimes.length &&
      candles.every(({ time }, index) => time === this.candleTimes[index])
    )
      return;
    const sameZone = this.timeZone === timeZone;
    const formatter = sameZone ? this.formatter : dayFormatter(timeZone);
    const previousDays = sameZone ? this.candleDays : undefined;
    const nextDays = new Map<number, CandleDay>();
    const candleTimes: number[] = [];
    const times = collectDayBoundaries(candles, (time) => {
      const day = previousDays?.get(time) ?? candleDay(time, formatter);
      nextDays.set(time, day);
      candleTimes.push(time);
      return day;
    });
    // Retain only the chart's current window; evicted session history is not cached.
    this.candleTimes = candleTimes;
    this.candleDays = nextDays;
    this.formatter = formatter;
    this.timeZone = timeZone;
    this.times = times;
    this.requestUpdate?.();
  }

  paneViews(): readonly IPanePrimitivePaneView[] {
    return this.views;
  }
}
