export interface TradeCharacteristic {
  id: string;
  name: string;
  values: string[];
  createdAt: number;
}

export function normalizeTradeCharacteristic(
  characteristic: TradeCharacteristic,
): TradeCharacteristic {
  const name = characteristic.name.trim();
  const values = characteristic.values.map((value) => value.trim());
  if (!name) throw new Error('Укажите название характеристики.');
  if (!values.length || values.some((value) => !value))
    throw new Error('Добавьте хотя бы одно непустое значение характеристики.');
  if (new Set(values).size !== values.length)
    throw new Error('Значения характеристики не должны повторяться.');
  return { ...characteristic, name, values };
}

export function validateTradeCharacteristicSelections(
  characteristics: readonly TradeCharacteristic[],
  selections: Readonly<Record<string, string>>,
): void {
  for (const characteristic of characteristics) {
    if (
      !Object.hasOwn(selections, characteristic.id) ||
      !characteristic.values.includes(selections[characteristic.id])
    )
      throw new Error(
        `Выберите значение характеристики «${characteristic.name}».`,
      );
  }
  if (
    Object.keys(selections).some(
      (id) =>
        !characteristics.some((characteristic) => characteristic.id === id),
    )
  )
    throw new Error(
      'Список характеристик изменился. Проверьте выбранные значения.',
    );
}
