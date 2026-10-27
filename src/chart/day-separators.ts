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

export function dayBoundaryTimes(
  candles: readonly Pick<Candle, 'time'>[],
  timeZone = 'UTC',
): UTCTimestamp[] {
  const times: UTCTimestamp[] = [];
  const formatter =
    timeZone === 'UTC'
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
  let previousDay: string | number | undefined;
  for (const { time } of candles) {
    let day: string | number;
    let midnight: boolean;
    if (formatter) {
      const parts = formatter.formatToParts(time * 1000);
      const value = (type: Intl.DateTimeFormatPartTypes) =>
        parts.find((part) => part.type === type)?.value;
      day = `${value('year')}-${value('month')}-${value('day')}`;
      midnight =
        time % 1 === 0 &&
        value('hour') === '00' &&
        value('minute') === '00' &&
        value('second') === '00';
    } else {
      day = candleStart(time, '1D');
      midnight = time === day;
    }
    if (previousDay === undefined ? midnight : day !== previousDay)
      times.push(time as UTCTimestamp);
    previousDay = day;
  }
  return times;
}

/** Background grid accents, independent of editable and persisted drawings. */
export class DaySeparators implements IPanePrimitive {
  private times: UTCTimestamp[] = [];
  private candleTimes: number[] = [];
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
    const times = dayBoundaryTimes(candles, timeZone);
    this.candleTimes = candles.map(({ time }) => time);
    this.timeZone = timeZone;
    this.times = times;
    this.requestUpdate?.();
  }

  paneViews(): readonly IPanePrimitivePaneView[] {
    return this.views;
  }
}
