const chartTimeZoneKey = 'terminal-demo:chart-time-zone';
const defaultChartTimeZone = 'Europe/Chisinau';

function isValidTimeZone(value: string | null): value is string {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function loadChartTimeZone(storage?: Pick<Storage, 'getItem'>): string {
  try {
    const saved = (storage ?? localStorage).getItem(chartTimeZoneKey);
    return isValidTimeZone(saved) ? saved : defaultChartTimeZone;
  } catch (cause) {
    console.warn(
      'Не удалось загрузить сохранённый часовой пояс графика.',
      cause,
    );
    return defaultChartTimeZone;
  }
}

export function saveChartTimeZone(
  timeZone: string,
  storage?: Pick<Storage, 'setItem'>,
): void {
  if (!isValidTimeZone(timeZone)) return;
  try {
    (storage ?? localStorage).setItem(chartTimeZoneKey, timeZone);
  } catch {
    throw new Error('Не удалось сохранить часовой пояс графика в браузере.');
  }
}
