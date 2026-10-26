import { useCallback, useState, useSyncExternalStore } from 'react';
import type { TradingEngine } from '../application/trading-engine';
import type { TradeSide } from '../domain/trading';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

interface Props {
  engine: TradingEngine;
  volume: string;
  onVolumeChange: (value: string) => void;
  pointValue: string;
  onPointValueChange: (value: string) => void;
}

export function TradingControls({
  engine,
  volume,
  onVolumeChange,
  pointValue,
  onPointValueChange,
}: Props) {
  const [error, setError] = useState<string>();
  const subscribe = useCallback(
    (listener: () => void) => engine.subscribe(listener),
    [engine],
  );
  const getSnapshot = useCallback(() => engine.getSnapshot(), [engine]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  function open(side: TradeSide) {
    try {
      const parsedPointValue = Number(pointValue);
      if (!Number.isFinite(parsedPointValue) || parsedPointValue <= 0)
        throw new Error('Укажите цену пункта больше нуля.');
      engine.setPointValuePer001(parsedPointValue);
      engine.openMarket(side, Number(volume));
      setError(undefined);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Не удалось открыть сделку.',
      );
    }
  }

  function updatePointValue(value: string) {
    try {
      const parsed = Number(value);
      if (value.trim() && Number.isFinite(parsed) && parsed > 0)
        engine.setPointValuePer001(parsed);
      onPointValueChange(value);
      setError(undefined);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Некорректная цена пункта.',
      );
    }
  }

  return (
    <fieldset className="trading-controls" aria-label="Торговля">
      <div className="trade-control-field">
        <Label htmlFor="trade-volume">Лот</Label>
        <Input
          id="trade-volume"
          type="number"
          min="0"
          step="0.01"
          value={volume}
          aria-label="Объём сделки в лотах"
          onChange={(event) => onVolumeChange(event.target.value)}
          disabled={snapshot.finished}
        />
      </div>
      <Button
        className="trade-buy"
        size="sm"
        disabled={snapshot.finished}
        onClick={() => open('buy')}
      >
        BUY
      </Button>
      <Button
        className="trade-sell"
        size="sm"
        disabled={snapshot.finished}
        onClick={() => open('sell')}
      >
        SELL
      </Button>
      <div className="trade-control-field trade-point-value">
        <Label htmlFor="trade-point-value">Цена 1 пункта для 0,01 лота</Label>
        <Input
          id="trade-point-value"
          type="number"
          min="0"
          step="any"
          value={pointValue}
          aria-label="Цена 1 пункта для 0,01 лота"
          onChange={(event) => updatePointValue(event.target.value)}
          disabled={snapshot.finished}
        />
      </div>
      {error && (
        <span className="trade-control-error" role="alert">
          {error}
        </span>
      )}
    </fieldset>
  );
}
