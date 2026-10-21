import type {
  IChartApi,
  IPanePrimitive,
  IPanePrimitivePaneView,
  IPrimitivePaneRenderer,
  UTCTimestamp,
} from 'lightweight-charts';
import { drawScene, type SceneItem } from 'lightweight-charts-drawing';
import { candleStart } from '../domain/aggregation';
import type { Candle } from '../domain/market';

export function dayBoundaryTimes(
  candles: readonly Pick<Candle, 'time'>[],
): UTCTimestamp[] {
  const times: UTCTimestamp[] = [];
  let previousDay: number | undefined;
  for (const { time } of candles) {
    const day = candleStart(time, '1D');
    if (previousDay === undefined ? time === day : day !== previousDay)
      times.push(time as UTCTimestamp);
    previousDay = day;
  }
  return times;
}

/** Background grid accents, independent of editable and persisted drawings. */
export class DaySeparators implements IPanePrimitive {
  private times: UTCTimestamp[] = [];
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

  setCandles(candles: readonly Pick<Candle, 'time'>[]): void {
    this.times = dayBoundaryTimes(candles);
  }

  paneViews(): readonly IPanePrimitivePaneView[] {
    return this.views;
  }
}
