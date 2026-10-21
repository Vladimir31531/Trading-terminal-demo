import { describe, expect, test } from 'bun:test';
import { pricePrecision } from '../src/domain/price-precision';

describe('source price precision', () => {
  test.each([
    [4120.684, 3],
    [12, 0],
    [12.5, 1],
    [-0.001, 3],
    [1e-7, 7],
    [1.123456789, 8],
    [0.1 + 0.2, 1],
  ])('counts significant decimal places in %s', (price, expected) => {
    expect(pricePrecision(price)).toBe(expected);
  });
});
