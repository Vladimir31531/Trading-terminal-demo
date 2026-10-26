const pointValueKeyPrefix = 'terminal-demo:point-value-per-001:';

export function loadPointValue(
  instrumentId: string,
  storage?: Pick<Storage, 'getItem'>,
): string {
  try {
    const saved = (storage ?? localStorage).getItem(
      pointValueKeyPrefix + instrumentId,
    );
    const value = Number(saved);
    return Number.isFinite(value) && value > 0 ? String(value) : '1';
  } catch (cause) {
    console.warn('Не удалось загрузить сохранённую цену пункта.', cause);
    return '1';
  }
}

export function savePointValue(
  instrumentId: string,
  draft: string,
  storage?: Pick<Storage, 'setItem'>,
): void {
  const value = Number(draft);
  if (!Number.isFinite(value) || value <= 0) return;
  try {
    (storage ?? localStorage).setItem(
      pointValueKeyPrefix + instrumentId,
      String(value),
    );
  } catch {
    throw new Error('Не удалось сохранить цену пункта в браузере.');
  }
}
