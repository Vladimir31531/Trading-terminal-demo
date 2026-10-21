export interface RulerPoint {
  x: number;
  y: number;
  price: number;
}

export interface RulerMeasurement {
  start: RulerPoint;
  end: RulerPoint;
  width: number;
  height: number;
  minMove: number;
}

export interface PriceDistance {
  points: number;
  percent: number | undefined;
}

const pointFormat = new Intl.NumberFormat('ru-RU', {
  maximumFractionDigits: 0,
});
const percentFormat = new Intl.NumberFormat('ru-RU', {
  maximumFractionDigits: 4,
});

export function priceDistance(
  start: number,
  end: number,
  minMove: number,
): PriceDistance {
  const ticks = (price: number) => {
    const value = price / minMove;
    // Decimal prices can land just below an exact half-tick in binary floats.
    return Math.round(value + Number.EPSILON * Math.abs(value));
  };
  const startTicks = ticks(start);
  const points = Math.abs(ticks(end) - startTicks);
  return {
    points,
    percent:
      startTicks === 0 ? undefined : (points / Math.abs(startTicks)) * 100,
  };
}

export function formatPriceDistance({
  points,
  percent,
}: PriceDistance): string {
  return `${pointFormat.format(points)} п. / ${
    percent === undefined ? '—' : `${percentFormat.format(percent)}%`
  }`;
}
