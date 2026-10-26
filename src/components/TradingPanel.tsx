import { X } from 'lucide-react';
import { useCallback, useState, useSyncExternalStore } from 'react';
import type { TradingEngine } from '../application/trading-engine';
import type { TradeOrder } from '../domain/trading';
import { Button } from './ui/button';

const numberFormat = new Intl.NumberFormat('ru-RU', {
  maximumFractionDigits: 8,
});
const moneyFormat = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const balanceFormat = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'USD',
});
const timeFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'UTC',
  dateStyle: 'short',
  timeStyle: 'medium',
});
interface Props {
  engine: TradingEngine;
  onEdit: (order: TradeOrder) => void;
}

export function TradingPanel({ engine, onEdit }: Props) {
  const subscribe = useCallback(
    (listener: () => void) => engine.subscribe(listener),
    [engine],
  );
  const getSnapshot = useCallback(() => engine.getSnapshot(), [engine]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [actionError, setActionError] = useState<string>();

  function close(order: TradeOrder) {
    try {
      engine.closeOrder(order.id);
      setActionError(undefined);
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : 'Не удалось закрыть сделку.',
      );
    }
  }

  return (
    <section className="trading-panel" aria-label="Ордеры и сделки">
      <div className="trading-panel-heading">
        <strong>Ордеры и сделки</strong>
        <span>{state.orders.length} активных</span>
        <span className="trading-account-balance" aria-live="polite">
          Баланс: <strong>{balanceFormat.format(state.balance)}</strong>
        </span>
      </div>
      {(state.error || actionError) && (
        <p className="trading-panel-error" role="alert">
          {state.error ?? actionError}
        </p>
      )}
      <div className="trading-table-scroll">
        <table className="trading-table">
          <thead>
            <tr>
              <th>Символ / тикет</th>
              <th>Время</th>
              <th>Тип</th>
              <th>Объём</th>
              <th>Цена</th>
              <th>S / L</th>
              <th>T / P</th>
              <th>Текущая</th>
              <th>Прибыль</th>
              <th aria-label="Закрыть" />
            </tr>
          </thead>
          <tbody>
            {state.orders.map((order) => (
              <tr
                key={order.id}
                onDoubleClick={(event) => {
                  if (
                    event.target instanceof Element &&
                    event.target.closest('button')
                  )
                    return;
                  onEdit(order);
                }}
              >
                <td>
                  <strong>{order.ticker}</strong>
                  <small>#{order.ticket}</small>
                </td>
                <td>
                  {timeFormat.format((order.openedAt ?? order.placedAt) * 1000)}{' '}
                  UTC
                </td>
                <td>
                  <span
                    className={
                      order.side === 'buy'
                        ? 'trade-side-buy'
                        : 'trade-side-sell'
                    }
                  >
                    {order.side.toUpperCase()}{' '}
                    {order.kind === 'limit' ? 'limit' : 'market'}
                  </span>
                  {order.status === 'pending' && <small>ожидает</small>}
                </td>
                <td>{numberFormat.format(order.volume)}</td>
                <td>{numberFormat.format(order.price)}</td>
                <td>
                  {order.stopLoss === undefined
                    ? '—'
                    : numberFormat.format(order.stopLoss)}
                </td>
                <td>
                  {order.takeProfit === undefined
                    ? '—'
                    : numberFormat.format(order.takeProfit)}
                </td>
                <td>{numberFormat.format(order.currentPrice)}</td>
                <td
                  className={
                    order.profit >= 0
                      ? 'trade-profit-positive'
                      : 'trade-profit-negative'
                  }
                >
                  {order.status === 'pending'
                    ? '—'
                    : moneyFormat.format(order.profit)}
                </td>
                <td>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="trade-close"
                    aria-label={
                      order.status === 'pending'
                        ? 'Отменить ордер'
                        : 'Закрыть сделку'
                    }
                    title={
                      order.status === 'pending'
                        ? 'Отменить ордер'
                        : 'Закрыть сделку'
                    }
                    onClick={() => close(order)}
                  >
                    <X size={13} />
                  </Button>
                </td>
              </tr>
            ))}
            {state.orders.length === 0 && (
              <tr>
                <td colSpan={10} className="trading-empty-row">
                  Нет активных ордеров и сделок
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
