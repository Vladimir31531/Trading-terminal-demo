import {
  type TickMarkFormatter,
  TickMarkType,
  type Time,
} from 'lightweight-charts';

function timestamp(time: Time): number {
  if (typeof time === 'number') return time * 1000;
  if (typeof time === 'string') return Date.parse(time);
  return Date.UTC(time.year, time.month - 1, time.day);
}

/** Format UTC candle instants without changing chart coordinates or aggregation. */
export function createChartTimeFormatters(timeZone: string) {
  const format = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('ru-RU', {
      timeZone,
      hourCycle: 'h23',
      ...options,
    });
  const full = format({
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'shortOffset',
  });
  const ticks: Record<TickMarkType, Intl.DateTimeFormat> = {
    [TickMarkType.Year]: format({ year: 'numeric' }),
    [TickMarkType.Month]: format({ month: 'short' }),
    [TickMarkType.DayOfMonth]: format({ day: '2-digit', month: 'short' }),
    [TickMarkType.Time]: format({ hour: '2-digit', minute: '2-digit' }),
    [TickMarkType.TimeWithSeconds]: format({
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }),
  };
  const tickMarkFormatter: TickMarkFormatter = (time, type) =>
    ticks[type].format(timestamp(time));
  return {
    timeFormatter: (time: Time) =>
      full.format(timestamp(time)).replace('GMT', 'UTC'),
    tickMarkFormatter,
  };
}
