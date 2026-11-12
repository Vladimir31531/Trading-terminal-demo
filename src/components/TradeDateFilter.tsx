import { CalendarDays } from 'lucide-react';
import { useState } from 'react';
import type { TradeDateRange } from '../domain/trade-filters';
import {
  DateTimePicker,
  type DateTimeValue,
  dateTimeTimestamp,
  dateTimeValue,
} from './DateTimePicker';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

interface Props {
  id: string;
  label: string;
  value?: TradeDateRange;
  onChange: (value: TradeDateRange | undefined) => void;
  minTime: number;
  maxTime: number;
}

export function TradeDateFilter({
  id,
  label,
  value,
  onChange,
  minTime,
  maxTime,
}: Props) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState<DateTimeValue>(() =>
    dateTimeValue(value?.from ?? minTime),
  );
  const [to, setTo] = useState<DateTimeValue>(() =>
    dateTimeValue(value?.to ?? maxTime),
  );
  const [useFrom, setUseFrom] = useState(true);
  const [useTo, setUseTo] = useState(true);
  const [error, setError] = useState<string>();
  const active = value?.from !== undefined || value?.to !== undefined;

  function changeOpen(next: boolean) {
    if (next) {
      setFrom(dateTimeValue(value?.from ?? minTime));
      setTo(dateTimeValue(value?.to ?? maxTime));
      setUseFrom(!active || value?.from !== undefined);
      setUseTo(!active || value?.to !== undefined);
      setError(undefined);
    }
    setOpen(next);
  }

  function apply() {
    const first = useFrom ? dateTimeTimestamp(from) : undefined;
    const last = useTo ? dateTimeTimestamp(to) : undefined;
    if (
      (first !== undefined && !Number.isFinite(first)) ||
      (last !== undefined && !Number.isFinite(last))
    ) {
      setError('Укажите корректные дату и время.');
      return;
    }
    if (first !== undefined && last !== undefined && first > last) {
      setError('Начало периода должно быть не позже окончания.');
      return;
    }
    onChange(
      first === undefined && last === undefined
        ? undefined
        : { from: first, to: last },
    );
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={active ? 'secondary' : 'outline'}
          size="xs"
          aria-label={`Фильтр: ${label}`}
          title={
            active ? 'Изменить выбранный период UTC' : 'Выбрать период UTC'
          }
          className="font-normal"
        >
          <CalendarDays className="size-3" />{' '}
          {active ? 'Период выбран' : 'Все даты'}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="grid w-[400px] max-w-[calc(100vw-2rem)] gap-4 bg-white"
      >
        <div className="grid gap-1">
          <strong className="text-sm">{label}</strong>
          <p className="text-xs text-muted-foreground">
            Период по UTC, включая указанные границы.
          </p>
        </div>
        <div className="grid gap-2">
          <Label className="flex items-center gap-2">
            <Checkbox
              checked={useFrom}
              onCheckedChange={(checked) => setUseFrom(checked === true)}
            />{' '}
            Ограничить начало
          </Label>
          <DateTimePicker
            id={`${id}-from`}
            label="С"
            value={from}
            onChange={setFrom}
            minTime={minTime}
            maxTime={maxTime}
            disabled={!useFrom}
          />
        </div>
        <div className="grid gap-2">
          <Label className="flex items-center gap-2">
            <Checkbox
              checked={useTo}
              onCheckedChange={(checked) => setUseTo(checked === true)}
            />{' '}
            Ограничить окончание
          </Label>
          <DateTimePicker
            id={`${id}-to`}
            label="По"
            value={to}
            onChange={setTo}
            minTime={minTime}
            maxTime={maxTime}
            disabled={!useTo}
          />
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              onChange(undefined);
              setOpen(false);
            }}
          >
            Сбросить период
          </Button>
          <Button type="button" size="sm" onClick={apply}>
            Применить
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
