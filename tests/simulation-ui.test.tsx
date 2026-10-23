import { describe, expect, test } from 'bun:test';
import { TZDate } from 'react-day-picker';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DateTimePicker,
  dateTimeTimestamp,
  dateTimeValue,
} from '../src/components/DateTimePicker';
import { Calendar } from '../src/components/ui/calendar';

const timestamp = (value: string) => Date.parse(value) / 1000;

describe('simulation UTC date and time inputs', () => {
  test('keeps UTC date and seconds when converting the session boundaries', () => {
    for (const iso of [
      '2026-01-01T00:00:00Z',
      '2026-10-23T23:59:59Z',
      '2028-02-29T12:34:56Z',
    ]) {
      const value = dateTimeValue(timestamp(iso));
      expect(value.time).toBe(iso.slice(11, 19));
      expect(dateTimeTimestamp(value)).toBe(timestamp(iso));
    }
  });

  test('combines the chosen UTC day with time rather than the machine timezone', () => {
    const date = new TZDate('2026-10-23T00:00:00Z', 'UTC');
    expect(dateTimeTimestamp({ date, time: '01:02:03' })).toBe(
      timestamp('2026-10-23T01:02:03Z'),
    );
    expect(dateTimeTimestamp({ date, time: '01:02' })).toBe(
      timestamp('2026-10-23T01:02:00Z'),
    );
  });

  test('retains the one-second difference across the UTC midnight boundary', () => {
    const start = dateTimeValue(timestamp('2026-10-23T23:59:59Z'));
    const end = dateTimeValue(timestamp('2026-10-24T00:00:00Z'));
    expect(dateTimeTimestamp(end) - dateTimeTimestamp(start)).toBe(1);
    expect(start.date?.getUTCDate()).toBe(23);
    expect(end.date?.getUTCDate()).toBe(24);
  });

  test('rejects missing dates and incomplete or out-of-range time input', () => {
    const date = new TZDate('2026-10-23T00:00:00Z', 'UTC');
    for (const time of [
      '',
      '1',
      '12:',
      '24:00:00',
      '12:60',
      '12:00:60',
      'abc',
    ]) {
      expect(Number.isNaN(dateTimeTimestamp({ date, time }))).toBe(true);
    }
    expect(
      Number.isNaN(dateTimeTimestamp({ date: undefined, time: '12:00:00' })),
    ).toBe(true);
  });

  test('renders the official shadcn calendar with the installed DayPicker adapter', () => {
    const date = new TZDate('2026-10-23T00:00:00Z', 'UTC');
    const html = renderToStaticMarkup(
      <Calendar
        mode="single"
        timeZone="UTC"
        defaultMonth={date}
        selected={date}
      />,
    );
    expect(html).toContain('<table');
    expect(html).toContain('data-selected-single="true"');
    expect(html).toContain('October 2026');
  });

  test('renders the selected UTC date, accessible time field and disabled end state', () => {
    const time = timestamp('2026-10-23T23:59:59Z');
    const value = dateTimeValue(time);
    const props = {
      id: 'simulation-start',
      label: 'Начало симуляции',
      value,
      onChange: () => {},
      minTime: time - 86400,
      maxTime: time + 86400,
    };
    const html = renderToStaticMarkup(<DateTimePicker {...props} />);
    expect(html).toContain('23.10.2026');
    expect(html).toContain('value="23:59:59"');
    expect(html).toContain('step="1"');
    expect(html).toContain('aria-label="Начало симуляции: время UTC"');
    expect(html).not.toContain('disabled=""');

    const disabled = renderToStaticMarkup(
      <DateTimePicker {...props} disabled />,
    );
    expect(disabled.match(/disabled=""/g)?.length).toBe(2);
  });
});
