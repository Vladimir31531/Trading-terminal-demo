import { type FormEvent, useEffect, useState } from 'react';
import type { TradingEngine } from '../application/trading-engine';
import type { TradeOrder } from '../domain/trading';
import { Button } from './ui/button';
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
  engine: TradingEngine;
  order?: TradeOrder;
  onOpenChange: (open: boolean) => void;
}

export function TradeEditDialog({ engine, order, onOpenChange }: Props) {
  const [price, setPrice] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [error, setError] = useState<string>();

  useEffect(() => {
    setPrice(order ? String(order.price) : '');
    setStopLoss(order?.stopLoss === undefined ? '' : String(order.stopLoss));
    setTakeProfit(
      order?.takeProfit === undefined ? '' : String(order.takeProfit),
    );
    setError(undefined);
  }, [order]);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!order) return;
    try {
      const priceValue = Number(price);
      const stop = stopLoss.trim() ? Number(stopLoss) : undefined;
      const target = takeProfit.trim() ? Number(takeProfit) : undefined;
      engine.editOrder(order.id, {
        price: priceValue,
        stopLoss: stop,
        takeProfit: target,
      });
      onOpenChange(false);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Не удалось изменить ордер.',
      );
    }
  }

  return (
    <Dialog open={Boolean(order)} onOpenChange={onOpenChange}>
      <DialogContent className="trade-edit-dialog">
        <DialogHeader>
          <DialogTitle>
            {order?.side.toUpperCase()}{' '}
            {order?.kind === 'limit' ? 'limit' : 'market'} #{order?.ticket}
          </DialogTitle>
          <DialogDescription>
            Настройте цену входа, стоп-лосс и тейк-профит.
          </DialogDescription>
        </DialogHeader>
        <form className="trade-edit-form" onSubmit={save}>
          <div className="form-field">
            <Label htmlFor="trade-entry-price">Цена</Label>
            <Input
              id="trade-entry-price"
              type="number"
              min="0"
              step="any"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              disabled={order?.status === 'open'}
              required
            />
          </div>
          <div className="form-field">
            <Label htmlFor="trade-stop-loss">Стоп-лосс</Label>
            <Input
              id="trade-stop-loss"
              type="number"
              min="0"
              step="any"
              value={stopLoss}
              onChange={(event) => setStopLoss(event.target.value)}
              placeholder="Не задан"
            />
          </div>
          <div className="form-field">
            <Label htmlFor="trade-take-profit">Тейк-профит</Label>
            <Input
              id="trade-take-profit"
              type="number"
              min="0"
              step="any"
              value={takeProfit}
              onChange={(event) => setTakeProfit(event.target.value)}
              placeholder="Не задан"
            />
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
            <Button type="submit">Сохранить</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
