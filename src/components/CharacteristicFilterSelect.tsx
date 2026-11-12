import type { TradeCharacteristic } from '../domain/trade-characteristics';
import { NativeSelect, NativeSelectOption } from './ui/native-select';

interface Props {
  characteristic: TradeCharacteristic;
  value: string | null | undefined;
  onChange: (value: string | null | undefined) => void;
  knownValues?: readonly string[];
  idPrefix?: string;
}

export function CharacteristicFilterSelect({
  characteristic,
  value,
  onChange,
  knownValues = [],
  idPrefix = 'characteristic-filter',
}: Props) {
  const values = [...new Set([...characteristic.values, ...knownValues])];
  return (
    <NativeSelect
      id={`${idPrefix}-${characteristic.id}`}
      size="sm"
      className="max-w-56 min-w-32 bg-white text-xs font-normal"
      aria-label={`Фильтр: ${characteristic.name}`}
      value={
        value === undefined ? '' : value === null ? 'missing' : `value:${value}`
      }
      onChange={(event) => {
        const selected = event.target.value;
        onChange(
          selected === ''
            ? undefined
            : selected === 'missing'
              ? null
              : selected.slice(6),
        );
      }}
    >
      <NativeSelectOption value="">Все значения</NativeSelectOption>
      <NativeSelectOption value="missing">- (без значения)</NativeSelectOption>
      {values.map((option) => (
        <NativeSelectOption key={option} value={`value:${option}`}>
          {option}
          {characteristic.values.includes(option) ? '' : ' (из истории)'}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}
