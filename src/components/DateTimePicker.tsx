import { CalendarDays, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { TZDate } from 'react-day-picker';
import { ru } from 'react-day-picker/locale';
import { Button } from './ui/button';
import { Calendar } from './ui/calendar';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

export interface DateTimeValue {
  date: Date | undefined;
  time: string;
}

export function dateTimeValue(timestamp: number): DateTimeValue {
  const date = new TZDate(timestamp * 1000, 'UTC');
  return { date, time: date.toISOString().slice(11, 19) };
}

export function dateTimeTimestamp({ date, time }: DateTimeValue): number {
  if (!date || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time))
    return Number.NaN;
  const [hours, minutes, seconds = 0] = time.split(':').map(Number);
  return (
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      hours,
      minutes,
      seconds,
    ) / 1000
  );
}

const dayFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'UTC',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

interface Props {
  id: string;
  label: string;
  value: DateTimeValue;
  onChange: (value: DateTimeValue) => void;
  minTime: number;
  maxTime: number;
  disabled?: boolean;
}

/** shadcn Calendar date picker with a separate seconds-precision UTC time input. */
export function DateTimePicker({
  id,
  label,
  value,
  onChange,
  minTime,
  maxTime,
  disabled = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const firstDay = new TZDate(minTime * 1000, 'UTC');
  firstDay.setUTCHours(0, 0, 0, 0);
  const lastDay = new TZDate(maxTime * 1000, 'UTC');
  lastDay.setUTCHours(0, 0, 0, 0);

  return (
    <div className="form-field">
      <Label htmlFor={`${id}-date`}>{label}</Label>
      <div className="simulation-datetime-row flex items-center gap-2">
        <Popover open={open && !disabled} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              id={`${id}-date`}
              variant="outline"
              className="simulation-date-trigger h-9 min-w-0 flex-1 justify-between px-3 font-normal"
              disabled={disabled}
              aria-label={`${label}: дата UTC`}
            >
              <CalendarDays className="size-4 text-muted-foreground" />
              {value.date ? dayFormat.format(value.date) : 'Выберите дату'}
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto overflow-hidden p-0" align="start">
            <Calendar
              mode="single"
              required
              selected={value.date}
              defaultMonth={value.date ?? firstDay}
              onSelect={(date) => {
                onChange({ ...value, date });
                setOpen(false);
              }}
              captionLayout="dropdown"
              locale={ru}
              timeZone="UTC"
              startMonth={firstDay}
              endMonth={lastDay}
              disabled={{ before: firstDay, after: lastDay }}
              autoFocus
            />
          </PopoverContent>
        </Popover>
        <Input
          id={`${id}-time`}
          className="simulation-time-input w-[132px] shrink-0 tabular-nums"
          type="time"
          step="1"
          value={value.time}
          onChange={(event) => onChange({ ...value, time: event.target.value })}
          disabled={disabled}
          required={!disabled}
          aria-label={`${label}: время UTC`}
        />
      </div>
    </div>
  );
}
