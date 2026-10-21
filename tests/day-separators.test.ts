import { describe, expect, test } from 'bun:test';
import type { UTCTimestamp } from 'lightweight-charts';
import { dayBoundaryTimes } from '../src/chart/day-separators';

const utc = (value: string): UTCTimestamp =>
  (Date.parse(value) / 1000) as UTCTimestamp;
const bars = (...dates: string[]) => dates.map((date) => ({ time: utc(date) }));

describe('UTC day boundaries', () => {
  test('empty history and a partial day have no invented left boundary', () => {
    expect(dayBoundaryTimes([])).toEqual([]);
    expect(
      dayBoundaryTimes(bars('2026-10-20T12:00:00Z', '2026-10-20T23:59:00Z')),
    ).toEqual([]);
  });

  test('includes exact midnight at the start and once for each following day', () => {
    expect(
      dayBoundaryTimes(
        bars(
          '2026-10-20T00:00:00Z',
          '2026-10-20T00:01:00Z',
          '2026-10-21T00:00:00Z',
          '2026-10-21T00:01:00Z',
        ),
      ),
    ).toEqual([utc('2026-10-20T00:00:00Z'), utc('2026-10-21T00:00:00Z')]);
  });

  test('recognizes month and year transitions', () => {
    expect(
      dayBoundaryTimes(bars('2026-11-30T23:59:00Z', '2026-12-01T00:00:00Z')),
    ).toEqual([utc('2026-12-01T00:00:00Z')]);
    expect(
      dayBoundaryTimes(bars('2026-12-31T23:59:00Z', '2027-01-01T00:00:00Z')),
    ).toEqual([utc('2027-01-01T00:00:00Z')]);
  });

  test('uses UTC midnight rather than a source date offset', () => {
    expect(
      dayBoundaryTimes(
        bars(
          '2026-10-21T00:00:00+03:00',
          '2026-10-21T02:59:00+03:00',
          '2026-10-21T03:00:00+03:00',
          '2026-10-21T04:00:00+03:00',
        ),
      ),
    ).toEqual([utc('2026-10-21T00:00:00Z')]);
  });

  test('places one boundary at the first available bar after a weekend or missing midnight', () => {
    expect(
      dayBoundaryTimes(
        bars(
          '2026-10-16T21:00:00Z',
          '2026-10-19T01:05:00Z',
          '2026-10-19T01:06:00Z',
          '2026-10-20T00:15:00Z',
        ),
      ),
    ).toEqual([utc('2026-10-19T01:05:00Z'), utc('2026-10-20T00:15:00Z')]);
  });

  test('prepending or trimming a page preserves actual transitions without marking a midday cache edge', () => {
    const history = bars(
      '2026-10-19T23:59:00Z',
      '2026-10-20T00:00:00Z',
      '2026-10-20T12:00:00Z',
      '2026-10-20T23:59:00Z',
      '2026-10-21T00:00:00Z',
      '2026-10-21T12:00:00Z',
    );
    const before = structuredClone(history);
    expect(dayBoundaryTimes(history.slice(2))).toEqual([
      utc('2026-10-21T00:00:00Z'),
    ]);
    expect(dayBoundaryTimes(history)).toEqual([
      utc('2026-10-20T00:00:00Z'),
      utc('2026-10-21T00:00:00Z'),
    ]);
    expect(dayBoundaryTimes(history.slice(1))).toEqual(
      dayBoundaryTimes(history),
    );
    expect(history).toEqual(before);
  });
});
