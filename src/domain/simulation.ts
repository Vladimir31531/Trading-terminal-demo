import { candleStart } from './aggregation';
import type { Candle, Instrument, Timeframe } from './market';

export interface SimulationSettings {
  startTime: number;
  endTime: number;
  speed: number;
}

export type SimulationStatus =
  | 'loading'
  | 'playing'
  | 'paused'
  | 'finished'
  | 'error';

export interface SimulationSnapshot {
  status: SimulationStatus;
  time: number;
  speed: number;
  error?: string;
}

export function validateSimulationSpeed(speed: number): void {
  if (!Number.isFinite(speed) || speed <= 0)
    throw new Error('Скорость симуляции должна быть числом больше нуля.');
}

export function validateSimulationSettings(
  settings: SimulationSettings,
  instrument: Pick<Instrument, 'firstTime' | 'lastTime'>,
): void {
  if (
    !Number.isFinite(settings.startTime) ||
    !Number.isFinite(settings.endTime)
  )
    throw new Error(
      'Укажите корректные дату и время начала и конца симуляции.',
    );
  if (settings.endTime <= settings.startTime)
    throw new Error('Конец симуляции должен быть позже её начала.');
  if (
    settings.startTime < instrument.firstTime ||
    settings.endTime > instrument.lastTime
  )
    throw new Error('Период симуляции должен находиться в доступной истории.');
  validateSimulationSpeed(settings.speed);
}

/** Only seconds already delivered by replay may contribute to the active bar. */
export function aggregateReplayCandle(
  current: Candle | undefined,
  second: Candle,
  timeframe: Timeframe,
): Candle {
  const time = candleStart(second.time, timeframe);
  if (!current || current.time !== time) return { ...second, time };
  return {
    time,
    open: current.open,
    high: Math.max(current.high, second.high),
    low: Math.min(current.low, second.low),
    close: second.close,
  };
}
