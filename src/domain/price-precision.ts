/** Price resolution supported by the chart, excluding insignificant zeros. */
export function pricePrecision(price: number): number {
  return price.toFixed(8).replace(/0+$/, '').split('.')[1]?.length ?? 0;
}

export function defaultPointSize(precision: number): number {
  return 10 ** -Math.max(0, Math.min(8, precision));
}
