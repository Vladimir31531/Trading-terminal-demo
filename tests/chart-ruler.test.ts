import { describe, expect, test } from 'bun:test';
import { formatPriceDistance, priceDistance } from '../src/chart/ruler';

describe('chart ruler distance', () => {
  test('measures the supplied prices in minimum price units', () => {
    const result = priceDistance(4120.684, 4121.618, 0.001);
    expect(result.points).toBe(934);
    expect(result.percent).toBeCloseTo((0.934 / 4120.684) * 100, 12);
    expect(formatPriceDistance(result)).toBe('934 п. / 0,0227%');
  });

  test.each([
    [100, 105, 1, 5],
    [1.13, 1.15, 0.01, 2],
    [4120.684, 4121.618, 0.001, 934],
    [1.12345, 1.12439, 0.00001, 94],
  ])('counts ticks from %s to %s at step %s', (start, end, step, points) => {
    expect(priceDistance(start, end, step).points).toBe(points);
    expect(priceDistance(end, start, step).points).toBe(points);
  });

  test('rounds each cursor price before comparing their ticks', () => {
    expect(priceDistance(1.004, 1.006, 0.01).points).toBe(1);
    expect(priceDistance(1.001, 1.004, 0.01).points).toBe(0);
    expect(priceDistance(1, 1.005, 0.01).points).toBe(1);
    expect(priceDistance(1, 1.015, 0.01).points).toBe(2);
    expect(priceDistance(-1.015, -1, 0.01).points).toBe(1);
  });

  test('uses the absolute starting price for negative prices', () => {
    const negative = priceDistance(-100, -90, 0.01);
    expect(negative).toEqual({ points: 1000, percent: 10 });
    expect(priceDistance(-5, 5, 0.001)).toEqual({
      points: 10000,
      percent: 200,
    });
  });

  test('reversing direction keeps points while percent follows its origin', () => {
    expect(priceDistance(100, 110, 0.01)).toEqual({
      points: 1000,
      percent: 10,
    });
    expect(priceDistance(110, 100, 0.01).percent).toBeCloseTo(9.09090909, 8);
  });

  test('zero starting price has no defined percentage', () => {
    expect(priceDistance(0, 1, 0.001)).toEqual({
      points: 1000,
      percent: undefined,
    });
    expect(priceDistance(0.004, 0.01, 0.01).percent).toBeUndefined();
    expect(formatPriceDistance(priceDistance(0, 0, 0.01))).toBe('0 п. / —');
  });

  test('unchanged and zero ending prices remain meaningful', () => {
    expect(priceDistance(10, 10, 0.00001)).toEqual({
      points: 0,
      percent: 0,
    });
    expect(priceDistance(1, 0, 0.00001)).toEqual({
      points: 100000,
      percent: 100,
    });
    expect(formatPriceDistance(priceDistance(10, 10, 1))).toBe('0 п. / 0%');
  });

  test('handles large prices and very small quoted prices without decimal noise', () => {
    expect(priceDistance(999999.99999, 1000000, 0.00001).points).toBe(1);
    expect(priceDistance(0.00001, 0.00003, 0.00001)).toEqual({
      points: 2,
      percent: 200,
    });
  });
});
