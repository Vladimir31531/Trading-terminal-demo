import type { Candle } from './market';

const COLUMNS = ['Time', 'Open', 'High', 'Low', 'Close', 'Volume'] as const;
const UTC_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|\+00:00)$/;
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

export function validateCsvFile(file: Pick<File, 'name' | 'size'>): void {
  if (!/\.csv$/i.test(file.name))
    throw new Error('Выберите файл в формате CSV.');
  if (file.size === 0) throw new Error('CSV-файл пуст.');
}

export function validateCsvHeader(row: readonly string[]): void {
  if (
    row.length !== COLUMNS.length ||
    row.some((value, index) => value !== COLUMNS[index])
  ) {
    throw new Error(
      'Заголовок CSV должен быть строго: Time,Open,High,Low,Close,Volume.',
    );
  }
}

function parseUtcTime(value: string, rowNumber: number): number {
  const match = UTC_TIMESTAMP.exec(value);
  const milliseconds = Date.parse(value.replace(' ', 'T'));
  const date = new Date(milliseconds);

  if (
    !match ||
    !Number.isFinite(milliseconds) ||
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() + 1 !== Number(match[2]) ||
    date.getUTCDate() !== Number(match[3]) ||
    date.getUTCHours() !== Number(match[4]) ||
    date.getUTCMinutes() !== Number(match[5]) ||
    date.getUTCSeconds() !== Number(match[6])
  ) {
    throw new Error(
      `Строка ${rowNumber}: Time должен содержать корректные дату и время UTC.`,
    );
  }

  return milliseconds / 1000;
}

function parsePrice(value: string, column: string, rowNumber: number): number {
  const price = Number(value);
  if (!DECIMAL.test(value) || !Number.isFinite(price)) {
    throw new Error(
      `Строка ${rowNumber}: ${column} должен содержать конечное число.`,
    );
  }
  return price;
}

export function parseCsvCandle(
  row: readonly string[],
  rowNumber: number,
  previousTime?: number,
): Candle {
  if (row.length !== COLUMNS.length) {
    throw new Error(`Строка ${rowNumber}: ожидается ровно 6 столбцов.`);
  }

  const time = parseUtcTime(row[0], rowNumber);
  if (previousTime !== undefined && time <= previousTime) {
    throw new Error(
      `Строка ${rowNumber}: время должно возрастать без повторяющихся меток.`,
    );
  }

  const open = parsePrice(row[1], 'Open', rowNumber);
  const high = parsePrice(row[2], 'High', rowNumber);
  const low = parsePrice(row[3], 'Low', rowNumber);
  const close = parsePrice(row[4], 'Close', rowNumber);

  if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
    throw new Error(
      `Строка ${rowNumber}: High и Low не соответствуют диапазону OHLC.`,
    );
  }

  return { time, open, high, low, close };
}

export function normalizeTicker(ticker: string): string {
  const normalized = ticker.trim().toUpperCase();
  if (!normalized) throw new Error('Укажите тикер инструмента.');
  return normalized;
}
