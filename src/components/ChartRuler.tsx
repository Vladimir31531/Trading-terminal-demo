import {
  formatPriceDistance,
  priceDistance,
  type RulerMeasurement,
} from '../chart/ruler';

export function ChartRuler({ measurement }: { measurement: RulerMeasurement }) {
  const { start, end, width, height, minMove } = measurement;
  const label = formatPriceDistance(
    priceDistance(start.price, end.price, minMove),
  );
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const bottom = Math.max(start.y, end.y);
  const labelWidth = Math.min(width - 16, label.length * 7.2 + 16);
  const labelHeight = 24;
  const labelX = Math.max(
    8,
    Math.min(width - labelWidth - 8, (start.x + end.x - labelWidth) / 2),
  );
  const labelY = Math.max(
    4,
    Math.min(
      height - labelHeight - 4,
      top >= labelHeight + 12 ? top - labelHeight - 8 : bottom + 8,
    ),
  );

  return (
    <svg
      className="chart-ruler"
      role="img"
      aria-label={`Линейка: ${label}`}
      width={width}
      height={height}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
        zIndex: 3,
      }}
    >
      <title>{`Линейка: ${label}`}</title>
      <rect
        x={left}
        y={top}
        width={Math.abs(end.x - start.x)}
        height={Math.abs(end.y - start.y)}
        fill="#171717"
        fillOpacity={0.06}
        stroke="#737373"
        strokeWidth={1}
        strokeDasharray="4 3"
      />
      <line
        x1={start.x}
        y1={start.y}
        x2={end.x}
        y2={end.y}
        stroke="#171717"
        strokeWidth={1}
      />
      {[start, end].map((point, index) => (
        <circle
          key={index === 0 ? 'start' : 'end'}
          cx={point.x}
          cy={point.y}
          r={3}
          fill="#ffffff"
          stroke="#171717"
          strokeWidth={1.5}
        />
      ))}
      <rect
        x={labelX}
        y={labelY}
        width={labelWidth}
        height={labelHeight}
        rx={4}
        fill="#171717"
      />
      <text
        x={labelX + labelWidth / 2}
        y={labelY + labelHeight / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fill="#ffffff"
        fontSize={12}
        fontFamily="ui-monospace, SFMono-Regular, Consolas, monospace"
        textLength={labelWidth - 16}
        lengthAdjust="spacingAndGlyphs"
      >
        {label}
      </text>
    </svg>
  );
}
