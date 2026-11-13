import { ChevronDown, Minus } from 'lucide-react';
import { useState } from 'react';
import type { TradeCharacteristic } from '../domain/trade-characteristics';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

interface Props {
  characteristic: TradeCharacteristic;
  /** Undefined selects every value, including values added later; [] selects none. */
  value: readonly (string | null)[] | undefined;
  onChange: (value: readonly (string | null)[] | undefined) => void;
  knownValues?: readonly string[];
  idPrefix?: string;
}

export function CharacteristicMultiFilter({
  characteristic,
  value,
  onChange,
  knownValues = [],
  idPrefix = 'custom-characteristic',
}: Props) {
  const options: (string | null)[] = [
    null,
    ...new Set([...characteristic.values, ...knownValues]),
  ];
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<(string | null)[]>([]);
  const [search, setSearch] = useState('');
  const allSelected = options.every((option) => draft.includes(option));
  const partlySelected = !allSelected && draft.length > 0;
  const selectedCount =
    value === undefined
      ? options.length
      : options.filter((option) => value.includes(option)).length;
  const label =
    value === undefined || selectedCount === options.length
      ? 'Все значения'
      : !selectedCount
        ? 'Ничего не выбрано'
        : `Выбрано ${selectedCount} из ${options.length}`;

  function changeOpen(next: boolean) {
    if (next) {
      setDraft(
        value === undefined
          ? options
          : options.filter((option) => value.includes(option)),
      );
      setSearch('');
    }
    setOpen(next);
  }

  function optionLabel(option: string | null): string {
    return option === null
      ? '- (без значения)'
      : `${option}${characteristic.values.includes(option) ? '' : ' (из истории)'}`;
  }
  const visibleOptions = options.filter((option) =>
    optionLabel(option)
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase()),
  );

  function apply() {
    const selected = options.filter((option) => draft.includes(option));
    onChange(selected.length === options.length ? undefined : selected);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button
          id={`${idPrefix}-${characteristic.id}`}
          type="button"
          size="sm"
          variant="outline"
          aria-label={`Фильтр: ${characteristic.name}`}
          className="w-full min-w-32 justify-between bg-white font-normal"
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)] bg-white p-0"
        aria-label={`Значения характеристики ${characteristic.name}`}
      >
        <form
          className="grid min-w-0 grid-cols-1 gap-3 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
        >
          <h4 className="text-sm font-medium">{characteristic.name}</h4>
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Поиск значений…"
            aria-label={`Поиск значений: ${characteristic.name}`}
            className="h-8 bg-white text-xs"
          />
          <div className="flex items-center justify-between gap-3 border-b pb-3">
            <Label className="flex cursor-pointer items-center gap-2 font-normal">
              <span className="relative inline-flex">
                <Checkbox
                  checked={
                    allSelected
                      ? true
                      : partlySelected
                        ? 'indeterminate'
                        : false
                  }
                  onCheckedChange={(checked) =>
                    setDraft(checked === true ? options : [])
                  }
                  className="data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground [&[data-state=indeterminate]_svg]:hidden"
                />
                {partlySelected && (
                  <Minus
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 size-4 p-0.5 text-primary-foreground"
                  />
                )}
              </span>
              Выбрать все
            </Label>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={!draft.length}
              onClick={() => setDraft([])}
            >
              Снять все
            </Button>
          </div>
          <fieldset
            className="grid max-h-60 min-w-0 grid-cols-1 gap-3 overflow-y-auto py-1"
            aria-label={`Значения: ${characteristic.name}`}
          >
            {visibleOptions.map((option, index) => (
              <Label
                key={option === null ? 'missing' : `value:${option}`}
                className="flex cursor-pointer items-start gap-2 text-sm leading-5 font-normal"
              >
                <Checkbox
                  id={`${idPrefix}-${characteristic.id}-option-${index}`}
                  checked={draft.includes(option)}
                  onCheckedChange={(checked) =>
                    setDraft((current) =>
                      checked === true
                        ? [...current.filter((item) => item !== option), option]
                        : current.filter((item) => item !== option),
                    )
                  }
                  className="mt-0.5"
                />
                <span className="min-w-0 break-words">
                  {optionLabel(option)}
                </span>
              </Label>
            ))}
            {!visibleOptions.length && (
              <p role="status" className="py-3 text-xs text-muted-foreground">
                Значения не найдены
              </p>
            )}
          </fieldset>
          {search.trim() && (
            <p className="text-xs text-muted-foreground">
              «Выбрать все» и «Снять все» действуют на весь список.
            </p>
          )}
          <div className="flex justify-end gap-2 border-t pt-3">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Отмена
            </Button>
            <Button type="submit" size="sm">
              Применить
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
