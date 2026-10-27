import { useMemo, useState } from 'react';
import { saveChartTimeZone } from '../infrastructure/chart-preferences';
import { NativeSelect, NativeSelectOption } from './ui/native-select';

interface Props {
  value: string;
  onChange: (timeZone: string) => void;
}

export function ChartTimeZoneSelect({ value, onChange }: Props) {
  const [error, setError] = useState<string>();
  const timeZones = useMemo(() => {
    const zones = new Set([
      ...Intl.supportedValuesOf('timeZone'),
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      value,
    ]);
    zones.delete('UTC');
    return ['UTC', ...Array.from(zones).sort()];
  }, [value]);

  function changeTimeZone(timeZone: string) {
    onChange(timeZone);
    try {
      saveChartTimeZone(timeZone);
      setError(undefined);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Не удалось сохранить часовой пояс графика в браузере.',
      );
    }
  }

  return (
    <div className="chart-time-zone">
      <NativeSelect
        aria-label="Часовой пояс"
        title="Часовой пояс графика"
        size="sm"
        value={value}
        onChange={(event) => changeTimeZone(event.target.value)}
      >
        {timeZones.map((timeZone) => (
          <NativeSelectOption key={timeZone} value={timeZone}>
            {timeZone === 'UTC'
              ? 'UTC (UTC+00:00)'
              : timeZone.replaceAll('_', ' ')}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {error && (
        <span className="chart-time-zone-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
