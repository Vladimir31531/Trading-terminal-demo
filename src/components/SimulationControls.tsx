import { LoaderCircle, Pause, Play, Save, Square } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { SimulationEngine } from '../application/simulation-engine';
import { validateSimulationSpeed } from '../domain/simulation';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

const utcTime = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'UTC',
  dateStyle: 'short',
  timeStyle: 'medium',
  hour12: false,
});

interface Props {
  engine: SimulationEngine;
  onStop: () => void;
  onSuspend: () => void;
  busy?: boolean;
}

export function SimulationControls({
  engine,
  onStop,
  onSuspend,
  busy = false,
}: Props) {
  const subscribe = useCallback(
    (listener: () => void) => engine.subscribe(listener),
    [engine],
  );
  const getSnapshot = useCallback(() => engine.getSnapshot(), [engine]);
  const state = useSyncExternalStore(subscribe, getSnapshot);
  const [speed, setSpeed] = useState(String(state.speed));
  const [speedError, setSpeedError] = useState<string>();
  const originalSpeed = useRef<number | undefined>(undefined);
  const restoreSpeed = useCallback(() => {
    const previous = originalSpeed.current;
    if (previous === undefined) return;
    originalSpeed.current = undefined;
    engine.setSpeed(previous);
  }, [engine]);

  useEffect(() => {
    setSpeed(String(state.speed));
    setSpeedError(undefined);
  }, [state.speed]);

  useEffect(() => {
    if (busy) return;
    const editing = (target: EventTarget | null) =>
      target instanceof Element &&
      target.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="alertdialog"]',
      );
    const down = (event: KeyboardEvent) => {
      const { status } = engine.getSnapshot();
      if (
        event.key !== 'ArrowRight' ||
        event.defaultPrevented ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.shiftKey ||
        editing(event.target) ||
        status === 'finished' ||
        status === 'error'
      )
        return;
      if (originalSpeed.current === undefined) {
        if (event.repeat) return;
        originalSpeed.current = engine.getSnapshot().speed;
        engine.setSpeed(10_000);
      }
      event.preventDefault();
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') restoreSpeed();
    };
    const visibility = () => {
      if (document.hidden) restoreSpeed();
    };
    const focus = (event: FocusEvent) => {
      if (editing(event.target)) restoreSpeed();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', restoreSpeed);
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('focusin', focus);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', restoreSpeed);
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('focusin', focus);
      restoreSpeed();
    };
  }, [engine, busy, restoreSpeed]);

  function changeSpeed(value: string) {
    restoreSpeed();
    setSpeed(value);
    try {
      const next = value.trim() ? Number(value) : Number.NaN;
      validateSimulationSpeed(next);
      engine.setSpeed(next);
      setSpeedError(undefined);
    } catch (cause) {
      setSpeedError(
        cause instanceof Error
          ? cause.message
          : 'Укажите скорость больше нуля.',
      );
    }
  }

  const unavailable = state.status === 'finished' || state.status === 'error';
  const playing = state.status === 'playing' || state.status === 'loading';

  return (
    <div className="simulation-controls flex min-w-0 flex-wrap items-center gap-2">
      <Button
        type="button"
        size="icon-sm"
        variant="outline"
        className="simulation-stop"
        title="Остановить симуляцию"
        aria-label="Остановить симуляцию"
        disabled={busy}
        onClick={() => {
          restoreSpeed();
          onStop();
        }}
      >
        <Square className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="outline"
        className="simulation-suspend"
        title={busy ? 'Сохраняем…' : 'Сохранить и выйти'}
        aria-label={busy ? 'Сохраняем…' : 'Сохранить и выйти'}
        disabled={unavailable || busy}
        onClick={() => {
          restoreSpeed();
          onSuspend();
        }}
      >
        {busy ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : (
          <Save className="size-3.5" />
        )}
      </Button>
      <fieldset
        className="m-0 flex min-w-0 items-center gap-1.5 border-0 p-0"
        aria-label="Управление симуляцией"
      >
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          className="simulation-play"
          disabled={unavailable || busy}
          title={playing ? 'Приостановить симуляцию' : 'Продолжить симуляцию'}
          aria-label={
            playing ? 'Приостановить симуляцию' : 'Продолжить симуляцию'
          }
          onClick={() => (playing ? engine.pause() : engine.play())}
        >
          {state.status === 'loading' ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : playing ? (
            <Pause className="size-3.5" />
          ) : (
            <Play className="size-3.5" />
          )}
        </Button>
        <Label className="simulation-speed-label flex items-center gap-1.5">
          <span className="sr-only">Скорость симуляции</span>
          <Input
            className="simulation-speed h-8 w-24 px-2 text-xs tabular-nums"
            type="number"
            min="0"
            step="any"
            value={speed}
            aria-label="Скорость симуляции"
            title="Удерживайте → вне полей ввода для ускорения до 10000×"
            aria-invalid={Boolean(speedError)}
            aria-describedby={speedError ? 'simulation-speed-error' : undefined}
            disabled={unavailable || busy}
            onChange={(event) => changeSpeed(event.target.value)}
            onBlur={() => {
              if (speedError) {
                setSpeed(String(state.speed));
                setSpeedError(undefined);
              }
            }}
          />
          <span className="text-xs text-muted-foreground">×</span>
        </Label>
      </fieldset>
      <time
        className="simulation-time text-[10px] whitespace-nowrap text-muted-foreground tabular-nums"
        dateTime={new Date(state.time * 1000).toISOString()}
      >
        {utcTime.format(state.time * 1000)} UTC
      </time>
      {state.status !== 'playing' && state.status !== 'error' && (
        <span
          className="simulation-status text-[10px] text-muted-foreground"
          role="status"
        >
          {state.status === 'loading'
            ? 'Подготовка…'
            : state.status === 'finished'
              ? 'Завершена'
              : 'Пауза'}
        </span>
      )}
      {(state.error || speedError) && (
        <span
          id={speedError ? 'simulation-speed-error' : undefined}
          className="simulation-control-error basis-full text-xs text-destructive"
          role="alert"
        >
          {state.error ?? speedError}
        </span>
      )}
    </div>
  );
}
