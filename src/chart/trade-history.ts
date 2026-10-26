import type {
  IChartApi,
  IPanePrimitive,
  PaneAttachedParameter,
  UTCTimestamp,
} from 'lightweight-charts';
import { candleStart } from '../domain/aggregation';
import type { Timeframe } from '../domain/market';
import type { TradeMarker } from '../domain/trading';

export interface PositionedTradeMarker extends TradeMarker {
  x: number;
  y: number;
}

export interface TradeHistoryLayout {
  width: number;
  height: number;
  markers: PositionedTradeMarker[];
}

/** Keeps the SVG overlay aligned with the chart, including price-scale gestures. */
export class TradeHistory implements IPanePrimitive {
  private markers: readonly TradeMarker[] = [];
  private requestUpdate?: () => void;
  private layout: TradeHistoryLayout = { width: 0, height: 0, markers: [] };

  constructor(
    private readonly chart: IChartApi,
    private readonly timeframe: Timeframe,
    private readonly priceToCoordinate: (price: number) => number | null,
    private readonly onLayout: (layout: TradeHistoryLayout) => void,
  ) {}

  attached({ requestUpdate }: PaneAttachedParameter): void {
    this.requestUpdate = requestUpdate;
  }

  detached(): void {
    this.requestUpdate = undefined;
  }

  setMarkers(markers: readonly TradeMarker[]): void {
    this.markers = markers;
    this.requestUpdate?.();
  }

  updateAllViews(): void {
    if (!this.requestUpdate) return;
    const scale = this.chart.timeScale();
    const markers: PositionedTradeMarker[] = [];
    for (const marker of this.markers) {
      const x = scale.timeToCoordinate(
        candleStart(marker.time, this.timeframe) as UTCTimestamp,
      );
      const y = this.priceToCoordinate(marker.price);
      if (x === null || y === null || !Number.isFinite(x + y)) continue;
      markers.push({ ...marker, x, y });
    }
    for (const { open, close } of pairTradeMarkers(markers)) {
      if (open.x === close.x && open.y === close.y) {
        open.x -= 8;
        close.x += 8;
      }
    }
    const width = scale.width();
    const height = this.chart.panes()[0]?.getHeight() ?? 0;
    const previous = this.layout;
    if (
      width === previous.width &&
      height === previous.height &&
      markers.length === previous.markers.length &&
      markers.every((marker, index) => {
        const old = previous.markers[index];
        return (
          marker.id === old.id &&
          marker.x === old.x &&
          marker.y === old.y &&
          marker.side === old.side &&
          marker.phase === old.phase &&
          marker.orderId === old.orderId
        );
      })
    )
      return;
    this.layout = { width, height, markers };
    this.onLayout(this.layout);
  }
}

export function pairTradeMarkers<T extends TradeMarker>(
  markers: readonly T[],
): Array<{ open: T; close: T }> {
  const trades = new Map<string, { open?: T; close?: T }>();
  for (const marker of markers) {
    const pair = trades.get(marker.orderId) ?? {};
    pair[marker.phase] = marker;
    trades.set(marker.orderId, pair);
  }
  return [...trades.values()].flatMap((pair) =>
    pair.open && pair.close ? [{ open: pair.open, close: pair.close }] : [],
  );
}
