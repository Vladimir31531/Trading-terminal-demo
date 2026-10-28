import { describe, expect, spyOn, test } from 'bun:test';
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  UTCTimestamp,
} from 'lightweight-charts';
import { DaySeparators, dayBoundaryTimes } from '../src/chart/day-separators';

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

describe('day boundaries in the selected time zone', () => {
  test('uses New York midnight with its historical winter and summer offsets', () => {
    const winter = bars(
      '2026-01-20T04:59:00Z',
      '2026-01-20T05:00:00Z',
      '2026-01-20T05:01:00Z',
    );
    const summer = bars(
      '2026-07-20T03:59:00Z',
      '2026-07-20T04:00:00Z',
      '2026-07-20T04:01:00Z',
    );
    expect(dayBoundaryTimes(winter, 'America/New_York')).toEqual([
      utc('2026-01-20T05:00:00Z'),
    ]);
    expect(dayBoundaryTimes(summer, 'America/New_York')).toEqual([
      utc('2026-07-20T04:00:00Z'),
    ]);
  });

  test('supports the fractional offset in India and retains source timestamps', () => {
    const history = bars(
      '2026-10-20T18:29:00Z',
      '2026-10-20T18:30:00Z',
      '2026-10-20T18:31:00Z',
    );
    const before = structuredClone(history);
    expect(dayBoundaryTimes(history, 'Asia/Kolkata')).toEqual([
      utc('2026-10-20T18:30:00Z'),
    ]);
    expect(history).toEqual(before);
    expect(dayBoundaryTimes(history, 'UTC')).toEqual([]);
  });

  test('marks the first candle only at exact local midnight', () => {
    expect(
      dayBoundaryTimes(bars('2026-10-20T18:30:00Z'), 'Asia/Kolkata'),
    ).toEqual([utc('2026-10-20T18:30:00Z')]);
    for (const date of [
      '2026-10-20T18:30:00.001Z',
      '2026-10-20T18:30:01Z',
      '2026-10-20T18:31:00Z',
    ])
      expect(dayBoundaryTimes(bars(date), 'Asia/Kolkata')).toEqual([]);
  });

  test('keeps one boundary per local day through the Chisinau DST rollback', () => {
    expect(
      dayBoundaryTimes(
        bars(
          '2026-10-24T20:59:00Z',
          '2026-10-24T21:00:00Z',
          '2026-10-25T00:59:00Z',
          '2026-10-25T01:00:00Z',
          '2026-10-25T21:00:00Z',
          '2026-10-25T21:59:00Z',
          '2026-10-25T22:00:00Z',
        ),
        'Europe/Chisinau',
      ),
    ).toEqual([utc('2026-10-24T21:00:00Z'), utc('2026-10-25T22:00:00Z')]);
  });

  test('marks the first available local date transition after a gap', () => {
    expect(
      dayBoundaryTimes(
        bars(
          '2026-10-20T18:29:00Z',
          '2026-10-20T18:45:00Z',
          '2026-10-20T19:00:00Z',
        ),
        'Asia/Kolkata',
      ),
    ).toEqual([utc('2026-10-20T18:45:00Z')]);
  });
});

describe('day separator updates', () => {
  test('formats only added timestamps and discards dates outside the current chart window', () => {
    const format = spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    try {
      const separators = new DaySeparators({} as IChartApi);
      const start = utc('2026-10-20T00:00:00Z');
      let history = Array.from({ length: 3200 }, (_, index) => ({
        time: start + index * 60,
      }));
      separators.setCandles(history, 'Europe/Chisinau');
      expect(format).toHaveBeenCalledTimes(3200);
      for (let index = 0; index < 40; index++) {
        history = [...history.slice(1), { time: start + (3200 + index) * 60 }];
        separators.setCandles(history, 'Europe/Chisinau');
      }
      expect(format).toHaveBeenCalledTimes(3240);
      separators.setCandles(
        history.map((bar) => ({ ...bar, close: 200 })),
        'Europe/Chisinau',
      );
      expect(format).toHaveBeenCalledTimes(3240);

      // A timestamp that left the chart must be formatted again when revisited.
      history = [{ time: start }, ...history.slice(0, -1)];
      separators.setCandles(history, 'Europe/Chisinau');
      expect(format).toHaveBeenCalledTimes(3241);
      history[0] = { time: start + 1 };
      separators.setCandles(history, 'Europe/Chisinau');
      expect(format).toHaveBeenCalledTimes(3242);
      separators.setCandles(history, 'America/New_York');
      expect(format).toHaveBeenCalledTimes(6442);
      separators.setCandles(history, 'UTC');
      expect(format).toHaveBeenCalledTimes(6442);
      separators.setCandles([], 'Europe/Chisinau');
      separators.setCandles(history, 'Europe/Chisinau');
      expect(format).toHaveBeenCalledTimes(9642);
    } finally {
      format.mockRestore();
    }
  });

  test('cached boundaries match a fresh calculation through gaps, trimming, DST and zone changes', () => {
    const positioned: UTCTimestamp[] = [];
    const chart = {
      timeScale: () => ({
        timeToCoordinate: (time: UTCTimestamp) => {
          positioned.push(time);
          return null;
        },
      }),
      options: () => ({ layout: { fontFamily: 'sans-serif' } }),
    } as unknown as IChartApi;
    const separators = new DaySeparators(chart);
    const renderer = separators.paneViews()[0].renderer();
    const target = {
      useMediaCoordinateSpace: (paint: (scope: unknown) => void) =>
        paint({ context: {}, mediaSize: { width: 100, height: 100 } }),
    } as Parameters<NonNullable<IPrimitivePaneRenderer['drawBackground']>>[0];
    const history = bars(
      '2026-10-24T20:59:00Z',
      '2026-10-24T21:00:00Z',
      '2026-10-25T00:59:00Z',
      '2026-10-25T01:00:00Z',
      '2026-10-25T21:00:00Z',
      '2026-10-25T22:00:00Z',
      '2026-10-26T23:00:00Z',
    );
    for (const zone of [
      'Europe/Chisinau',
      'Asia/Kolkata',
      'UTC',
      'Europe/Chisinau',
    ]) {
      for (const window of [
        history.slice(0, 3),
        history,
        history.slice(2),
        history.slice(5),
      ]) {
        separators.setCandles(window, zone);
        positioned.length = 0;
        renderer?.drawBackground?.(target);
        expect(positioned).toEqual(dayBoundaryTimes(window, zone));
      }
    }
  });

  test('refreshes on a zone change, skips unchanged timestamps and stops updates after detach', () => {
    const chart = {} as IChartApi;
    const separators = new DaySeparators(chart);
    let requested = 0;
    separators.attached({ chart, requestUpdate: () => requested++ });
    const history = bars('2026-10-20T18:29:00Z', '2026-10-20T18:30:00Z');
    separators.setCandles(history, 'UTC');
    expect(requested).toBe(1);
    separators.setCandles(history, 'Asia/Kolkata');
    expect(requested).toBe(2);
    separators.setCandles(
      history.map((candle) => ({ ...candle, close: 100 })),
      'Asia/Kolkata',
    );
    expect(requested).toBe(2);

    // The caller may reuse and update its existing candle array in place.
    history[1] = { time: utc('2026-10-20T18:31:00Z') };
    separators.setCandles(history, 'Asia/Kolkata');
    expect(requested).toBe(3);
    separators.setCandles(history.slice(1), 'Asia/Kolkata');
    expect(requested).toBe(4);
    separators.detached();
    separators.setCandles(history, 'UTC');
    expect(requested).toBe(4);
  });
});
