import { TiArrowDownThick, TiArrowUpThick } from 'react-icons/ti';
import {
  pairTradeMarkers,
  type TradeHistoryLayout,
} from '../chart/trade-history';

const arrowSize = 18;
// Coordinates of the actual tips in the Typicons 24 × 24 viewBox.
const arrowTipY = { up: 3.172, down: 19.898 } as const;
const iconViewBoxSize = 24;
const colors = { up: '#16803c', down: '#bd2929' } as const;

export function TradeHistoryOverlay({
  layout,
}: {
  layout: TradeHistoryLayout;
}) {
  if (!layout.markers.length) return null;
  return (
    <svg
      className="trade-history-overlay"
      width={layout.width}
      height={layout.height}
      role="img"
      aria-label="История сделок на графике"
    >
      <title>Стрелки входа и выхода, соединённые пунктирной линией</title>
      {pairTradeMarkers(layout.markers).map(({ open, close }) => (
        <line
          key={open.orderId}
          x1={open.x}
          y1={open.y}
          x2={close.x}
          y2={close.y}
          stroke="#737373"
          strokeWidth={1.5}
          strokeDasharray="4 3"
        />
      ))}
      {layout.markers.map((marker) => {
        const direction =
          (marker.side === 'buy') === (marker.phase === 'open') ? 'up' : 'down';
        const Arrow = direction === 'up' ? TiArrowUpThick : TiArrowDownThick;
        return (
          <Arrow
            key={marker.id}
            className="trade-history-arrow"
            data-direction={direction}
            data-phase={marker.phase}
            x={marker.x - arrowSize / 2}
            y={marker.y - (arrowTipY[direction] / iconViewBoxSize) * arrowSize}
            size={arrowSize}
            color={colors[direction]}
            aria-hidden="true"
          />
        );
      })}
    </svg>
  );
}
