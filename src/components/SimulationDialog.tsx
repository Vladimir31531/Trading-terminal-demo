import { Play } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import type { Instrument } from '../domain/market';
import {
  type SimulationSettings,
  validateSimulationSettings,
} from '../domain/simulation';
import {
  DateTimePicker,
  dateTimeTimestamp,
  dateTimeValue,
} from './DateTimePicker';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';

interface Props {
  open: boolean;
  instrument: Instrument;
  onOpenChange: (open: boolean) => void;
  onStart: (settings: SimulationSettings) => void;
}

export function SimulationDialog({
  open,
  instrument,
  onOpenChange,
  onStart,
}: Props) {
  const [start, setStart] = useState(() => dateTimeValue(instrument.firstTime));
  const [end, setEnd] = useState(() => dateTimeValue(instrument.lastTime));
  const [toEnd, setToEnd] = useState(true);
  const [speed, setSpeed] = useState('1');
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setStart(dateTimeValue(instrument.firstTime));
    setEnd(dateTimeValue(instrument.lastTime));
    setToEnd(true);
    setSpeed('1');
    setError(undefined);
  }, [open, instrument.firstTime, instrument.lastTime]);

  function startSimulation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    const settings: SimulationSettings = {
      startTime: dateTimeTimestamp(start),
      endTime: toEnd ? instrument.lastTime : dateTimeTimestamp(end),
      speed: Number(speed),
    };
    try {
      validateSimulationSettings(settings, instrument);
      onStart(settings);
      onOpenChange(false);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Не удалось начать симуляцию.',
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="simulation-dialog max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <div className="dialog-symbol">
            <Play size={20} strokeWidth={1.5} />
          </div>
          <DialogTitle>Начать симуляцию</DialogTitle>
          <DialogDescription>
            {instrument.ticker} · выберите период и скорость воспроизведения.
            Дата и время указаны по UTC.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={startSimulation} className="simulation-form grid gap-5">
          <DateTimePicker
            id="simulation-start"
            label="Начало симуляции"
            value={start}
            onChange={setStart}
            minTime={instrument.firstTime}
            maxTime={instrument.lastTime}
          />
          <div className="simulation-period grid gap-3">
            <DateTimePicker
              id="simulation-end"
              label="Конец симуляции"
              value={end}
              onChange={setEnd}
              minTime={instrument.firstTime}
              maxTime={instrument.lastTime}
              disabled={toEnd}
            />
            <div className="simulation-checkbox-row flex items-center gap-2">
              <Checkbox
                id="simulation-to-end"
                checked={toEnd}
                onCheckedChange={(checked) => setToEnd(checked === true)}
              />
              <Label
                htmlFor="simulation-to-end"
                className="text-xs font-normal"
              >
                до конца доступного графика
              </Label>
            </div>
          </div>
          <div className="form-field">
            <Label htmlFor="simulation-start-speed">Скорость времени</Label>
            <div className="flex items-center gap-3">
              <Input
                id="simulation-start-speed"
                className="max-w-28 tabular-nums"
                type="number"
                min="0"
                step="any"
                value={speed}
                onChange={(event) => setSpeed(event.target.value)}
                required
              />
              <span className="text-xs text-muted-foreground">
                × реального времени
              </span>
            </div>
            <p className="simulation-help mt-1 text-xs text-muted-foreground">
              Например, 2 — вдвое быстрее, 10 — в десять раз быстрее.
            </p>
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <DialogFooter className="dialog-actions">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Отмена
            </Button>
            <Button type="submit">
              <Play size={15} /> Начать
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
