import { describe, expect, test } from 'bun:test';
import { TickMarkType, type UTCTimestamp } from 'lightweight-charts';
import { createChartTimeFormatters } from '../src/chart/time-format';

const utc = (time: string) => (Date.parse(time) / 1000) as UTCTimestamp;

describe('chart candle time display', () => {
  test('formats UTC midnight with a 24-hour clock', () => {
    const format = createChartTimeFormatters('UTC');
    const time = utc('2026-01-01T00:00:00Z');
    expect(format.tickMarkFormatter(time, TickMarkType.Time, 'ru-RU')).toBe(
      '00:00',
    );
    expect(format.timeFormatter(time)).toContain('01.01.2026');
    expect(format.timeFormatter(time)).toContain('00:00 UTC');
  });

  test('shifts the displayed day and year for New York without shifting the candle', () => {
    const time = utc('2026-01-01T01:15:00Z');
    const format = createChartTimeFormatters('America/New_York');
    expect(format.timeFormatter(time)).toContain('31.12.2025');
    expect(format.timeFormatter(time)).toContain('20:15 UTC-5');
    expect(format.tickMarkFormatter(time, TickMarkType.Year, 'ru-RU')).toBe(
      '2025',
    );
  });

  test('supports fractional offsets across midnight', () => {
    const time = utc('2026-10-20T18:45:09Z');
    const india = createChartTimeFormatters('Asia/Kolkata');
    expect(india.timeFormatter(time)).toContain('21.10.2026');
    expect(india.timeFormatter(time)).toContain('00:15 UTC+5:30');
    expect(
      india.tickMarkFormatter(time, TickMarkType.TimeWithSeconds, 'ru-RU'),
    ).toBe('00:15:09');
    const nepal = createChartTimeFormatters('Asia/Kathmandu');
    expect(nepal.timeFormatter(time)).toContain('00:30 UTC+5:45');
  });

  test('uses the offset of each candle when the local clock repeats at DST end', () => {
    const format = createChartTimeFormatters('America/New_York');
    const before = format.timeFormatter(utc('2026-11-01T05:30:00Z'));
    const after = format.timeFormatter(utc('2026-11-01T06:30:00Z'));
    expect(before).toContain('01:30 UTC-4');
    expect(after).toContain('01:30 UTC-5');
  });

  test('keeps time-axis labels compact for every mark type and month', () => {
    const format = createChartTimeFormatters('Europe/Chisinau');
    for (let month = 0; month < 12; month++) {
      const time = (Date.UTC(2026, month, 15, 13, 15, 20) /
        1000) as UTCTimestamp;
      for (const type of [
        TickMarkType.Year,
        TickMarkType.Month,
        TickMarkType.DayOfMonth,
        TickMarkType.Time,
        TickMarkType.TimeWithSeconds,
      ]) {
        const label = format.tickMarkFormatter(time, type, 'ru-RU');
        expect(label).not.toBeNull();
        expect(label?.length).toBeLessThanOrEqual(8);
      }
    }
  });

  test('handles both calendar time representations accepted by Lightweight Charts', () => {
    const format = createChartTimeFormatters('UTC');
    expect(format.timeFormatter('2026-01-01')).toBe(
      format.timeFormatter({ year: 2026, month: 1, day: 1 }),
    );
  });
});
